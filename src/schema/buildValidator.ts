import { z, type ZodTypeAny } from 'zod';
import type { FieldDef } from './fieldTypes.js';
import { COMMON_FIELDS, FEATURE_DEFINITIONS, CLIENT_CONTEXT_FIELDS, type FeatureKey } from './registry.js';
import { isValidCalendarDate, isValidTime12h, normalizeTime12h, todayInZone } from '../lib/time.js';

export interface ValidatorContext {
  /** Active category keys for the feature being validated. */
  categoryKeys: readonly string[];
  /** Accept only screenshot URLs for which this returns true (our ImageKit endpoint). Absent = screenshots refused. */
  isScreenshotUrl?: (url: string) => boolean;
  maxScreenshots?: number;
  /** IANA zone used to decide "today" for the occurred_on future check. */
  timeZone: string;
  now?: Date;
}

function optionalize(schema: ZodTypeAny, required: boolean): ZodTypeAny {
  return required ? schema : schema.optional().nullable();
}

/** Turns one registry field into a Zod schema. */
export function fieldToZod(field: FieldDef, ctx: ValidatorContext, lenient = false): ZodTypeAny {
  // A conditionally required field (requiredIf) is optional only in the lenient variant of the schema.
  const relaxed = lenient && !!field.requiredIf;
  const required = field.required && !relaxed;
  switch (field.type) {
    case 'boolean':
      return optionalize(z.boolean({ invalid_type_error: 'must be true or false' }), required);

    case 'text':
      return optionalize(
        z.string().trim().max(field.maxLength, `must be at most ${field.maxLength} characters`),
        required,
      );

    case 'date': {
      const today = todayInZone(ctx.timeZone, ctx.now);
      const s = z
        .string()
        .refine(isValidCalendarDate, 'must be a real date in YYYY-MM-DD format')
        .refine((v) => field.allowFuture || v <= today, `must not be in the future (today is ${today})`);
      return optionalize(s, required);
    }

    case 'number': {
      let n = z.number({ invalid_type_error: 'must be a number' }).finite();
      if (field.integer) n = n.int('must be a whole number');
      if (field.min !== undefined) n = n.min(field.min, `must be >= ${field.min}`);
      if (field.max !== undefined) n = n.max(field.max, `must be <= ${field.max}`);
      return optionalize(n, required);
    }

    case 'time_12h':
      return optionalize(
        z.string().trim().refine(isValidTime12h, 'must be HH:MM AM/PM, e.g. "10:45 PM"').transform(normalizeTime12h),
        required,
      );

    case 'string': {
      let s = z.string().trim();
      if (field.format === 'email') s = s.email('must be a valid email address');
      if (field.maxLength !== undefined) s = s.max(field.maxLength, `must be at most ${field.maxLength} characters`);
      let out: ZodTypeAny = s;
      if (field.options && field.options.length > 0) {
        const allowed = new Set(field.options);
        out = s.refine((v) => allowed.has(v), `must be one of: ${field.options.join(', ')}`);
      }
      return optionalize(out, required);
    }

    case 'multi_select': {
      const allowed = new Set(ctx.categoryKeys);
      // The minimum is enforced here for unconditional fields; conditional ones check it in the body-level refine.
      const base = z.array(z.string().trim());
      const s = (relaxed ? base : base.min(field.minItems, minItemsMessage(field.minItems)))
        .superRefine((arr, rctx) => {
          const seen = new Set<string>();
          arr.forEach((v, i) => {
            if (!allowed.has(v)) rctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `unknown category "${v}"` });
            if (seen.has(v)) rctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `duplicate category "${v}"` });
            seen.add(v);
          });
        });
      return optionalize(s, required);
    }
  }
}

const minItemsMessage = (n: number) => (n === 1 ? 'select at least one' : `select at least ${n}`);

function fieldsToObject(fields: readonly FieldDef[], ctx: ValidatorContext, lenient = false) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of fields) shape[f.key] = fieldToZod(f, ctx, lenient);
  return z.object(shape).strict();
}

function clientContextSchema(ctx: ValidatorContext) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of CLIENT_CONTEXT_FIELDS) {
    // platform is matched case-insensitively ("iOS" -> "ios")
    shape[f.key] = f.key === 'platform'
      ? optionalize(z.string().trim().toLowerCase().pipe(fieldToZod({ ...f, required: true }, ctx)), false)
      : fieldToZod(f, ctx);
  }
  return z.object(shape).strict();
}

/**
 * Builds the full POST body validator for a feature.
 * `details` keys outside the registry are rejected so typos surface immediately.
 */
export function buildSubmissionValidator(feature: FeatureKey, ctx: ValidatorContext) {
  const def = FEATURE_DEFINITIONS[feature];

  let details = fieldsToObject(def.fields, ctx);
  for (const rule of def.rules) {
    if (rule.kind === 'time_pair_distinct') {
      details = details.superRefine((d, rctx) => {
        const a = d[rule.start];
        const b = d[rule.end];
        if (a && b && a === b) {
          rctx.addIssue({ code: z.ZodIssueCode.custom, path: [rule.end], message: `must differ from ${rule.start}` });
        }
      }) as unknown as typeof details;
    }
  }

  const screenshot = z.object({
    file_id: z.string().trim().min(1).max(120),
    url: z.string().trim().url().max(1000).refine((u) => (ctx.isScreenshotUrl ? ctx.isScreenshotUrl(u) : false), 'must be an ImageKit URL from the screenshot upload flow'),
    thumbnail_url: z.string().trim().url().max(1000).optional().nullable(),
    name: z.string().trim().max(200).optional().nullable(),
    width: z.number().int().positive().optional().nullable(),
    height: z.number().int().positive().optional().nullable(),
    size: z.number().int().nonnegative().optional().nullable(),
    /** Bytes the app actually sent (before ImageKit's storage cap). Lets the dashboard show whether the app downsized. */
    upload_size: z.number().int().nonnegative().optional().nullable(),
    original_width: z.number().int().positive().optional().nullable(),
    original_height: z.number().int().positive().optional().nullable(),
  }).strict();
  const extra = {
    details: details.optional().default({}),
    client: clientContextSchema(ctx).optional().nullable(),
    /** Images uploaded to ImageKit via GET /v1/uploads/screenshot-auth, then referenced here. */
    screenshots: z.array(screenshot).max(ctx.maxScreenshots ?? 5, `at most ${ctx.maxScreenshots ?? 5} screenshots`).optional().nullable(),
    /** Marks integration/demo submissions so they can be filtered and deleted without touching real feedback. */
    is_test: z.boolean().optional().default(false),
  };
  // Two variants of the same shape: positive feedback relaxes the requiredIf fields (issue_categories, occurred_on);
  // anything else, including a missing is_positive, gets the strict one so every mandatory field is reported.
  const strict = fieldsToObject(COMMON_FIELDS, ctx).extend(extra);
  const lenient = fieldsToObject(COMMON_FIELDS, ctx, true).extend(extra);
  const pick = (input: unknown) => (input && typeof input === 'object' && (input as { is_positive?: unknown }).is_positive === true ? lenient : strict);
  return {
    strict,
    lenient,
    safeParse: (input: unknown) => pick(input).safeParse(input) as ReturnType<typeof strict.safeParse>,
  };
}

export type SubmissionInput = z.infer<ReturnType<typeof buildSubmissionValidator>['strict']>;

/** Flattens a ZodError into the API's issue list. */
export function zodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(body)', message: i.message }));
}
