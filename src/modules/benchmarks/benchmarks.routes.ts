import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { DEVICE_TAGS } from './metrics.js';
import type { BenchmarksService } from './benchmarks.service.js';

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw AppError.validation(zodIssues(r.error));
  return r.data;
}

const Kind = z.enum(['workout', 'sleep']);
/** Seconds since the epoch, within a sane range (2000 to 2100). */
const Epoch = z.number().finite().min(946_684_800).max(4_102_444_800);
const Tester = z.string().trim().min(1, 'say who wore the devices').max(80);
const Source = z.string().trim().min(1).max(120);
const Tag = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{1,30}$/, 'letters, digits and _ only, at most 30');
const Num = z.number().finite();
const Offsets = z.array(Num).max(25_000);

const ListQuery = z.object({
  kind: Kind.optional(),
  device: Tag.optional(),
  tester: z.string().trim().max(80).optional(),
  is_test: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  comparable: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

const CheckBody = z.object({
  tester: z.string().trim().max(80).default(''),
  candidates: z.array(z.object({
    key: z.string().min(1).max(200),
    kind: Kind,
    source: Source,
    activity: z.string().max(100).nullish(),
    start: Epoch,
    end: Epoch,
  }).strict()).min(1).max(500),
}).strict();

const Samples = z.object({
  unit: z.string().max(30),
  t0: Epoch,
  s: Offsets,
  e: Offsets.nullable(),
  v: Offsets,
}).strict().refine((x) => x.s.length === x.v.length && (x.e === null || x.e.length === x.s.length), 'columns must be the same length');

const OptNum = Num.nullish().transform((v) => v ?? undefined);

const Recording = z.object({
  source: Source,
  source_version: z.string().max(60).nullish(),
  device: z.record(z.string().max(30), z.string().max(80)).nullish(),
  logged: z.boolean(),
  samples: z.record(z.string().min(1).max(100), Samples).refine((o) => Object.keys(o).length <= 60, 'too many sample types'),
  workout: z.object({
    activity: z.string().max(100),
    start: Epoch,
    end: Epoch,
    duration: Num.nullish(),
    duration_unit: z.string().max(10).nullish(),
    total_distance: Num.nullish(),
    total_distance_unit: z.string().max(10).nullish(),
    total_energy: Num.nullish(),
    total_energy_unit: z.string().max(10).nullish(),
    stats: z.array(z.object({ type: z.string().max(100), unit: z.string().max(30).optional(), sum: OptNum, average: OptNum, minimum: OptNum, maximum: OptNum }).strict()).max(40),
    metadata: z.record(z.string().max(80), z.string().max(200)).refine((o) => Object.keys(o).length <= 40, 'too many metadata entries'),
    events: z.array(z.object({ type: z.string().max(80).optional(), at: Epoch, duration: OptNum, durationUnit: z.string().max(10).optional() }).strict()).max(200),
  }).strict().optional(),
  sleep: z.object({
    start: Epoch,
    end: Epoch,
    segments: z.array(z.tuple([Epoch, Epoch, z.string().max(80)])).min(1).max(5000),
  }).strict().optional(),
  route: z.object({
    t0: Epoch,
    points: z.number().int().nonnegative(),
    t: z.array(Num).min(2).max(2000),
    lat: z.array(Num.min(-90).max(90)).max(2000),
    lon: z.array(Num.min(-180).max(180)).max(2000),
    ele: z.array(Num.nullable()).max(2000).nullable(),
    speed: z.array(Num.nullable()).max(2000).nullable(),
  }).strict().refine((r) => r.lat.length === r.t.length && r.lon.length === r.t.length, 'columns must be the same length').nullish(),
  profile: z.object({ weight_kg: Num.positive().max(500).optional(), height_cm: Num.positive().max(300).optional() }).strict().nullish(),
}).strict();

const ImportBody = z.object({
  tester: Tester,
  kind: Kind,
  start: Epoch,
  end: Epoch,
  utc_offset_min: z.number().int().min(-840).max(840).default(330),
  is_test: z.boolean().optional(),
  recordings: z.array(Recording).min(1).max(12),
}).strict().refine((b) => b.end >= b.start, { message: 'end must not be before start', path: ['end'] });

const PatchBody = z.object({
  title: z.string().trim().max(120).transform((v) => v || null).nullable().optional(),
  notes: z.string().trim().max(4000).transform((v) => v || null).nullable().optional(),
  tester: Tester.optional(),
  is_test: z.boolean().optional(),
}).strict().refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'send title, notes, tester or is_test' });

const RecordingPatch = z.object({
  device_tag: Tag.optional(),
  device_label: z.string().trim().max(80).transform((v) => v || null).nullable().optional(),
}).strict().refine((b) => b.device_tag !== undefined || b.device_label !== undefined, { message: 'send device_tag or device_label' });

/**
 * Device benchmarks. All under /v1/admin, so only a signed-in dashboard user or the admin key gets
 * in: this is testers' health data, and the app's key must not read it.
 */
export function registerBenchmarkRoutes(app: FastifyInstance, deps: { service: BenchmarksService }) {
  const { service } = deps;
  const manage = { onRequest: requirePermission('manage_benchmarks') };

  app.get('/v1/admin/benchmarks', async (req) => service.list(parse(ListQuery, req.query ?? {})));

  /** The brands a device can be tagged as. Any other tag (a-z, 0-9, _) is accepted too. */
  app.get('/v1/admin/benchmarks/device-tags', async () => ({ items: DEVICE_TAGS.map(({ tag, label }) => ({ tag, label })) }));

  app.get<{ Params: { id: string } }>('/v1/admin/benchmarks/:id', async (req) => service.get(req.params.id));

  /** Before importing: which workouts and nights in an export are one session, and which are already stored. */
  app.post('/v1/admin/benchmarks/check', { ...manage, bodyLimit: 1024 * 1024 }, async (req) => {
    const body = parse(CheckBody, req.body);
    return service.check(body.tester, body.candidates);
  });

  /** One session's recordings, read from the export in the browser. Under Vercel's 4.5 MB request cap. */
  app.post('/v1/admin/benchmarks/import', { ...manage, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const body = parse(ImportBody, req.body);
    const result = await service.import(body, actorOf(req));
    return reply.code(result.status === 'created' ? 201 : 200).send(result);
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/benchmarks/:id', manage, async (req) => service.update(req.params.id, parse(PatchBody, req.body)));

  app.patch<{ Params: { id: string; rid: string } }>('/v1/admin/benchmarks/:id/recordings/:rid', manage, async (req) =>
    service.updateRecording(req.params.id, req.params.rid, parse(RecordingPatch, req.body)));

  /** Joins another session into this one: one workout that two devices recorded with different clocks. */
  app.post<{ Params: { id: string } }>('/v1/admin/benchmarks/:id/merge', manage, async (req) => {
    const body = parse(z.object({ other: z.string().trim().min(1).max(60) }).strict(), req.body);
    return service.merge(req.params.id, body.other);
  });

  app.delete<{ Params: { id: string } }>('/v1/admin/benchmarks/:id', manage, async (req) => service.remove(req.params.id));

  app.delete<{ Params: { id: string; rid: string } }>('/v1/admin/benchmarks/:id/recordings/:rid', manage, async (req) =>
    service.removeRecording(req.params.id, req.params.rid));
}
