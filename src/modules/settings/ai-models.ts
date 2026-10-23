import type { FastifyBaseLogger } from 'fastify';
import { AppError, type ErrorIssue } from '../../lib/errors.js';
import type { ModelInfo, OpenRouterCatalog } from '../diagnosis/ai/models.js';
import type { SettingsRepo } from './settings.repo.js';

const KEY = 'ai_models';

/** What Settings stored. A model left out (null) falls back to the environment's default. */
interface Stored {
  diagnosis: { id: string; images: boolean } | null;
  chat: { id: string } | null;
}

/** The model a diagnosis (and the issue matcher) calls, and whether it can be sent screenshots. */
export interface DiagnosisModel { id: string; images: boolean }

export interface AiModelsState {
  /** False without OPEN_ROUTER_KEY: nothing calls a model, whatever is chosen. */
  enabled: boolean;
  diagnosis: DiagnosisModel & { set: boolean };
  chat: { id: string; set: boolean };
  /** From the environment. A null chat default means the chat follows the diagnosis model. */
  defaults: { diagnosis: string; chat: string | null };
  updated_by: string | null;
  updated_at: string | null;
  /** Average tokens of the last 30 days' diagnoses, to estimate what a model would cost. */
  recent: { runs: number; input_tokens: number; output_tokens: number } | null;
}

export interface AiModelsDeps {
  settings: SettingsRepo;
  catalog: OpenRouterCatalog;
  defaults: { diagnosis: string; chat: string | null };
  enabled: boolean;
  recentTokens: () => Promise<{ runs: number; input_tokens: number; output_tokens: number } | null>;
  log: FastifyBaseLogger;
}

/**
 * Which OpenRouter models the AI uses. OPENROUTER_MODEL and DIAGNOSIS_CHAT_MODEL are the defaults;
 * an admin can pick others in Settings, and every model call asks here first.
 */
export class AiModels {
  constructor(private readonly d: AiModelsDeps) {}

  private async stored(): Promise<{ value: Stored; updated_by: string | null; updated_at: string | null }> {
    try {
      const row = await this.d.settings.get<Partial<Stored>>(KEY);
      return { value: { diagnosis: row?.value.diagnosis ?? null, chat: row?.value.chat ?? null }, updated_by: row?.updated_by ?? null, updated_at: row?.updated_at ?? null };
    } catch (err) {
      // A model call should not fail because the settings could not be read: use the defaults.
      this.d.log.error({ err }, 'AI model settings unreadable; using the defaults');
      return { value: { diagnosis: null, chat: null }, updated_by: null, updated_at: null };
    }
  }

  private resolve(s: Stored): { diagnosis: DiagnosisModel; chat: string } {
    // The default is assumed to read images: screenshots have always gone with it.
    const diagnosis = s.diagnosis ?? { id: this.d.defaults.diagnosis, images: true };
    return { diagnosis, chat: s.chat?.id ?? this.d.defaults.chat ?? diagnosis.id };
  }

  async diagnosis(): Promise<DiagnosisModel> {
    return this.resolve((await this.stored()).value).diagnosis;
  }

  async chat(): Promise<string> {
    return this.resolve((await this.stored()).value).chat;
  }

  async state(): Promise<AiModelsState> {
    const [s, recent] = await Promise.all([this.stored(), this.d.recentTokens().catch(() => null)]);
    const r = this.resolve(s.value);
    return {
      enabled: this.d.enabled,
      diagnosis: { ...r.diagnosis, set: s.value.diagnosis !== null },
      chat: { id: r.chat, set: s.value.chat !== null },
      defaults: this.d.defaults,
      updated_by: s.updated_by,
      updated_at: s.updated_at,
      recent,
    };
  }

  /**
   * Picks models. A field left out stays as it is; null goes back to the default. Every model named
   * must be on OpenRouter's list, and the diagnosis model must answer against a JSON schema.
   */
  async change(input: { diagnosis?: string | null; chat?: string | null }, by: string | null): Promise<AiModelsState> {
    const current = (await this.stored()).value;
    const next: Stored = { ...current };
    const issues: ErrorIssue[] = [];
    const lookup = async (path: string, id: string): Promise<ModelInfo | null> => {
      const m = await this.d.catalog.find(id);
      if (!m) issues.push({ path, message: `${id} is not a model OpenRouter offers` });
      return m;
    };
    if (input.diagnosis !== undefined) {
      if (input.diagnosis === null) next.diagnosis = null;
      else {
        const m = await lookup('diagnosis', input.diagnosis);
        if (m && !m.structured) issues.push({ path: 'diagnosis', message: `${m.id} cannot answer against a JSON schema (structured outputs), which a diagnosis needs` });
        if (m) next.diagnosis = { id: m.id, images: m.images };
      }
    }
    if (input.chat !== undefined) {
      if (input.chat === null) next.chat = null;
      else {
        const m = await lookup('chat', input.chat);
        if (m) next.chat = { id: m.id };
      }
    }
    if (issues.length) throw AppError.validation(issues, 'Model not changed');
    await this.d.settings.set(KEY, next, by);
    return this.state();
  }
}
