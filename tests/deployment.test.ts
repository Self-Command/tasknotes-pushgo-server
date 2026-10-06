import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("secret initialization preserves values and keeps a private host directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tn-secrets-test-"));
  const script = resolve("scripts/init-secrets.mjs");
  const run = () =>
    promisify(execFile)(process.execPath, [script], {
      cwd: dir,
      windowsHide: true,
    });
  try {
    await run();
    const names = ["owner_password", "encryption_key", "gateway_token"];
    const first = await Promise.all(
      names.map((name) => readFile(join(dir, "secrets", name), "utf8")),
    );
    assert.ok(first[0]!.trim().length >= 12);
    assert.match(first[1]!.trim(), /^[0-9a-f]{64}$/);
    assert.equal(first[2]!.trim(), "REPLACE_WITH_EXISTING_GATEWAY_TOKEN");
    await run();
    assert.deepEqual(
      await Promise.all(
        names.map((name) => readFile(join(dir, "secrets", name), "utf8")),
      ),
      first,
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(join(dir, "secrets"))).mode & 0o777, 0o700);
      for (const name of names)
        assert.equal(
          (await stat(join(dir, "secrets", name))).mode & 0o777,
          0o644,
        );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
