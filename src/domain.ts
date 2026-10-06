import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const settingsSchema = z
  .object({
    timezone: z.string().default("Asia/Shanghai"),
    startLeadMinutes: z.number().int().min(1).max(1440).default(10),
    endLeadMinutes: z.number().int().min(1).max(1440).default(10),
    morningTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("07:00"),
    eveningTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .default("22:00"),
    reportSeverity: z
      .enum(["low", "normal", "high", "critical"])
      .default("normal"),
    reportEmpty: z.boolean().default(true),
    reportsEnabled: z.boolean().default(true),
    retentionDays: z.number().int().min(1).max(3650).default(90),
    priorityMap: z
      .record(z.string(), z.enum(["low", "normal", "high", "critical"]))
      .default({ none: "normal", low: "low", normal: "normal", high: "high" }),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const planSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    scheduled: z.string().nullable().default(null),
    due: z.string().nullable().default(null),
    priority: z.string().max(80).default("normal"),
    status: z.string().max(80).default("open"),
    completed: z.boolean().default(false),
    archived: z.boolean().default(false),
    recurrence: z.string().nullable().default(null),
    timezone: z.string().default("Asia/Shanghai"),
    startLeadMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .nullable()
      .default(null),
    endLeadMinutes: z.number().int().min(1).max(1440).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;
export const mutationSchema = z
  .object({
    operationId: z.uuid(),
    taskId: z.uuid(),
    baseVersion: z.number().int().min(0),
    action: z.enum(["create", "update", "cancel", "restore"]),
    changes: planSchema.partial(),
    origin: z.literal("tasknotes_ui"),
  })
  .strict();
export type Mutation = z.infer<typeof mutationSchema>;
export type Checkpoint = "start" | "end";
export type Task = {
  frozen: boolean;
  id: string;
  version: number;
  generation: number;
  instanceId: string;
  plan: Plan;
  cancelled: boolean;
  startAt: number | null;
  endAt: number | null;
  startOpen: number | null;
  endOpen: number | null;
  state: string;
};
export class Problem extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export const id = () => randomUUID();
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function checkZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    throw new Problem(400, "invalid_timezone");
  }
}
export function zonedParts(at: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (name: string) =>
    parts.find((p) => p.type === name)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    year: +get("year"),
    month: +get("month"),
    day: +get("day"),
    hour: +get("hour"),
    minute: +get("minute"),
    second: +get("second"),
  };
}
export function parseTime(raw: string | null, zone: string): number | null {
  if (!raw) return null;
  const pattern = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
  const match = raw.match(pattern);
  if (!match) throw new Problem(400,"invalid_time");
  const [year,month,day] = match.slice(1,4).map(Number);
  const calendar = new Date(Date.UTC(year,month-1,day));
  if (year < 100 || calendar.getUTCFullYear()!==year || calendar.getUTCMonth()!==month-1 || calendar.getUTCDate()!==day || Number(match[4]??0)>23 || Number(match[5]??0)>59 || Number(match[6]??0)>59) throw new Problem(400,"invalid_time");
  if (!match[4]) return null;
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) throw new Problem(400, "invalid_time");
    return at;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw))
    throw new Problem(400, "invalid_time");
  const expected = raw.slice(0, 16);
  let at = Date.parse(raw + (raw.length === 16 ? ":00" : "") + "Z");
  for (let i = 0; i < 4; i++) {
    const v = zonedParts(at, zone);
    const represented = Date.UTC(
      v.year,
      v.month - 1,
      v.day,
      v.hour,
      v.minute,
      v.second,
    );
    const wanted = Date.parse(raw + (raw.length === 16 ? ":00" : "") + "Z");
    at += wanted - represented;
  }
  const v = zonedParts(at, zone);
  if (`${v.date}T${v.time}` !== expected)
    throw new Problem(400, "invalid_local_time");
  return at;
}
export function timing(plan: Plan, settings: Settings) {
  checkZone(plan.timezone);
  const startAt = parseTime(plan.scheduled, plan.timezone),
    endAt = parseTime(plan.due, plan.timezone);
  if (startAt !== null && endAt !== null && endAt <= startAt)
    throw new Problem(400, "end_before_start");
  const startOpen =
    startAt === null
      ? null
      : startAt - (plan.startLeadMinutes ?? settings.startLeadMinutes) * 60000;
  const endOpen =
    endAt === null
      ? null
      : endAt - (plan.endLeadMinutes ?? settings.endLeadMinutes) * 60000;
  const state = plan.recurrence
    ? "unsupported_recurrence"
    : !plan.enabled || plan.completed || plan.archived
      ? "inactive"
      : startAt === null || endAt === null
        ? "pending_configuration"
        : "scheduled";
  return { startAt, endAt, startOpen, endOpen, state };
}
export function checkpointState(
  task: Task,
  kind: Checkpoint,
  now: number,
  submitted: boolean,
): string {
  if (submitted) return "submitted";
  if (task.cancelled || task.state === "inactive") return "cancelled";
  const open = kind === "start" ? task.startOpen : task.endOpen,
    close = kind === "start" ? task.startAt : task.endAt;
  if (task.state !== "scheduled" || open === null || close === null)
    return "unconfigured";
  return now < open ? "not_open" : now >= close ? "missed" : "open";
}
export function dayBounds(date: string, zone: string) {
  const start = parseTime(`${date}T00:00`, zone);
  if (start === null) throw new Problem(400, "invalid_date");
  const next = new Date(Date.parse(`${date}T12:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  return [start, parseTime(`${next}T00:00`, zone)!] as const;
}
