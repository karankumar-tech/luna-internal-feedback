import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { actorOf } from '../../lib/actor.js';
import { requirePermission } from '../../plugins/auth.js';
import { zodIssues } from '../../schema/buildValidator.js';
import { DEVICE_TAGS, tagLabel } from './metrics.js';
import { XLSX_TYPE, type ExportFile } from './export.js';
import { SCREENSHOT_PRE_TRANSFORMATION, SCREENSHOT_TYPES, type ScreenshotUploads } from '../feedback/feedback.routes.js';
import { BENCHMARK_MAX_SCREENSHOTS, type BenchmarksService } from './benchmarks.service.js';

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
/** The Luna build a session was recorded with. Empty clears it. */
const Version = z.string().trim().max(60).transform((v) => v || null).nullable();
const Platform = z.enum(['ios', 'android']).nullable();

const ListQuery = z.object({
  kind: Kind.optional(),
  device: Tag.optional(),
  tester: z.string().trim().max(80).optional(),
  is_test: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  comparable: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The list's filters, without paging: an export holds every session they match. */
const ExportQuery = ListQuery.omit({ limit: true, offset: true });

/** The filters an export was made with, in words, for its About sheet. */
function filtersInWords(f: z.infer<typeof ExportQuery>): [string, string][] {
  const out: [string, string][] = [];
  if (f.kind) out.push(['Kind', f.kind === 'sleep' ? 'Sleep' : 'Workouts']);
  if (f.device) out.push(['Device', tagLabel(f.device)]);
  if (f.tester) out.push(['Tester', f.tester]);
  if (f.comparable !== undefined) out.push(['Comparison', f.comparable ? 'Two or more devices compared' : 'Nothing to compare']);
  out.push(['Data', f.is_test === undefined ? 'Real and test' : f.is_test ? 'Test only' : 'Real only']);
  return out;
}

function sendFile(reply: FastifyReply, file: ExportFile) {
  return reply
    .header('content-type', XLSX_TYPE)
    .header('content-disposition', `attachment; filename="${file.filename.replace(/[^\w.-]/g, '_')}"`)
    .header('cache-control', 'no-store')
    .send(Buffer.from(file.body));
}

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
  // An implausible body profile is dropped, not refused: it is a footnote, and apps do write nonsense here.
  profile: z.object({
    weight_kg: Num.min(20).max(400).optional().catch(undefined),
    height_cm: Num.min(50).max(260).optional().catch(undefined),
  }).strict().nullish(),
  /** The source's VO2max (Cardio Fitness) reading nearest the workout, in ml/kg/min. An impossible one is dropped. */
  vo2max: z.object({ value: Num.min(10).max(100), unit: z.string().max(30).optional(), at: Epoch }).strict().nullish().catch(undefined),
}).strict();

const ImportBody = z.object({
  tester: Tester,
  kind: Kind,
  start: Epoch,
  end: Epoch,
  utc_offset_min: z.number().int().min(-840).max(840).default(330),
  is_test: z.boolean().optional(),
  /** Luna's firmware, the Luna app's version and the phone's platform, as typed on the import page. */
  firmware_version: Version.optional(),
  app_version: Version.optional(),
  platform: Platform.optional(),
  recordings: z.array(Recording).min(1).max(12),
}).strict().refine((b) => b.end >= b.start, { message: 'end must not be before start', path: ['end'] });

const PatchBody = z.object({
  title: z.string().trim().max(120).transform((v) => v || null).nullable().optional(),
  notes: z.string().trim().max(4000).transform((v) => v || null).nullable().optional(),
  tester: Tester.optional(),
  is_test: z.boolean().optional(),
  firmware_version: Version.optional(),
  app_version: Version.optional(),
  platform: Platform.optional(),
}).strict().refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'send title, notes, tester, is_test, firmware_version, app_version or platform' });

const RecordingPatch = z.object({
  device_tag: Tag.optional(),
  device_label: z.string().trim().max(80).transform((v) => v || null).nullable().optional(),
  /** Luna only: the distance and active calories its app showed, typed in by hand. null clears one. */
  distance_km: Num.min(0.01).max(1000).transform((v) => Math.round(v * 1000) / 1000).nullable().optional(),
  active_kcal: Num.min(1).max(20_000).transform((v) => Math.round(v * 10) / 10).nullable().optional(),
  /** Any device, on foot: the fastest pace its app showed, in seconds per km (2:00 to 60:00). No device writes it to Apple Health. */
  max_pace_s: Num.min(120).max(3600).transform((v) => Math.round(v)).nullable().optional(),
}).strict().refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'send device_tag, device_label, distance_km, active_kcal or max_pace_s' });

