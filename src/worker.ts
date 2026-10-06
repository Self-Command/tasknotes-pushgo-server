import { unlink } from "node:fs/promises";
import { Store } from "./store.js";
import { canonical, zonedParts } from "./domain.js";

export class Worker {
  private running = false;
  private stopping = false;
  private drained: (() => void)[] = [];
  async stop() {
    this.stopping = true;
    if (this.running)
      await new Promise<void>((resolve) => this.drained.push(resolve));
  }
  constructor(
    private store: Store,
    private gatewayToken: string,
    private publicUrl: string,
    private send: typeof fetch = fetch,
  ) {}
  async tick() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      this.store.ensureReports();
      const now = this.store.now();
      this.store.run(
        "UPDATE jobs SET state='expired' WHERE deadline<=? AND state NOT IN ('sent','cancelled','expired')",
        now,
      );
      const rows = this.store.all(
        "SELECT * FROM jobs WHERE (state='pending' AND run_at<=?) OR (state='sending' AND lease_until<=?) ORDER BY run_at LIMIT 20",
        now,
        now,
      );
      for (const row of rows) {
        const claimed = this.store.run(
          "UPDATE jobs SET state='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND (state='pending' OR (state='sending' AND lease_until<=?))",
          this.store.now() + 30000,
          row.id!,
          this.store.now(),
        );
        if (!claimed.changes) continue;
        try {
          const binding = this.store.config<Record<string, string>>("binding");
          if (!binding) throw new Error("binding_required");
          let payload: Record<string, unknown>;
          if (row.task_id) {
            const task = this.store.task(String(row.task_id));
            const kind = row.kind as "start" | "end";
            if (
              task.cancelled ||
              task.generation !== Number(row.generation) ||
              this.store.checkpoint(task, kind) !== "open"
            ) {
              this.store.run(
                "UPDATE jobs SET state='cancelled' WHERE id=?",
                row.id!,
              );
              continue;
            }
            const s = this.store.settings(),
              format = (at: number) => {
                const v = zonedParts(at, task.plan.timezone);
                return `${v.date} ${v.time}`;
              };
            payload = {
              channel_id: binding.channelId,
              password: this.store.decrypt(binding.secret!),
              op_id: row.id,
              title: `${kind === "start" ? "开始" : "结束"}打卡 · ${task.plan.title}`,
              body: `任务 ${format(task.startAt!)}–${format(task.endAt!)}。${kind === "start" ? "开始" : "结束"}卡截止 ${format(Number(row.deadline))}（${task.plan.timezone}）。请打开页面拍照提交。`,
              severity: s.priorityMap[task.plan.priority] ?? "normal",
              ttl: Number(row.deadline),
              url: `${this.publicUrl}/tasks/${task.id}?checkpoint=${kind}`,
              tags: ["TaskNotes", kind === "start" ? "开始打卡" : "结束打卡"],
              metadata: {
                tasknotes_action: "checkin",
                tasknotes_checkpoint: kind,
              },
            };
          } else {
            const reportRow = this.store.get(
              "SELECT payload FROM reports WHERE id=?",
              row.id!,
            );
            if (!reportRow) throw new Error("report_missing");
            const report = JSON.parse(String(reportRow.payload));
            const s = this.store.settings();
            const isMorning = row.kind === "morning";
            const lines = report.tasks
              .filter(
                (t: { cancelled: boolean; plan: { archived?: boolean } }) =>
                  !t.cancelled && !t.plan.archived,
              )
              .slice(0, 5)
              .map(
                (t: {
                  plan: { title: string };
                  startAt: number;
                  endAt: number;
                }) =>
                  `${zonedParts(t.startAt, s.timezone).time}–${zonedParts(t.endAt, s.timezone).time} ${t.plan.title}`,
              );
            const c = report.counts;
            payload = {
              channel_id: binding.channelId,
              password: this.store.decrypt(binding.secret!),
              op_id: row.id,
              title: `${isMorning ? "今日安排" : "打卡晚报"} · ${report.total} 项`,
              body: isMorning
                ? lines.join("\n") || "今日无安排"
                : `双卡成功 ${c.both}，仅开始 ${c.startOnly}，仅结束 ${c.endOnly}，双卡漏打 ${c.missed}，未截止 ${c.pending}，手动完成 ${c.manual}。`,
              severity: s.reportSeverity,
              ttl: Number(row.deadline),
              url: `${this.publicUrl}/reports/${report.date}?type=${row.kind}`,
              tags: ["TaskNotes", isMorning ? "早报" : "晚报"],
            };
          }
          if (row.payload) payload = JSON.parse(String(row.payload));
          else {
            const safe = { ...payload };
            delete safe.password;
            this.store.run(
              "UPDATE jobs SET payload=? WHERE id=?",
              JSON.stringify(safe),
              row.id!,
            );
          }
          payload.password = this.store.decrypt(binding.secret!);
          payload.channel_id = binding.channelId;
          // Recheck version and absolute deadline immediately before network submission.
          if (this.store.now() >= Number(row.deadline)) {
            this.store.run(
              "UPDATE jobs SET state='expired' WHERE id=?",
              row.id!,
            );
            continue;
          }
          if (
            row.task_id &&
            this.store.task(String(row.task_id)).generation !==
              Number(row.generation)
          ) {
            this.store.run(
              "UPDATE jobs SET state='cancelled' WHERE id=?",
              row.id!,
            );
            continue;
          }
          const res = await this.send(`${binding.url}/message`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.gatewayToken}`,
              "Content-Type": "application/json",
            },
            body: canonical(payload),
            signal: AbortSignal.timeout(10000),
          });
          if (!res.ok) throw new Error(`gateway_http_${res.status}`);
          const ack = (await res.json()) as {
            success?: boolean;
            data?: { message_id?: string };
          };
          if (ack.success !== true) throw new Error("gateway_rejected");
          this.store.run(
            "UPDATE jobs SET state='sent',message_id=?,error=NULL WHERE id=?",
            ack.data?.message_id ?? null,
            row.id!,
          );
          this.store.audit(
            "push_sent",
            row.task_id ? String(row.task_id) : null,
            { opId: row.id, messageId: ack.data?.message_id },
          );
        } catch (err) {
          const code =
            err instanceof Error &&
            /^(binding_required|report_missing|gateway_http_\d+|gateway_rejected)$/.test(
              err.message,
            )
              ? err.message
              : "network_error";
          const retry =
            this.store.now() +
            Math.min(60000, 1000 * 2 ** Math.min(Number(row.attempts), 6));
          this.store.run(
            "UPDATE jobs SET state=CASE WHEN deadline<=? THEN 'expired' ELSE 'pending' END,run_at=?,error=? WHERE id=? AND state='sending'",
            retry,
            retry,
            code,
            row.id!,
          );
        }
      }
      for (const u of this.store.all(
        "SELECT id,path FROM uploads WHERE state!='linked' AND expires<=?",
        this.store.now(),
      )) {
        if (u.path) await unlink(String(u.path)).catch(() => {});
        this.store.run(
          "UPDATE uploads SET state='expired',path=NULL WHERE id=?",
          u.id!,
        );
      }
      const before =
        this.store.now() - this.store.settings().retentionDays * 86400000;
      for (const u of this.store.all(
        "SELECT u.id,u.path FROM uploads u JOIN checkins c ON c.media_id=u.id WHERE c.at<? AND u.path IS NOT NULL",
        before,
      )) {
        await unlink(String(u.path)).catch(() => {});
        this.store.run("UPDATE uploads SET path=NULL WHERE id=?", u.id!);
      }
      this.store.run("DELETE FROM tokens WHERE expires<=?", this.store.now());
    } finally {
      this.running = false;
      for (const resolve of this.drained.splice(0)) resolve();
    }
  }
}
