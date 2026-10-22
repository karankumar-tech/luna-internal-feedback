const EMAIL = /^([^\s@]+)@([^\s@]+)\.([^\s@.]+)$/;

/**
 * A customer's email as we keep it: enough to recognise, never enough to write to.
 * "rahul.sharma@gmail.com" → "ra***@g***.com". The length of each part is not kept either.
 * Anything that is not an email address gives null, so nothing of it is stored.
 */
export function maskEmail(raw: string | null | undefined): string | null {
  const m = EMAIL.exec((raw ?? '').trim().toLowerCase());
  if (!m) return null;
  const [, local, domain, tld] = m as unknown as [string, string, string, string];
  const head = local.length >= 4 ? local.slice(0, 2) : local.slice(0, 1);
  return `${head}***@${domain.slice(0, 1)}***.${tld.slice(0, 10)}`;
}
