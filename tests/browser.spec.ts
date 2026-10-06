import { test, expect } from "@playwright/test";
import { makeApp } from "../src/app.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import sharp from "sharp";
let service: Awaited<ReturnType<typeof makeApp>>, dir: string, taskId: string;
test.beforeAll(async () => {
  dir = await mkdtemp(resolve(tmpdir(), "tn-web-"));
  service = await makeApp({
    dataDir: dir,
    publicUrl: "http://127.0.0.1:8789",
    password: "browser-test-password",
    key: randomBytes(32),
    gatewayToken: "fake",
    allowedGateways: [],
    allowHttp: true,
    staticDir: resolve("web-dist"),
  });
  service.store.updateSettings({
    ...service.store.settings(),
    reportsEnabled: false,
  });
  taskId = randomUUID();
  service.store.mutate({
    taskId,
    operationId: randomUUID(),
    baseVersion: 0,
    action: "create",
    origin: "tasknotes_ui",
    changes: {
      title: "浏览器拍照验收",
      scheduled: new Date(Date.now() + 300000).toISOString(),
      due: new Date(Date.now() + 540000).toISOString(),
    },
  });
  await service.app.listen({ port: 8789, host: "127.0.0.1" });
});
test.afterAll(async () => {
  await service.app.close();
  await rm(dir, { recursive: true, force: true });
});
test("private photos, independent end/start check-ins, mobile dark report", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:8789/tasks/" + taskId);
  await page.getByLabel("账号密码").fill("browser-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const photo = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#2563eb" },
  })
    .png()
    .toBuffer();
  const endCard = page
    .locator('[data-slot="card"]')
    .filter({
      has: page.locator('[data-slot="card-title"]', { hasText: "结束打卡" }),
    });
  await endCard
    .locator("input[type=file]")
    .last()
    .setInputFiles({ name: "end.png", mimeType: "image/png", buffer: photo });
  await endCard.getByLabel("打卡备注").fill("独立结束卡");
  await endCard.getByRole("button", { name: "上传照片并打卡" }).click();
  await expect(endCard.getByText("成功时间：", { exact: false })).toBeVisible();
  const startCard = page
    .locator('[data-slot="card"]')
    .filter({
      has: page.locator('[data-slot="card-title"]', { hasText: "开始打卡" }),
    });
  await startCard
    .locator("input[type=file]")
    .first()
    .setInputFiles({ name: "start.png", mimeType: "image/png", buffer: photo });
  await startCard.getByRole("button", { name: "上传照片并打卡" }).click();
  await expect(
    startCard.getByText("成功时间：", { exact: false }),
  ).toBeVisible();
  await expect(page.getByAltText("已提交的打卡照片")).toHaveCount(2);
  await page.screenshot({
    path: "test-results/web-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("link", { name: "晚报", exact: true }).click();
  await expect(page.getByText("双卡成功", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/web-mobile-dark.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  const record = service.store.all("SELECT media_id FROM checkins")[0]!;
  const res = await page.request.get(
    "http://127.0.0.1:8789/tasknotes/v1/media/" + record.media_id,
  );
  expect(res.ok()).toBe(true);
  const unauth = await service.app.inject({
    url: "/tasknotes/v1/media/" + record.media_id,
  });
  expect(unauth.statusCode).toBe(401);
});
