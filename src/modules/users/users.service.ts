import { AppError } from '../../lib/errors.js';
import { ROLES, type Actor, type Role } from '../../lib/actor.js';
import {
  UsersRepo, toPublicUser, type PublicUser, type UserRow,
} from './users.repo.js';
import {
  PASSWORD_RULES, checkPasswordStrength, generatePassword, hashPassword, verifyPassword,
} from './password.js';

export interface UsersConfig {
  /** Days before a password must be changed. 0 disables expiry. */
  maxAgeDays: number;
  /** How many previous passwords may not be reused. */
  historyDepth: number;
  maxFailedAttempts: number;
  lockMinutes: number;
  /** Break-glass admin from SUPERADMIN_EMAIL; signs in with the dashboard key. */
  superAdminEmail?: string | null;
}

export interface SignInResult {
  user: PublicUser;
  /** True when the password is expired or admin-issued: the UI must force a change. */
  must_change_password: boolean;
  reason: 'admin_issued' | 'expired' | null;
}

export class UsersService {
  constructor(private readonly repo: UsersRepo, private readonly config: UsersConfig) {}

  get passwordRules(): readonly string[] { return PASSWORD_RULES; }

  get superAdminEmail(): string | null { return this.config.superAdminEmail?.trim().toLowerCase() || null; }

  /** Is this the break-glass admin signing in with the dashboard key? */
  isSuperAdmin(email: string): boolean {
    const configured = this.superAdminEmail;
    return configured !== null && email.trim().toLowerCase() === configured;
  }

  /**
   * True while no enabled admin exists: the sign-in page then offers to create the first one.
   *
   * Keyed on admins, not on accounts. Adding a QC or a developer first must not close the
   * door behind itself and leave nobody able to manage people.
   */
  async needsBootstrap(): Promise<boolean> {
    return (await this.repo.countAdmins()) === 0;
  }

  /** Whether an enabled admin exists — what decides if the shared key still works. */
  async anyAdminExists(): Promise<boolean> {
    return (await this.repo.countAdmins()) > 0;
  }

  /** Recorded so a break-glass sign-in is visible in the account log rather than silent. */
  async logSuperAdminSignIn(email: string): Promise<void> {
    await this.repo.logEvent({ actor: email, target: email, action: 'superadmin_sign_in', detail: 'signed in with the dashboard key' });
  }

  async hasAccount(email: string): Promise<boolean> {
    return (await this.repo.byEmail(email)) !== undefined;
  }

  async list(): Promise<PublicUser[]> {
    return (await this.repo.list()).map((u) => toPublicUser(u, this.config.maxAgeDays));
  }

  async events(limit?: number) {
    return (await this.repo.events(limit)).map((e) => ({ ...e, created_at: e.created_at.toISOString() }));
  }

  private expired(user: UserRow): boolean {
    if (this.config.maxAgeDays <= 0) return false;
    return Date.now() - new Date(user.password_set_at).getTime() >= this.config.maxAgeDays * 86_400_000;
  }

