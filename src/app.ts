import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { Store } from "./store.js";
import { Problem, id, hash, settingsSchema } from "./domain.js";

export type AppConfig = {
  dataDir: string;
  publicUrl: string;
  password: string;
  key: Buffer;
  gatewayToken: string;
  allowedGateways: string[];
  allowHttp?: boolean;
  allowHttpGateways?: boolean;
  now?: () => number;
  staticDir?: string;
};
export async function makeApp(config: AppConfig) {
  const publicUrl = new URL(config.publicUrl);
  if (publicUrl.protocol !== "https:" && !config.allowHttp)
    throw new Error(
      "HTTPS public URL required; use ALLOW_HTTP only for development",
    );
  if (config.password.length < 12)
    throw new Error("Set an owner password with at least 12 characters");
  const store = new Store(
    resolve(config.dataDir, "tasknotes.sqlite"),
    config.key,
    config.now,
  );
  mkdirSync(resolve(config.dataDir, "photos"), { recursive: true });
  const keyCheck = store.config<string>("key_check");
  if (keyCheck) {
    if (store.decrypt(keyCheck) !== "tasknotes-pushgo")
      throw new Error("Invalid persisted encryption key");
  } else store.setConfig("key_check", store.encrypt("tasknotes-pushgo"));
  if (!store.config("password")) {
    const salt = randomBytes(16).toString("hex");
    store.setConfig("password", {
      salt,
      hash: scryptSync(config.password, salt, 32).toString("hex"),
    });
  }
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "password",
        "secret",
      ],
    },
    bodyLimit: 15 * 1024 * 1024,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof Problem)
      return reply
        .code(err.status)
        .send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: "validation_error", message: "输入格式不正确" });
    const e = err as Error & { statusCode?: number };
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: "request_rejected" });
    req.log.error({ name: e.name }, "request failed");
    return reply.code(500).send({ error: "internal_error" });
  });
  const prefix = "/tasknotes/v1";
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      );
    if (!req.url.startsWith(prefix)) return;
    const path = req.url.split("?")[0];
    if (path === `${prefix}/healthz`) return;
    const origin = req.headers.origin;
    if (origin && origin !== publicUrl.origin)
      throw new Problem(403, "invalid_origin");
    if (path === `${prefix}/auth/login`) return;
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1],
      token = bearer ?? req.cookies.tn_session;
    if (!token) throw new Problem(401, "unauthorized");
    const row = store.get("SELECT * FROM tokens WHERE hash=?", hash(token));
    if (!row || Number(row.expires) <= store.now())
      throw new Problem(401, "unauthorized");
    if (bearer && row.kind !== "plugin")
      throw new Problem(401, "invalid_token_kind");
    if (!bearer && row.kind !== "web")
      throw new Problem(401, "invalid_token_kind");
    if (!bearer && !["GET", "HEAD"].includes(req.method)) {
      if (
        origin !== publicUrl.origin ||
        req.headers["x-csrf-token"] !== row.csrf
      )
        throw new Problem(403, "csrf_rejected");
    }
    reply.header("Cache-Control", "no-store");
  });
  app.get(`${prefix}/healthz`, () => ({ status: "ok" }));
  app.post(
    `${prefix}/auth/login`,
    { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({
          password: z.string().max(512),
          client: z.enum(["plugin", "web"]),
        })
        .strict()
        .parse(req.body);
      const saved = store.config<{ salt: string; hash: string }>("password")!;
      if (
        !timingSafeEqual(
          scryptSync(body.password, saved.salt, 32),
          Buffer.from(saved.hash, "hex"),
        )
      )
        throw new Problem(401, "invalid_credentials");
      if (body.client === "web" && req.headers.origin !== publicUrl.origin)
        throw new Problem(403, "invalid_origin");
      const token = randomBytes(32).toString("hex"),
        csrf = randomBytes(24).toString("hex");
      store.run(
        "INSERT INTO tokens VALUES(?,?,?,?)",
        hash(token),
        body.client,
        csrf,
        store.now() + (body.client === "plugin" ? 180 : 30) * 86400000,
      );
      if (body.client === "web") {
        reply.setCookie("tn_session", token, {
          httpOnly: true,
          secure: publicUrl.protocol === "https:",
          sameSite: "strict",
          path: "/",
          maxAge: 30 * 86400,
        });
        return { csrf };
      }
      return { token, workspaceId: "owner" };
    },
  );
  app.get(`${prefix}/auth/tokens`, () => ({
    tokens: store.all(
      "SELECT hash AS id,kind,expires FROM tokens WHERE expires>?",
      store.now(),
    ),
  }));
  app.delete(`${prefix}/auth/tokens/:tokenId`, (req) => {
    const tokenId = (req.params as { tokenId: string }).tokenId;
    if (!/^[a-f0-9]{64}$/.test(tokenId))
      throw new Problem(400, "invalid_token_id");
    store.run("DELETE FROM tokens WHERE hash=?", tokenId);
    return { ok: true };
  });
  app.get(`${prefix}/auth/session`, (req) => {
    const row = store.get(
      "SELECT csrf FROM tokens WHERE hash=?",
      hash(req.headers.authorization?.slice(7) ?? req.cookies.tn_session ?? ""),
    );
    return { csrf: row?.csrf, workspaceId: "owner" };
  });
  app.post(`${prefix}/auth/logout`, (req, reply) => {
    store.run(
      "DELETE FROM tokens WHERE hash=?",
      hash(req.headers.authorization?.slice(7) ?? req.cookies.tn_session ?? ""),
    );
    reply.clearCookie("tn_session", { path: "/" });
    return { ok: true };
  });
  app.get(`${prefix}/settings`, () => store.settings());
  app.put(`${prefix}/settings`, (req) => store.updateSettings(req.body));
  app.get(`${prefix}/integrations/pushgo`, () => {
    const b = store.config<Record<string, string>>("binding");
    return b
      ? {
          url: b.url,
          channelId: b.channelId,
          channelName: b.channelName,
          configured: true,
        }
      : { configured: false };
  });
  app.put(`${prefix}/integrations/pushgo`, async (req) => {
    const b = z
      .object({
        url: z.url(),
        channelId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i),
        channelName: z.string().min(1).max(128),
        password: z.string().min(8).max(128),
      })
      .strict()
      .parse(req.body);
    const url = new URL(b.url);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !config.allowedGateways.some((u) => new URL(u).origin === url.origin)
    )
      throw new Problem(400, "gateway_not_allowed");
    if (
      url.protocol !== "https:" &&
      !config.allowHttp &&
      !config.allowHttpGateways
    )
      throw new Problem(400, "https_required");
    const res = await fetch(
      `${b.url.replace(/\/$/, "")}/channel/exists?channel_id=${encodeURIComponent(b.channelId)}`,
      {
        headers: { Authorization: `Bearer ${config.gatewayToken}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) throw new Problem(400, "gateway_unavailable");
    const value = (await res.json()) as {
      data?: { exists?: boolean; channel_name?: string };
    };
    if (!value.data?.exists) throw new Problem(400, "channel_not_found");
    const existingBinding = store.config<{ channelId: string; url: string }>(
      "binding",
    );
    if (
      existingBinding &&
      (existingBinding.channelId !== b.channelId ||
        existingBinding.url !== b.url.replace(/\/$/, "")) &&
      store.get(
        "SELECT id FROM jobs WHERE state='sending' OR (state='pending' AND payload IS NOT NULL) LIMIT 1",
      )
    )
      throw new Problem(409, "delivery_in_progress");
    store.setConfig("binding", {
      url: b.url.replace(/\/$/, ""),
      channelId: b.channelId,
      channelName: value.data.channel_name ?? b.channelName,
      secret: store.encrypt(b.password),
    });
    store.audit("binding", null, { channelId: b.channelId });
    return { ok: true };
  });
  app.post(`${prefix}/integrations/pushgo/test`, async () => {
    const b = store.config<Record<string, string>>("binding");
    if (!b) throw new Problem(400, "binding_required");
    const res = await fetch(`${b.url}/message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.gatewayToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: b.channelId,
        password: store.decrypt(b.secret!),
        op_id: "tn_test_" + id(),
        title: "TaskNotes 连接测试",
        body: "网关发送凭据检测成功。",
        severity: "normal",
        ttl: store.now() + 300000,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Problem(400, "gateway_rejected");
    const result = (await res.json()) as { success?: boolean };
    if (result.success !== true) throw new Problem(400, "gateway_rejected");
    return { ok: true };
  });
  app.post(`${prefix}/workspaces/:workspace/mutations`, (req) => {
    if ((req.params as { workspace: string }).workspace !== "owner")
      throw new Problem(403, "workspace_forbidden");
    return store.mutate(req.body);
  });
  app.get(`${prefix}/workspaces/:workspace/sync`, (req) => {
    if ((req.params as { workspace: string }).workspace !== "owner")
      throw new Problem(403, "workspace_forbidden");
    const cursor = z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .parse((req.query as { cursor?: string }).cursor);
    const rows = store.all(
      "SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT 200",
      cursor,
    );
    return {
      cursor: rows.length ? rows.at(-1)!.seq : cursor,
      hasMore: rows.length === 200,
      changes: rows.map((r) => ({
        seq: r.seq,
        kind: r.kind,
        data: JSON.parse(String(r.payload)),
      })),
      serverTime: store.now(),
    };
  });
  app.get(`${prefix}/instances`, () => ({
    tasks: store.tasks().map((t) => store.view(t)),
    serverTime: store.now(),
  }));
  app.get(`${prefix}/instances/:id`, (req) =>
    store.view(store.task((req.params as { id: string }).id)),
  );
  app.post(`${prefix}/instances/:id/uploads`, (req) => {
    const b = z
      .object({ kind: z.enum(["start", "end"]), version: z.number().int() })
      .strict()
      .parse(req.body);
    return {
      uploadId: store.allocateUpload(
        (req.params as { id: string }).id,
        b.kind,
        b.version,
      ),
    };
  });
  app.put(`${prefix}/uploads/:id`, async (req) => {
    const uploadId = z.uuid().parse((req.params as { id: string }).id),
      u = store.get("SELECT * FROM uploads WHERE id=?", uploadId);
    if (!u || u.state !== "pending" || Number(u.expires) <= store.now())
      throw new Problem(400, "invalid_upload");
    if (!Buffer.isBuffer(req.body)) throw new Problem(400, "invalid_photo");
    let photo: Buffer;
    try {
      photo = await sharp(req.body, {
        limitInputPixels: 24_000_000,
        failOn: "error",
      })
        .rotate()
        .resize({
          width: 1920,
          height: 1920,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch {
      throw new Problem(400, "invalid_photo");
    }
    const path = resolve(config.dataDir, "photos", `${uploadId}.jpg`);
    await writeFile(path, photo, { flag: "wx" });
    const updated = store.run(
      "UPDATE uploads SET state='ready',path=?,hash=? WHERE id=? AND state='pending' AND expires>?",
      path,
      hash(photo),
      uploadId,
      store.now(),
    );
    if (!updated.changes) {
      await unlink(path);
      throw new Problem(400, "upload_expired");
    }
    return { mediaId: uploadId, hash: hash(photo) };
  });
  app.post(`${prefix}/instances/:id/checkins/:kind`, (req) => {
    const p = z
      .object({ id: z.uuid(), kind: z.enum(["start", "end"]) })
      .parse(req.params);
    const b = z
      .object({
        version: z.number().int(),
        uploadId: z.uuid(),
        submitId: z.uuid(),
        note: z.string().max(1000).default(""),
      })
      .strict()
      .parse(req.body);
    return store.submit(p.id, p.kind, b);
  });
  app.get(`${prefix}/media/:id`, async (req, reply) => {
    const mediaId = z.uuid().parse((req.params as { id: string }).id);
    const row = store.get(
      "SELECT * FROM uploads WHERE id=? AND state='linked'",
      mediaId,
    );
    if (!row?.path || !existsSync(String(row.path)))
      throw new Problem(410, "media_removed");
    reply.type("image/jpeg").header("X-Media-Sha256", String(row.hash));
    return reply.send(await readFile(String(row.path)));
  });
  app.get(`${prefix}/reports/:date`, (req) => {
    const date = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .parse((req.params as { date: string }).date),
      q = req.query as { type?: string; live?: string };
    const kind = z
      .enum(["morning", "evening"])
      .default("morning")
      .parse(q.type);
    const row = store.get(
      "SELECT payload FROM reports WHERE date=? AND kind=?",
      date,
      kind,
    );
    return q.live === "true" || !row
      ? store.report(date, kind)
      : JSON.parse(String(row.payload));
  });
  app.get(`${prefix}/operations/status`, () => ({
    jobs: store.all(
      "SELECT id,task_id,kind,state,attempts,error FROM jobs ORDER BY run_at DESC LIMIT 100",
    ),
    audit: store.all("SELECT * FROM audit ORDER BY id DESC LIMIT 100"),
  }));
  if (config.staticDir && existsSync(config.staticDir)) {
    await app.register(staticFiles, { root: resolve(config.staticDir) });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith(prefix)
        ? reply.code(404).send({ error: "not_found" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", () => {
    store.db.close();
  });
  return { app, store };
}