const ScreenshotBody = z.object({
  file_id: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(1000),
  name: z.string().trim().max(200).nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  size: z.number().int().nonnegative().nullish(),
}).strict();

/**
 * Device benchmarks. All under /v1/admin, so only a signed-in dashboard user or the admin key gets
 * in: this is testers' health data, and the app's key must not read it.
 */
export function registerBenchmarkRoutes(app: FastifyInstance, deps: { service: BenchmarksService; uploads?: ScreenshotUploads | null; exports: { baseUrl: string; timeZone: string } }) {
  const { service, uploads } = deps;
  const manage = { onRequest: requirePermission('manage_benchmarks') };

  app.get('/v1/admin/benchmarks', async (req) => service.list(parse(ListQuery, req.query ?? {})));

  /** Every session the filters match, as an Excel workbook: one line each, every side-by-side number, agreement and findings. */
  app.get('/v1/admin/benchmarks/export', async (req, reply) => {
    const filters = parse(ExportQuery, req.query ?? {});
    return sendFile(reply, await service.exportList(filters, { ...deps.exports, filters: filtersInWords(filters) }));
  });

  /** The brands a device can be tagged as. Any other tag (a-z, 0-9, _) is accepted too. */
  app.get('/v1/admin/benchmarks/device-tags', async () => ({ items: DEVICE_TAGS.map(({ tag, label }) => ({ tag, label })) }));

  app.get<{ Params: { id: string } }>('/v1/admin/benchmarks/:id', async (req) => service.get(req.params.id));

  /** One session as an Excel workbook, with every reading. */
  app.get<{ Params: { id: string } }>('/v1/admin/benchmarks/:id/export', async (req, reply) => sendFile(reply, await service.exportSession(req.params.id, deps.exports)));

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
    service.updateRecording(req.params.id, req.params.rid, parse(RecordingPatch, req.body), actorOf(req)));

  /** Joins another session into this one: one workout that two devices recorded with different clocks. */
  app.post<{ Params: { id: string } }>('/v1/admin/benchmarks/:id/merge', manage, async (req) => {
    const body = parse(z.object({ other: z.string().trim().min(1).max(60) }).strict(), req.body);
    return service.merge(req.params.id, body.other);
  });

  /** Short-lived ImageKit upload credentials: the page uploads a screenshot directly, then attaches it below. One call per file. */
  app.get('/v1/admin/benchmarks/screenshot-auth', manage, async () => {
    if (!uploads) throw AppError.validation([{ path: 'screenshots', message: 'screenshot uploads are not configured on the server' }], 'Uploads unavailable');
    const a = uploads.authParams();
    return {
      upload_url: 'https://upload.imagekit.io/api/v1/files/upload',
      public_key: uploads.publicKey,
      token: a.token, expire: a.expire, signature: a.signature,
      folder: `${uploads.folder.replace(/\/+$/, '')}/benchmarks`, use_unique_file_name: true, tags: ['luna-benchmark'],
      transformation: { pre: SCREENSHOT_PRE_TRANSFORMATION },
      max_bytes: uploads.maxBytes, max_count: BENCHMARK_MAX_SCREENSHOTS, accepted_types: [...SCREENSHOT_TYPES],
    };
  });

  app.post<{ Params: { id: string } }>('/v1/admin/benchmarks/:id/screenshots', manage, async (req, reply) =>
    reply.code(201).send(await service.addScreenshot(req.params.id, parse(ScreenshotBody, req.body), actorOf(req))));

  app.delete<{ Params: { id: string; fileId: string } }>('/v1/admin/benchmarks/:id/screenshots/:fileId', manage, async (req) =>
    service.removeScreenshot(req.params.id, req.params.fileId));

  app.delete<{ Params: { id: string } }>('/v1/admin/benchmarks/:id', manage, async (req) => service.remove(req.params.id));

  app.delete<{ Params: { id: string; rid: string } }>('/v1/admin/benchmarks/:id/recordings/:rid', manage, async (req) =>
    service.removeRecording(req.params.id, req.params.rid));
}
