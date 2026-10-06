import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeApp } from "./app.js";
import { Worker } from "./worker.js";
function secret(name: string) {
  const file = process.env[`${name}_FILE`];
  return file ? readFileSync(file, "utf8").trim() : (process.env[name] ?? "");
}
const config = {
  dataDir: process.env.DATA_DIR ?? "data",
  publicUrl: (process.env.PUBLIC_URL ?? "https://tasks.example.com").replace(
    /\/$/,
    "",
  ),
  password: secret("OWNER_PASSWORD"),
  key: Buffer.from(secret("ENCRYPTION_KEY"), "hex"),
  gatewayToken: secret("GATEWAY_TOKEN"),
  allowedGateways: (process.env.ALLOWED_GATEWAYS ?? "")
    .split(",")
    .filter(Boolean),
  allowHttp: process.env.ALLOW_HTTP === "true",
  allowHttpGateways: process.env.ALLOW_HTTP_GATEWAYS === "true",
  staticDir: resolve("web-dist"),
};
const { app, store } = await makeApp(config);
const worker = new Worker(store, config.gatewayToken, config.publicUrl);
const timer = setInterval(
  () => void worker.tick().catch(() => app.log.error("scheduler_tick_failed")),
  1000,
);
timer.unref();
app.addHook("preClose", async () => {
  clearInterval(timer);
  await worker.stop();
});
await app.listen({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void app.close());