  /**
   * Checks an email and password.
   *
   * Deliberately returns the same error for "no such account" and "wrong password" so the
   * page cannot be used to find out who has an account. A locked account says so, because
   * the person locked out needs to know why waiting will help.
   */
  async signIn(email: string, password: string): Promise<SignInResult> {
    const user = await this.repo.byEmail(email);
    const fail = () => AppError.unauthorized('That email and password did not match');

    if (!user) {
      // Spend comparable time on an unknown email so the response time says nothing.
      await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      throw fail();
    }
    if (user.is_disabled) throw AppError.forbidden('That account has been disabled. Ask an admin to re-enable it.');
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const mins = Math.max(1, Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000));
      throw new AppError(429, 'FORBIDDEN', `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }

    if (!(await verifyPassword(password, user.password_hash))) {
      await this.repo.recordFailure(user.id, this.config.maxFailedAttempts, this.config.lockMinutes);
      throw fail();
    }

    await this.repo.recordLogin(user.id);
    await this.repo.logEvent({ actor: user.email, target: user.email, action: 'sign_in' });
    const fresh = (await this.repo.byId(user.id))!;
    const expired = this.expired(fresh);
    return {
      user: toPublicUser(fresh, this.config.maxAgeDays),
      must_change_password: fresh.must_change || expired,
      reason: fresh.must_change ? 'admin_issued' : expired ? 'expired' : null,
    };
  }

  /** The actor a signed-in session carries, rebuilt from the database on every request. */
  async actorFor(userId: string): Promise<Actor | null> {
    const user = await this.repo.byId(userId);
    if (!user || user.is_disabled) return null;
    return { id: user.id, email: user.email, name: user.name, role: user.role, via: 'session' };
  }

  /** Whether this user still has to rotate before they can do anything else. */
  async passwordState(userId: string): Promise<{ must_change: boolean; reason: 'admin_issued' | 'expired' | null; age_days: number }> {
    const user = await this.repo.byId(userId);
    if (!user) return { must_change: false, reason: null, age_days: 0 };
    const expired = this.expired(user);
    return {
      must_change: user.must_change || expired,
      reason: user.must_change ? 'admin_issued' : expired ? 'expired' : null,
      age_days: Math.floor((Date.now() - new Date(user.password_set_at).getTime()) / 86_400_000),
    };
  }

  // -------------------------------------------------------------------------

  private async assertUsable(user: UserRow, password: string): Promise<void> {
    const problems = checkPasswordStrength(password, { email: user.email, name: user.name });
    if (problems.length) throw AppError.validation(problems, 'That password does not meet the rules');

    // Same as the current one, or one of the recent ones.
    if (await verifyPassword(password, user.password_hash)) {
      throw AppError.validation([{ path: 'password', message: 'must be different from your current password' }], 'That password does not meet the rules');
    }
    for (const old of await this.repo.recentHashes(user.id, this.config.historyDepth)) {
      if (await verifyPassword(password, old)) {
        throw AppError.validation(
          [{ path: 'password', message: `must be different from your last ${this.config.historyDepth} passwords` }],
          'That password does not meet the rules',
        );
      }
    }
  }

  /** A user changing their own password. The current one must be supplied. */
  async changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<PublicUser> {
    const user = await this.repo.byId(userId);
    if (!user) throw AppError.notFound('Account not found');
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw AppError.validation([{ path: 'current_password', message: 'that is not your current password' }], 'Current password is wrong');
    }
    await this.assertUsable(user, newPassword);
    const updated = await this.repo.setPassword(user.id, await hashPassword(newPassword), false);
    await this.repo.logEvent({ actor: user.email, target: user.email, action: 'password_changed' });
    return toPublicUser(updated!, this.config.maxAgeDays);
  }

  async create(input: { email: string; name?: string | null; role: Role; password?: string }, by: Actor): Promise<{ user: PublicUser; generated_password: string | null }> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw AppError.validation([{ path: 'email', message: 'must be a valid email address' }]);
    if (!ROLES.includes(input.role)) throw AppError.validation([{ path: 'role', message: `must be one of: ${ROLES.join(', ')}` }]);
    if (await this.repo.byEmail(email)) throw AppError.validation([{ path: 'email', message: 'an account with that email already exists' }], 'Duplicate account');

    // An admin-set password still has to be a decent one; a generated one always is.
    const generated = input.password ? null : generatePassword();
    const password = input.password ?? generated!;
    const problems = checkPasswordStrength(password, { email, name: input.name ?? null });
    if (problems.length) throw AppError.validation(problems, 'That password does not meet the rules');

    const user = await this.repo.create({
      email, name: input.name?.trim() || null, role: input.role,
      passwordHash: await hashPassword(password),
      mustChange: true,
      createdBy: by.email ?? by.via,
    });
    await this.repo.logEvent({ actor: by.email ?? by.via, target: email, action: 'user_created', detail: `role=${input.role}` });
    return { user: toPublicUser(user, this.config.maxAgeDays), generated_password: generated };
  }

  /** The very first admin, created from the sign-in page while no account exists. */
  async bootstrapFirstAdmin(input: { email: string; name?: string | null; password: string }): Promise<PublicUser> {
    if (!(await this.needsBootstrap())) throw AppError.forbidden('Accounts already exist; ask an admin to add you.');
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw AppError.validation([{ path: 'email', message: 'must be a valid email address' }]);
    const problems = checkPasswordStrength(input.password, { email, name: input.name ?? null });
    if (problems.length) throw AppError.validation(problems, 'That password does not meet the rules');

    const user = await this.repo.create({
      email, name: input.name?.trim() || null, role: 'admin',
      passwordHash: await hashPassword(input.password),
      // They chose it themselves, so there is nothing to rotate yet.
      mustChange: false,
      createdBy: 'bootstrap',
    });
    await this.repo.logEvent({ actor: email, target: email, action: 'bootstrap_admin' });
    return toPublicUser(user, this.config.maxAgeDays);
  }

  async update(id: string, patch: { name?: string | null; role?: Role; is_disabled?: boolean }, by: Actor): Promise<PublicUser> {
    const user = await this.repo.byId(id);
    if (!user) throw AppError.notFound('Account not found');

    // The last enabled admin must stay an enabled admin, or nobody can manage anything.
    const losingAdmin = (patch.role !== undefined && patch.role !== 'admin') || patch.is_disabled === true;
    if (user.role === 'admin' && losingAdmin && (await this.repo.countAdmins(user.id)) === 0) {
      throw AppError.validation([{ path: 'role', message: 'this is the last admin; promote someone else first' }], 'Cannot remove the last admin');
    }

    const updated = await this.repo.update(id, patch);
    const changes = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ');
    await this.repo.logEvent({ actor: by.email ?? by.via, target: user.email, action: 'user_updated', detail: changes });
    return toPublicUser(updated!, this.config.maxAgeDays);
  }

  /** An admin issuing a new password for someone. Returned once, in the response, and never stored in the clear. */
  async resetPassword(id: string, by: Actor, explicit?: string): Promise<{ user: PublicUser; password: string }> {
    const user = await this.repo.byId(id);
    if (!user) throw AppError.notFound('Account not found');
    const password = explicit ?? generatePassword();
    const problems = checkPasswordStrength(password, { email: user.email, name: user.name });
    if (problems.length) throw AppError.validation(problems, 'That password does not meet the rules');

    const updated = await this.repo.setPassword(user.id, await hashPassword(password), true);
    await this.repo.logEvent({ actor: by.email ?? by.via, target: user.email, action: 'password_reset' });
    return { user: toPublicUser(updated!, this.config.maxAgeDays), password };
  }

  async remove(id: string, by: Actor): Promise<void> {
    const user = await this.repo.byId(id);
    if (!user) throw AppError.notFound('Account not found');
    if (by.id === id) throw AppError.validation([{ path: 'id', message: 'you cannot delete your own account' }]);
    if (user.role === 'admin' && (await this.repo.countAdmins(user.id)) === 0) {
      throw AppError.validation([{ path: 'id', message: 'this is the last admin; promote someone else first' }], 'Cannot remove the last admin');
    }
    await this.repo.delete(id);
    await this.repo.logEvent({ actor: by.email ?? by.via, target: user.email, action: 'user_deleted' });
  }
}
