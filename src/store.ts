import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  canonical,
  hash,
  id,
  mutationSchema,
  planSchema,
  settingsSchema,
  timing,
  checkpointState,
  dayBounds,
  zonedParts,
  parseTime,
  Problem,
  type Task,
  type Plan,
  type Settings,
  type Checkpoint,
  type Mutation,
} from "./domain.js";

type Row = Record<string, string | number | null>;
export class Store {
  db: DatabaseSync;
  constructor(
    public filename: string,
    private key: Buffer,
    public now: () => number = Date.now,
  ) {
    if (key.length !== 32) throw new Error("Encryption key must have 32 bytes");
    if (filename !== ":memory:")
      mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,version INTEGER NOT NULL,generation INTEGER NOT NULL,instance_id TEXT NOT NULL,payload TEXT NOT NULL,cancelled INTEGER NOT NULL,start_at INTEGER,end_at INTEGER,start_open INTEGER,end_open INTEGER,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,task_id TEXT,generation INTEGER NOT NULL,kind TEXT NOT NULL,run_at INTEGER NOT NULL,deadline INTEGER NOT NULL,state TEXT NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,payload TEXT,error TEXT,message_id TEXT);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,run_at,lease_until);
      CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,kind TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL,path TEXT,hash TEXT,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS checkins(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,instance_id TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,media_id TEXT NOT NULL,note TEXT NOT NULL,submit_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,UNIQUE(instance_id,kind));
      CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,date TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(date,kind));
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,action TEXT NOT NULL,task_id TEXT,detail TEXT NOT NULL);
      INSERT OR IGNORE INTO schema_migrations VALUES(1);`);
    this.transaction(() => {
      if (
        !this.all("PRAGMA table_info(tasks)").some(
          (row) => row.name === "frozen",
        )
      )
        this.db.exec(
          "ALTER TABLE tasks ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0",
        );
      this.run("INSERT OR IGNORE INTO schema_migrations VALUES(2)");
    });
    if (!this.get("SELECT key FROM config WHERE key='settings'"))
      this.setConfig("settings", settingsSchema.parse({}));
  }
  get(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  config<T>(key: string): T | null {
    const row = this.get("SELECT value FROM config WHERE key=?", key);
    return row ? (JSON.parse(String(row.value)) as T) : null;
  }
  setConfig(key: string, value: unknown) {
    this.run(
      "INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  encrypt(text: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  decrypt(text: string) {
    const b = Buffer.from(text, "base64"),
      cipher = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([
      cipher.update(b.subarray(28)),
      cipher.final(),
    ]).toString();
  }
  settings() {
    return settingsSchema.parse(this.config("settings"));
  }
  rowTask(row: Row): Task {
    return {
      frozen: !!row.frozen,
      id: String(row.id),
      version: Number(row.version),
      generation: Number(row.generation),
      instanceId: String(row.instance_id),
      plan: planSchema.parse(JSON.parse(String(row.payload))),
      cancelled: !!row.cancelled,
      startAt: row.start_at === null ? null : Number(row.start_at),
      endAt: row.end_at === null ? null : Number(row.end_at),
      startOpen: row.start_open === null ? null : Number(row.start_open),
      endOpen: row.end_open === null ? null : Number(row.end_open),
      state: String(row.state),
    };
  }
  task(taskId: string) {
    const row = this.get("SELECT * FROM tasks WHERE id=?", taskId);
    if (!row) throw new Problem(404, "task_not_found");
    return this.rowTask(row);
  }
  tasks() {
    return this.all("SELECT * FROM tasks ORDER BY start_at,id").map((r) =>
      this.rowTask(r),
    );
  }
  checkpoint(task: Task, kind: Checkpoint) {
    return checkpointState(
      task,
      kind,
      this.now(),
      !!this.get(
        "SELECT id FROM checkins WHERE instance_id=? AND kind=?",
        task.instanceId,
        kind,
      ),
    );
  }
  view(task: Task) {
    return {
      ...task,
      serverTime: this.now(),
      checkpoints: {
        start: this.checkpoint(task, "start"),
        end: this.checkpoint(task, "end"),
      },
      checkins: this.all(
        "SELECT id,kind,at,media_id,note FROM checkins WHERE instance_id=?",
        task.instanceId,
      ),
    };
  }
  event(kind: string, payload: unknown) {
    this.run(
      "INSERT INTO changes(kind,payload) VALUES(?,?)",
      kind,
      JSON.stringify(payload),
    );
  }
  audit(action: string, taskId: string | null, detail: unknown) {
    this.run(
      "INSERT INTO audit(at,action,task_id,detail) VALUES(?,?,?,?)",
      this.now(),
      action,
      taskId,
      canonical(detail),
    );
  }
  saveTask(task: Task) {
    this.run(
      "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,generation=excluded.generation,instance_id=excluded.instance_id,payload=excluded.payload,cancelled=excluded.cancelled,start_at=excluded.start_at,end_at=excluded.end_at,start_open=excluded.start_open,end_open=excluded.end_open,state=excluded.state,frozen=excluded.frozen",
      task.id,
      task.version,
      task.generation,
      task.instanceId,
      JSON.stringify(task.plan),
      +task.cancelled,
      task.startAt,
      task.endAt,
      task.startOpen,
      task.endOpen,
      task.state,
      +task.frozen,
    );
  }
  arrange(task: Task) {
    this.run(
      "UPDATE jobs SET state='cancelled' WHERE task_id=? AND state NOT IN ('sent','expired')",
      task.id,
    );
    if (task.cancelled || task.state !== "scheduled") return;
    for (const kind of ["start", "end"] as const) {
      if (
        this.get(
          "SELECT id FROM checkins WHERE instance_id=? AND kind=?",
          task.instanceId,
          kind,
        ) ||
        this.get(
          "SELECT id FROM jobs WHERE task_id=? AND kind=? AND state='sent'",
          task.id,
          kind,
        )
      )
        continue;
      const deadline = kind === "start" ? task.startAt! : task.endAt!;
      const at = kind === "start" ? task.startOpen! : task.endOpen!;
      const jobId =
        "tn_" + hash(`${task.instanceId}:${kind}:${task.generation}`);
      this.run(
        "INSERT OR IGNORE INTO jobs(id,task_id,generation,kind,run_at,deadline,state) VALUES(?,?,?,?,?,?,?)",
        jobId,
        task.id,
        task.generation,
        kind,
        at,
        deadline,
        deadline <= this.now() ? "expired" : "pending",
      );
    }
  }
  mutate(raw: unknown) {
    const m = mutationSchema.parse(raw);
    const explicit = (raw as { changes: Record<string, unknown> }).changes;
    m.changes = Object.fromEntries(
      Object.entries(m.changes).filter(([key]) =>
        Object.prototype.hasOwnProperty.call(explicit, key),
      ),
    ) as typeof m.changes;
    const requestHash = hash(canonical(m));
    return this.transaction(() => {
      const oldOperation = this.get(
        "SELECT * FROM operations WHERE id=?",
        m.operationId,
      );
      if (oldOperation) {
        if (oldOperation.hash !== requestHash)
          throw new Problem(409, "operation_payload_conflict");
        return JSON.parse(String(oldOperation.result)) as Task;
      }
      const row = this.get("SELECT * FROM tasks WHERE id=?", m.taskId);
      const old = row ? this.rowTask(row) : null;
      if ((old?.version ?? 0) !== m.baseVersion)
        throw new Problem(409, "version_conflict");
      if (!old && m.action !== "create")
        throw new Problem(404, "task_not_found");
      if (old && m.action === "create") throw new Problem(409, "task_exists");
      if (old?.cancelled && m.action === "update")
        throw new Problem(409, "task_cancelled");
      const settings = this.settings(),
        plan = planSchema.parse({
          ...old?.plan,
          ...m.changes,
          timezone:
            m.changes.timezone ?? old?.plan.timezone ?? settings.timezone,
        });
      let times = timing(plan, settings);
      const timingKeys = [
        "scheduled",
        "due",
        "timezone",
        "startLeadMinutes",
        "endLeadMinutes",
        "enabled",
        "recurrence",
      ] as const;
      const frozen =
        !!old &&
        (old.frozen ||
          (old.state === "scheduled" &&
            Math.min(old.startOpen ?? Infinity, old.endOpen ?? Infinity) <=
              this.now()));
      if (
        old &&
        timingKeys.some((k) => canonical(plan[k]) !== canonical(old.plan[k])) &&
        frozen
      )
        throw new Problem(409, "window_frozen");
      if (old && frozen)
        times = {
          startAt: old.startAt,
          endAt: old.endAt,
          startOpen: old.startOpen,
          endOpen: old.endOpen,
          state: times.state,
        };
      if (m.action === "restore" && (old?.endAt ?? Infinity) <= this.now())
        throw new Problem(409, "expired_instance");
      const task: Task = {
        frozen,
        id: m.taskId,
        version: (old?.version ?? 0) + 1,
        generation: (old?.generation ?? 0) + 1,
        instanceId: old?.instanceId ?? id(),
        plan,
        cancelled:
          m.action === "cancel" || (!!old?.cancelled && m.action !== "restore"),
        ...times,
      };
      this.saveTask(task);
      this.arrange(task);
      this.event("task", task);
      this.audit(m.action, task.id, {
        version: task.version,
        operationId: m.operationId,
      });
      this.run(
        "INSERT INTO operations VALUES(?,?,?)",
        m.operationId,
        requestHash,
        JSON.stringify(task),
      );
      return task;
    });
  }
  updateSettings(raw: unknown) {
    const next = settingsSchema.parse(raw);
    checkZoneSettings(next);
    return this.transaction(() => {
      const previous = this.settings();
      this.setConfig("settings", next);
      for (const task of this.tasks()) {
        if (
          task.frozen ||
          (task.state === "scheduled" &&
            Math.min(task.startOpen ?? Infinity, task.endOpen ?? Infinity) <=
              this.now())
        )
          continue;
        const plan = {
          ...task.plan,
          timezone:
            task.plan.timezone === previous.timezone
              ? next.timezone
              : task.plan.timezone,
        };
        const times = timing(plan, next);
        const updated = {
          ...task,
          plan,
          ...times,
          version: task.version + 1,
          generation: task.generation + 1,
        };
        this.saveTask(updated);
        this.arrange(updated);
        this.event("task", updated);
      }
      this.audit("settings", null, next);
      return next;
    });
  }
  allocateUpload(taskId: string, kind: Checkpoint, version: number) {
    return this.transaction(() => {
      const task = this.task(taskId);
      this.requireOpen(task, kind, version);
      const uploadId = id();
      this.run(
        "INSERT INTO uploads VALUES(?,?,?,?,?,?,?,?)",
        uploadId,
        taskId,
        kind,
        version,
        "pending",
        null,
        null,
        this.now() + 15 * 60000,
      );
      return uploadId;
    });
  }
  requireOpen(task: Task, kind: Checkpoint, version: number) {
    if (task.version !== version) throw new Problem(409, "version_conflict");
    const state = this.checkpoint(task, kind);
    if (state !== "open")
      throw new Problem(
        state === "submitted" ? 409 : 410,
        state === "not_open"
          ? "not_open"
          : state === "missed"
            ? "deadline_passed"
            : state,
      );
  }
  submit(
    taskId: string,
    kind: Checkpoint,
    body: { version: number; uploadId: string; submitId: string; note: string },
  ) {
    return this.transaction(() => {
      const requestHash = hash(canonical({ taskId, kind, ...body }));
      const prior = this.get(
        "SELECT * FROM checkins WHERE submit_id=?",
        body.submitId,
      );
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new Problem(409, "submit_payload_conflict");
        return {
          id: String(prior.id),
          taskId: String(prior.task_id),
          instanceId: String(prior.instance_id),
          kind: prior.kind,
          at: Number(prior.at),
          mediaId: String(prior.media_id),
          note: String(prior.note),
          mediaHash: this.get(
            "SELECT hash FROM uploads WHERE id=?",
            String(prior.media_id),
          )?.hash,
        };
      }
      const task = this.task(taskId);
      this.requireOpen(task, kind, body.version);
      const upload = this.get(
        "SELECT * FROM uploads WHERE id=?",
        body.uploadId,
      );
      if (
        !upload ||
        upload.task_id !== taskId ||
        upload.kind !== kind ||
        Number(upload.version) !== body.version ||
        upload.state !== "ready" ||
        Number(upload.expires) <= this.now()
      )
        throw new Problem(400, "invalid_upload");
      const recordId = id(),
        at = this.now();
      this.run(
        "INSERT INTO checkins VALUES(?,?,?,?,?,?,?,?,?)",
        recordId,
        taskId,
        task.instanceId,
        kind,
        at,
        body.uploadId,
        body.note,
        body.submitId,
        requestHash,
      );
      this.run("UPDATE uploads SET state='linked' WHERE id=?", body.uploadId);
      const record = {
        id: recordId,
        taskId,
        instanceId: task.instanceId,
        kind,
        at,
        mediaId: body.uploadId,
        note: body.note,
        mediaHash: upload.hash,
      };
      this.event("checkin", record);
      this.audit("checkin", taskId, { recordId, kind, at });
      return record;
    });
  }
  report(date: string, kind: "morning" | "evening") {
    const settings = this.settings(),
      [start, end] = dayBounds(date, settings.timezone);
    let cancelled = 0;
    const counts = {
      both: 0,
      startOnly: 0,
      endOnly: 0,
      missed: 0,
      pending: 0,
      manual: 0,
    };
    const tasks = this.tasks()
      .filter(
        (t) =>
          t.state !== "unsupported_recurrence" &&
          t.startAt !== null &&
          t.endAt !== null &&
          t.startAt < end &&
          t.endAt > start,
      )
      .map((t) => {
        const view = this.view(t);
        if (t.cancelled || t.plan.archived) {
          cancelled++;
        } else {
          if (t.plan.completed) counts.manual++;
          const s = view.checkpoints.start,
            e = view.checkpoints.end;
          if (s === "submitted" && e === "submitted") counts.both++;
          else if (
            (s !== "submitted" && (t.startAt ?? Infinity) > this.now()) ||
            (e !== "submitted" && (t.endAt ?? Infinity) > this.now())
          )
            counts.pending++;
          else if (s === "submitted") counts.startOnly++;
          else if (e === "submitted") counts.endOnly++;
          else counts.missed++;
        }
        return view;
      });
    return {
      date,
      kind,
      timezone: settings.timezone,
      generatedAt: this.now(),
      total: tasks.length - cancelled,
      cancelled,
      counts,
      tasks,
    };
  }
  ensureReports() {
    const s = this.settings();
    if (!s.reportsEnabled) return;
    const parts = zonedParts(this.now(), s.timezone);
    for (const kind of ["morning", "evening"] as const) {
      const at = parseTime(
        `${parts.date}T${kind === "morning" ? s.morningTime : s.eveningTime}`,
        s.timezone,
      )!;
      if (this.now() < at) continue;
      const reportId = "tn_" + hash(`report:${parts.date}:${kind}`);
      if (this.get("SELECT id FROM reports WHERE id=?", reportId)) continue;
      this.transaction(() => {
        const report = this.report(parts.date, kind);
        this.run(
          "INSERT OR IGNORE INTO reports VALUES(?,?,?,?)",
          reportId,
          parts.date,
          kind,
          JSON.stringify(report),
        );
        const deadline = dayBounds(parts.date, s.timezone)[1];
        if (report.total || s.reportEmpty)
          this.run(
            "INSERT OR IGNORE INTO jobs(id,task_id,generation,kind,run_at,deadline,state) VALUES(?,NULL,0,?,?,?,'pending')",
            reportId,
            kind,
            at,
            deadline,
          );
      });
    }
  }
}
function checkZoneSettings(s: Settings) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: s.timezone }).format();
  } catch {
    throw new Problem(400, "invalid_timezone");
  }
  for (const t of [s.morningTime, s.eveningTime]) {
    const [h, m] = t.split(":").map(Number);
    if (h! > 23 || m! > 59) throw new Problem(400, "invalid_report_time");
  }
}
