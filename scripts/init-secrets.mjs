import { chmod, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
// Compose binds individual secret files. The node user must be able to read them;
// the private parent directory prevents other host users from traversing to them.
await mkdir("secrets", { recursive: true, mode: 0o700 });
await chmod("secrets", 0o700);
for (const [name, value] of [
  ["owner_password", randomBytes(24).toString("base64url")],
  ["encryption_key", randomBytes(32).toString("hex")],
  ["gateway_token", "REPLACE_WITH_EXISTING_GATEWAY_TOKEN"],
]) {
  try {
    await writeFile("secrets/" + name, value + "\n", {
      flag: "wx",
      mode: 0o644,
    });
    console.log("Created secrets/" + name);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    console.log("Kept existing secrets/" + name);
  }
  await chmod("secrets/" + name, 0o644);
}
console.log(
  "Read owner_password locally for login. Replace gateway_token before binding a real channel.",
);
