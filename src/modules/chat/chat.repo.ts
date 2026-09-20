import type { Db } from '../../db/pool.js';

export interface ChatRow {
  id: string;
  submission_id: string;
  role: 'user' | 'assistant';
  content: string;
  author: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: string | null;
  error: string | null;
  created_at: Date;
}

const C_COLS = `id, submission_id, role, content, author, model, prompt_tokens, completion_tokens, cost_usd, error, created_at`;

export class ChatRepo {
  constructor(private readonly db: Db) {}

  async history(submissionId: string, limit = 60): Promise<ChatRow[]> {
    const r = await this.db.query<ChatRow>(
      `select ${C_COLS} from luna_feedback.diagnosis_chats where submission_id = $1 order by created_at asc limit $2`,
      [submissionId, limit],
    );
    return r.rows;
  }

  /** How many turns the user has spent on this ticket, for the per-ticket cap. */
  async userMessageCount(submissionId: string): Promise<number> {
    const r = await this.db.query<{ n: number }>(
      `select count(*)::int as n from luna_feedback.diagnosis_chats where submission_id = $1 and role = 'user'`,
      [submissionId],
    );
    return r.rows[0]?.n ?? 0;
  }

  async add(message: {
    submission_id: string;
    role: 'user' | 'assistant';
    content: string;
    author: string | null;
    model?: string | null;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cost_usd?: number | null;
    error?: string | null;
  }): Promise<ChatRow> {
    const r = await this.db.query<ChatRow>(
      `insert into luna_feedback.diagnosis_chats (submission_id, role, content, author, model, prompt_tokens, completion_tokens, cost_usd, error)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning ${C_COLS}`,
      [
        message.submission_id, message.role, message.content, message.author,
        message.model ?? null, message.prompt_tokens ?? null, message.completion_tokens ?? null,
        message.cost_usd ?? null, message.error ?? null,
      ],
    );
    return r.rows[0]!;
  }

  /** Removes a user turn that never got an answer, so a failed call does not burn the budget. */
  async remove(id: string): Promise<void> {
    await this.db.query(`delete from luna_feedback.diagnosis_chats where id = $1`, [id]);
  }

  async spendSince(since: Date): Promise<number> {
    const r = await this.db.query<{ usd: string }>(
      `select coalesce(sum(cost_usd), 0)::text as usd from luna_feedback.diagnosis_chats where created_at >= $1`,
      [since],
    );
    return Number(r.rows[0]?.usd ?? 0);
  }
}
