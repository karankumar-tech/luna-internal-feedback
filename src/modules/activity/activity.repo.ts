import type { Db } from '../../db/pool.js';

export const EVENT_ACTIONS = [
  'created', 'status', 'assign', 'priority', 'note', 'test_flag',
  'kind_link', 'kind_suggest', 'kind_confirm', 'kind_reject', 'jira', 'diagnosis', 'ask_reporter',
] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

/** internal: the team only. customer: safe for CX to pass on to the customer. */
export const NOTE_VISIBILITIES = ['internal', 'customer'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

export interface EventRow {
  id: string;
  submission_id: string;
  actor: string | null;
  action: EventAction;
  from_value: string | null;
  to_value: string | null;
  note: string | null;
  visibility: NoteVisibility;
  created_at: Date;
}

export interface NewEvent {
  submissionId: string;
  actor: string | null;
  action: EventAction;
  from?: string | null;
  to?: string | null;
  note?: string | null;
  visibility?: NoteVisibility;
  /** A team member acted on the report: starts the response clock if it has not started, and resets "stale". */
  touch: boolean;
}

export class ActivityRepo {
  constructor(private readonly db: Db) {}

  async record(e: NewEvent): Promise<EventRow> {
    const r = await this.db.query<EventRow>(
      `insert into luna_feedback.submission_events (submission_id, actor, action, from_value, to_value, note, visibility)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, submission_id, actor, action, from_value, to_value, note, visibility, created_at`,
      [e.submissionId, e.actor, e.action, e.from ?? null, e.to ?? null, e.note ?? null, e.visibility ?? 'internal'],
    );
    if (e.touch) {
      await this.db.query(
        `update luna_feedback.submissions
            set first_touched_at = coalesce(first_touched_at, now()), last_activity_at = now()
          where id = $1`,
        [e.submissionId],
      );
    }
    return r.rows[0]!;
  }

  /** A report's history, oldest first. `customerOnly` keeps just the notes CX may pass on. */
  async list(submissionId: string, opts: { customerOnly?: boolean } = {}): Promise<EventRow[]> {
    const r = await this.db.query<EventRow>(
      `select id, submission_id, actor, action, from_value, to_value, note, visibility, created_at
         from luna_feedback.submission_events
        where submission_id = $1 ${opts.customerOnly ? `and visibility = 'customer'` : ''}
        order by created_at, id`,
      [submissionId],
    );
    return r.rows;
  }

  /** The newest note CX may pass on to the customer. */
  async latestCustomerNote(submissionId: string): Promise<EventRow | undefined> {
    const r = await this.db.query<EventRow>(
      `select id, submission_id, actor, action, from_value, to_value, note, visibility, created_at
         from luna_feedback.submission_events
        where submission_id = $1 and visibility = 'customer' and note is not null
        order by created_at desc limit 1`,
      [submissionId],
    );
    return r.rows[0];
  }

  /** The status a report had before it was last parked as needs_info, so a reply can put it back. */
  async statusBeforeNeedsInfo(submissionId: string): Promise<string | null> {
    const r = await this.db.query<{ from_value: string | null }>(
      `select from_value from luna_feedback.submission_events
        where submission_id = $1 and action = 'status' and to_value = 'needs_info'
        order by created_at desc limit 1`,
      [submissionId],
    );
    return r.rows[0]?.from_value ?? null;
  }
}
