import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";
import { makeApp } from "../src/app.js";
import {
  planSchema,
  settingsSchema,
  parseTime,
  checkpointState,
  type Mutation,
} from "../src/domain.js";
const at = (v: string) => Date.parse(v);
const base = at("2026-10-06T00:00:00Z");
test("graceful shutdown waits for the current delivery before database closure", async () => {
  const { store, time } = fixture();
  const t = store.mutate(create());
  store.setConfig("binding", {
    url: "https://gateway.test",
    channelId: "CHANNEL",
    secret: store.encrypt("testpassword"),
  });
  time(t.startOpen!);
  let finish!: (response: Response) => void;
  const worker = new Worker(
    store,
    "test",
    "https://tasks.test",
    (async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      })) as typeof fetch,
  );
  const running = worker.tick();
  let stopped = false;
  const drain = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  finish(new Response(JSON.stringify({ success: true })));
  await Promise.all([running, drain]);
  assert.equal(stopped, true);
  assert.equal(
    store.get("SELECT state FROM jobs WHERE kind='start'")?.state,
    "sent",
  );
  store.db.close();
  await worker.tick();
});
function fixture() {
  let now = base;
  const store = new Store(":memory:", randomBytes(32), () => now);
  store.updateSettings({ ...settingsSchema.parse({}), reportsEnabled: false });
  return {
    store,
    time: (v: number) => {
      now = v;
    },
  };
}
function create(taskId = randomUUID(), changes: Record<string, unknown> = {}) {
  return {
    operationId: randomUUID(),
    taskId,
    baseVersion: 0,
    action: "create",
    origin: "tasknotes_ui",
    changes: {
      title: "读书",
      scheduled: "2026-10-06T09:00",
      due: "2026-10-06T10:00",
      timezone: "Asia/Shanghai",
      ...changes,
    },
  };
}
function edit(
  t: { id: string; version: number },
  changes: Record<string, unknown> = {},
  action = "update",
) {
  return {
    operationId: randomUUID(),
    taskId: t.id,
    baseVersion: t.version,
    action,
    origin: "tasknotes_ui",
    changes,
  };
}
test("idempotent create and payload mismatch", () => {
  const { store } = fixture(),
    m = create(),
    t = store.mutate(m);
  assert.deepEqual(store.mutate(m), t);
  assert.equal(store.tasks().length, 1);
  assert.equal(store.all("SELECT * FROM jobs").length, 2);
  assert.throws(
    () => store.mutate({ ...m, changes: { ...m.changes, title: "不同" } }),
    /operation_payload_conflict/,
  );
});
test("raw file/API origin is rejected", () => {
  const { store } = fixture();
  assert.throws(() => store.mutate({ ...create(), origin: "file_change" }));
  assert.equal(store.tasks().length, 0);
});
test("dates without times remain pending", () => {
  const { store } = fixture();
  const t = store.mutate(
    create(undefined, { scheduled: "2026-10-06", due: "2026-10-07" }),
  );
  assert.equal(t.state, "pending_configuration");
  assert.equal(store.all("SELECT * FROM jobs").length, 0);
});
test("three reschedules only keep current jobs and stale versions conflict", () => {
  const { store } = fixture();
  let t = store.mutate(create());
  const old = t;
  for (let i = 0; i < 3; i++)
    t = store.mutate(edit(t, { scheduled: `2026-10-06T09:${10 + i}` }));
  assert.equal(store.all("SELECT * FROM jobs WHERE state='pending'").length, 2);
  assert.throws(
    () => store.mutate(edit(old, { priority: "high" })),
    /version_conflict/,
  );
});
test("priority patch does not import a manually modified schedule", () => {
  const { store } = fixture();
  const t = store.mutate(create());
  const next = store.mutate(edit(t, { priority: "high" }));
  assert.equal(next.plan.scheduled, t.plan.scheduled);
});
test("strict half-open windows and independent end card", () => {
  const { store, time } = fixture(),
    t = store.mutate(create());
  time(t.startOpen! - 1);
  assert.equal(store.checkpoint(t, "start"), "not_open");
  time(t.startOpen!);
  assert.equal(store.checkpoint(t, "start"), "open");
  time(t.startAt!);
  assert.equal(store.checkpoint(t, "start"), "missed");
  time(t.endOpen!);
  assert.equal(store.checkpoint(t, "end"), "open");
  const upload = store.allocateUpload(t.id, "end", t.version);
  store.run("UPDATE uploads SET state='ready',hash='test' WHERE id=?", upload);
  const body = {
    version: t.version,
    uploadId: upload,
    submitId: randomUUID(),
    note: "独立结束",
  };
  const result = store.submit(t.id, "end", body);
  assert.ok(result.id);
  assert.equal(store.checkpoint(t, "start"), "missed");
  assert.equal(store.checkpoint(t, "end"), "submitted");
  assert.equal(store.submit(t.id, "end", body).id, result.id);
});
test("upload within window does not authorize submission after deadline", () => {
  const { store, time } = fixture(),
    t = store.mutate(create());
  time(t.startOpen!);
  const upload = store.allocateUpload(t.id, "start", t.version);
  store.run("UPDATE uploads SET state='ready' WHERE id=?", upload);
  time(t.startAt!);
  assert.throws(
    () =>
      store.submit(t.id, "start", {
        version: t.version,
        uploadId: upload,
        submitId: randomUUID(),
        note: "",
      }),
    /deadline_passed/,
  );
});
test("opened windows freeze timing but cancellation remains valid", () => {
  const { store, time } = fixture(),
    t = store.mutate(create());
  time(t.startOpen!);
  assert.throws(
    () => store.mutate(edit(t, { due: "2026-10-06T11:00" })),
    /window_frozen/,
  );
  const cancelled = store.mutate(edit(t, {}, "cancel"));
  assert.equal(store.checkpoint(cancelled, "end"), "cancelled");
  assert.throws(
    () => store.mutate(edit(cancelled, { title: "revive" })),
    /task_cancelled/,
  );
});
test("recurrence templates do not create checkpoint jobs", () => {
  const { store } = fixture();
  assert.equal(
    store.mutate(create(undefined, { recurrence: "FREQ=DAILY" })).state,
    "unsupported_recurrence",
  );
  assert.equal(store.all("SELECT * FROM jobs").length, 0);
});
test("report excludes future deadlines from misses and deduplicates creation", () => {
  const { store, time } = fixture();
  store.updateSettings({ ...store.settings(), reportsEnabled: true });
  const t = store.mutate(
    create(undefined, {
      scheduled: "2026-10-06T21:00",
      due: "2026-10-06T23:00",
    }),
  );
  time(at("2026-10-06T14:00Z"));
  const r = store.report("2026-10-06", "evening");
  assert.equal(r.counts.pending, 1);
  assert.equal(r.counts.missed, 0);
  store.ensureReports();
  store.ensureReports();
  assert.equal(store.all("SELECT * FROM reports").length, 2);
});
test("worker retries the same op/content, and metadata edit cannot renotify sent checkpoint", async () => {
  const { store, time } = fixture();
  let t = store.mutate(create());
  store.setConfig("binding", {
    url: "https://gateway.test",
    channelId: "CHANNEL",
    channelName: "test",
    secret: store.encrypt("testpassword"),
  });
  time(t.startOpen!);
  const bodies: string[] = [];
  let calls = 0;
  const send = (async (_url: unknown, opts: RequestInit) => {
    bodies.push(String(opts.body));
    calls++;
    if (calls === 1) throw new Error("network");
    return new Response(
      JSON.stringify({ success: true, data: { message_id: "m" } }),
      { status: 200 },
    );
  }) as typeof fetch;
  const worker = new Worker(store, "token", "https://tasks.test", send);
  await worker.tick();
  time(store.now() + 2000);
  await worker.tick();
  assert.equal(bodies[0], bodies[1]);
  t = store.mutate(edit(t, { priority: "high" }));
  await worker.tick();
  assert.equal(calls, 2);
});
test("cancelled job is not sent", async () => {
  const { store, time } = fixture();
  let t = store.mutate(create());
  t = store.mutate(edit(t, {}, "cancel"));
  time(t.startOpen!);
  let calls = 0;
  await new Worker(store, "token", "https://tasks.test", (async () => {
    calls++;
    return new Response();
  }) as typeof fetch).tick();
  assert.equal(calls, 0);
});
test("database reopening preserves operations and jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tn-restart-")),
    key = randomBytes(32),
    file = join(dir, "test.sqlite");
  const first = new Store(file, key, () => base);
  const m = create();
  first.mutate(m);
  first.db.close();
  const second = new Store(file, key, () => base);
  assert.equal(second.mutate(m).version, 1);
  assert.equal(second.all("SELECT * FROM jobs").length, 2);
  second.db.close();
  await rm(dir, { recursive: true, force: true });
});
test("timezone parses local date-time and rejects DST gaps", () => {
  assert.equal(
    parseTime("2026-10-06T09:00", "Asia/Shanghai"),
    at("2026-10-06T01:00Z"),
  );
  assert.throws(
    () => parseTime("2026-03-08T02:30", "America/New_York"),
    /invalid_local_time/,
  );
});
test("API login, CSRF, media isolation and valid upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tn-api-"));
  let now = base;
  const { app, store } = await makeApp({
    dataDir: dir,
    key: randomBytes(32),
    publicUrl: "http://localhost:8787",
    password: "long-test-password",
    gatewayToken: "test",
    allowedGateways: [],
    allowHttp: true,
    now: () => now,
  });
  try {
    assert.equal(
      (await app.inject({ url: "/tasknotes/v1/instances" })).statusCode,
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/tasknotes/v1/auth/login",
      payload: { password: "long-test-password", client: "plugin" },
    });
    const token = login.json().token,
      headers = { authorization: `Bearer ${token}` };
    const t = store.mutate(create());
    now = t.startOpen!;
    const alloc = await app.inject({
      method: "POST",
      url: `/tasknotes/v1/instances/${t.id}/uploads`,
      headers,
      payload: { kind: "start", version: t.version },
    });
    assert.equal(alloc.statusCode, 200);
    const uploadId = alloc.json().uploadId;
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    assert.equal(
      (
        await app.inject({
          method: "PUT",
          url: `/tasknotes/v1/uploads/${uploadId}`,
          headers: { ...headers, "content-type": "application/octet-stream" },
          payload: image,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/tasknotes/v1/instances/${t.id}/checkins/start`,
          headers,
          payload: { version: t.version, uploadId, submitId: randomUUID() },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: `/tasknotes/v1/media/${uploadId}` })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: `/tasknotes/v1/media/${uploadId}`, headers }))
        .headers["content-type"],
      "image/jpeg",
    );
    const web = await app.inject({
      method: "POST",
      url: "/tasknotes/v1/auth/login",
      headers: { origin: "http://localhost:8787" },
      payload: { password: "long-test-password", client: "web" },
    });
    const c = web.cookies[0]!;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/tasknotes/v1/auth/logout",
          cookies: { [c.name]: c.value },
          headers: { origin: "http://localhost:8787" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("all four mapped severities retain protocol urgency omission", async () => {
  const { store, time } = fixture();
  store.updateSettings({
    ...store.settings(),
    priorityMap: {
      low: "low",
      normal: "normal",
      high: "high",
      urgent: "critical",
    },
  });
  const tasks = ["low", "normal", "high", "urgent"].map((priority) =>
    store.mutate(create(undefined, { priority })),
  );
  store.setConfig("binding", {
    url: "https://gateway.test",
    channelId: "CHANNEL",
    secret: store.encrypt("testpassword"),
  });
  time(tasks[0]!.startOpen!);
  const severities: string[] = [];
  await new Worker(store, "token", "https://tasks.test", (async (
    _url,
    options,
  ) => {
    const payload = JSON.parse(String(options?.body));
    severities.push(payload.severity);
    assert.equal(payload.urgency, undefined);
    return new Response(JSON.stringify({ success: true }));
  }) as typeof fetch).tick();
  assert.deepEqual(severities.sort(), ["critical", "high", "low", "normal"]);
});
test("cross-day task appears in both calendar reports", () => {
  const { store } = fixture();
  store.mutate(
    create(undefined, {
      scheduled: "2026-10-06T23:50",
      due: "2026-10-07T00:20",
    }),
  );
  assert.equal(store.report("2026-10-06", "morning").total, 1);
  assert.equal(store.report("2026-10-07", "morning").total, 1);
});
test("integration token can be individually revoked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tn-token-"));
  const { app } = await makeApp({
    dataDir: dir,
    key: randomBytes(32),
    publicUrl: "http://localhost:8787",
    password: "long-test-password",
    gatewayToken: "test",
    allowedGateways: [],
    allowHttp: true,
  });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/tasknotes/v1/auth/login",
      payload: { password: "long-test-password", client: "plugin" },
    });
    const headers = { authorization: "Bearer " + login.json().token };
    const tokens = (
      await app.inject({ url: "/tasknotes/v1/auth/tokens", headers })
    ).json().tokens;
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: "/tasknotes/v1/auth/tokens/" + tokens[0].id,
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/tasknotes/v1/instances", headers }))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("pending configuration does not freeze an unopened card", () => {
  const { store, time } = fixture();
  let t = store.mutate(create(undefined, { due: null }));
  time(t.startAt! + 60000);
  t = store.mutate(
    edit(t, { scheduled: "2026-10-06T11:00", due: "2026-10-06T12:00" }),
  );
  assert.equal(t.state, "scheduled");
  assert.equal(t.frozen, false);
});
test("completion after opening persists timing freeze and reopening retains active windows", () => {
  const { store, time } = fixture();
  let t = store.mutate(create());
  time(t.startOpen!);
  t = store.mutate(edit(t, { completed: true, status: "done" }));
  assert.equal(t.frozen, true);
  assert.throws(
    () => store.mutate(edit(t, { due: "2026-10-06T12:00" })),
    /window_frozen/,
  );
  t = store.mutate(edit(t, { completed: false, status: "open" }));
  assert.equal(t.state, "scheduled");
  assert.equal(store.checkpoint(t, "start"), "open");
});

test("malformed dates and overflowing calendar days return explicit errors", () => {
  for (const value of [
    "garbage",
    "2026-02-30",
    "2026-02-30T09:00Z",
    "2026-10-06T25:00",
  ])
    assert.throws(() => parseTime(value, "Asia/Shanghai"), /invalid_time/);
});

test("manual completion is counted separately from successful checkpoints", () => {
  const { store, time } = fixture();
  let t = store.mutate(create());
  time(t.startOpen!);
  for (const kind of ["start", "end"] as const) {
    time(kind === "start" ? t.startOpen! : t.endOpen!);
    const upload = store.allocateUpload(t.id, kind, t.version);
    store.run(
      "UPDATE uploads SET state='ready',hash='fake' WHERE id=?",
      upload,
    );
    store.submit(t.id, kind, {
      version: t.version,
      uploadId: upload,
      submitId: randomUUID(),
      note: "",
    });
  }
  t = store.mutate(edit(t, { completed: true, status: "done" }));
  const report = store.report("2026-10-06", "evening");
  assert.equal(report.counts.both, 1);
  assert.equal(report.counts.manual, 1);
});
