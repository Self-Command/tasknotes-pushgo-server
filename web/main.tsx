import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "./components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Textarea } from "./components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "./components/ui/alert";
import { Skeleton } from "./components/ui/skeleton";
import "./style.css";

type Task = {
  id: string;
  instanceId: string;
  version: number;
  cancelled: boolean;
  state: string;
  startAt: number | null;
  endAt: number | null;
  startOpen: number | null;
  endOpen: number | null;
  serverTime: number;
  plan: {
    title: string;
    timezone: string;
    priority: string;
    completed: boolean;
  };
  checkpoints: { start: string; end: string };
  checkins: {
    id: string;
    kind: string;
    at: number;
    media_id: string;
    note: string;
  }[];
};
type Report = {
  date: string;
  kind: string;
  timezone: string;
  generatedAt: number;
  total: number;
  cancelled: number;
  counts: Record<string, number>;
  tasks: Task[];
};
let csrf = "";
const messages: Record<string, string> = {
  unauthorized: "请先登录",
  invalid_credentials: "密码不正确",
  deadline_passed: "已超过截止时间，不能打卡",
  not_open: "打卡窗口尚未开放",
  version_conflict: "任务已更新，请刷新后重试",
  window_frozen: "打卡窗口已经开放，无法修改时间",
  invalid_photo: "无法读取图片，请使用 JPEG/PNG/WebP 等受支持格式",
  invalid_upload: "照片上传已失效，请重新上传",
  gateway_not_allowed: "该网关不在部署允许的地址列表中",
  gateway_rejected: "网关拒绝请求，请检查频道和密码",
  channel_not_found: "频道 ID 不存在",
  media_removed: "照片已按保留策略清理",
  cancelled: "任务已取消",
  submitted: "这张卡已成功提交",
};
async function api<T>(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(`/tasknotes/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      messages[value.error] ?? value.message ?? value.error ?? "请求失败",
    );
  return value;
}
function Field({
  title,
  ...props
}: { title: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-2">
      <Label>{title}</Label>
      <Input aria-label={title} {...props} />
    </div>
  );
}
function Feedback({ text }: { text: string }) {
  return text ? (
    <Alert>
      <AlertTitle>操作提示</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  ) : null;
}
function time(at: number | null, zone = "Asia/Shanghai") {
  return at === null
    ? "未配置"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: zone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(at);
}
function TaskCard({ task }: { task: Task }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>{task.plan.title}</CardTitle>
          <Badge variant="secondary">{task.plan.priority}</Badge>
        </div>
        <CardDescription>
          {time(task.startAt, task.plan.timezone)} —{" "}
          {time(task.endAt, task.plan.timezone)} · {task.plan.timezone}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            开始：{stateText(task.checkpoints.start)} · 结束：
            {stateText(task.checkpoints.end)}
          </p>
          <Button asChild size="sm" variant="outline">
            <a href={`/tasks/${task.id}`}>查看任务</a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
function stateText(s: string) {
  return (
    (
      {
        submitted: "已打卡",
        open: "可打卡",
        not_open: "未开放",
        missed: "已漏打",
        cancelled: "已取消",
        unconfigured: "待配置",
      } as Record<string, string>
    )[s] ?? s
  );
}
function CheckinCard({
  task,
  kind,
  refresh,
}: {
  task: Task;
  kind: "start" | "end";
  refresh: () => void;
}) {
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  useEffect(() => setReceivedAt(Date.now()), [task.serverTime]);
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const close = kind === "start" ? task.startAt : task.endAt,
    open = kind === "start" ? task.startOpen : task.endOpen;
  const now = task.serverTime + clock - receivedAt;
  const state = task.checkpoints[kind] === "open" && close !== null && now >= close ? "missed" : task.checkpoints[kind];
  const can = state === "open" && close !== null && now < close;
  const record = task.checkins.find((r) => r.kind === kind);
  async function submit() {
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      const { uploadId } = await api<{ uploadId: string }>(
        `/instances/${task.id}/uploads`,
        { kind, version: task.version },
      );
      const res = await fetch(`/tasknotes/v1/uploads/${uploadId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-CSRF-Token": csrf,
        },
        body: file,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(messages[e.error] ?? "照片上传失败");
      }
      const submitId = crypto.randomUUID();
      const payload = { version: task.version, uploadId, submitId, note };
      let completed = false;
      let error: unknown;
      for (let i = 0; i < 2 && !completed; i++) {
        try {
          await api(`/instances/${task.id}/checkins/${kind}`, payload);
          completed = true;
        } catch (e) {
          error = e;
        }
      }
      if (!completed) throw error;
      setMessage("打卡成功，记录已保存。打开 Obsidian 后可自动同步照片。");
      setFile(null);
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "提交失败");
      refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between gap-3">
          <CardTitle>{kind === "start" ? "开始打卡" : "结束打卡"}</CardTitle>
          <Badge variant={state === "submitted" ? "default" : "secondary"}>
            {stateText(state)}
          </Badge>
        </div>
        <CardDescription>
          {time(open, task.plan.timezone)} 开放 ·{" "}
          {time(close, task.plan.timezone)} 截止
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {can && close && (
          <p className="text-sm font-medium">
            距离截止 {Math.max(0, Math.ceil((close - now) / 60000))}{" "}
            分钟。照片上传后仍须在截止前提交。
          </p>
        )}
        {record ? (
          <>
            <p className="text-sm">
              成功时间：{time(record.at, task.plan.timezone)}
            </p>
            <img
              className="max-h-80 w-full rounded-xl object-contain"
              src={`/tasknotes/v1/media/${record.media_id}`}
              alt="已提交的打卡照片"
              onError={(e) => {
                e.currentTarget.hidden = true;
                setMessage(
                  "照片无法加载或已按保留策略清理，打卡记录仍然有效。",
                );
              }}
            />
            {record.note && <p>{record.note}</p>}
          </>
        ) : (
          <>
            {can && (
              <>
                <div className="flex flex-wrap gap-3">
                  <Label className="photo-picker">
                    拍照
                    <Input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      disabled={busy}
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  </Label>
                  <Label className="photo-picker">
                    选择相册照片
                    <Input
                      type="file"
                      accept="image/*"
                      disabled={busy}
                      onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    />
                  </Label>
                </div>
                {preview && (
                  <img
                    className="max-h-80 w-full rounded-xl object-contain"
                    src={preview}
                    alt="提交前预览"
                  />
                )}
                <Textarea
                  aria-label="打卡备注"
                  placeholder="备注（可选）"
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <Button
                  className="w-full"
                  disabled={!file || busy}
                  onClick={() => void submit()}
                >
                  {busy ? "上传并提交中…" : "上传照片并打卡"}
                </Button>
              </>
            )}
            {!can && (
              <p className="text-sm text-muted-foreground">
                {state === "missed" || (close !== null && now >= close)
                  ? "已到截止时间，无法补卡。"
                  : state === "cancelled"
                    ? "该任务已取消。"
                    : "请在开放窗口内返回打卡。"}
              </p>
            )}
          </>
        )}
        <Feedback text={message} />
      </CardContent>
    </Card>
  );
}
function Detail({ id }: { id: string }) {
  const [task, setTask] = useState<Task | null>(null),
    [error, setError] = useState("");
  const refresh = () =>
    void api<Task>(`/instances/${id}`)
      .then(setTask)
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [id]);
  if (error) return <Feedback text={error} />;
  if (!task) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-5">
      <TaskCard task={task} />
      <div className="grid gap-5 md:grid-cols-2">
        <CheckinCard task={task} kind="start" refresh={refresh} />
        <CheckinCard task={task} kind="end" refresh={refresh} />
      </div>
      <p className="text-sm text-muted-foreground">
        开始与结束卡独立。截止时间由服务器校验，修改手机时间不会延长窗口。
      </p>
    </div>
  );
}
function Reports({ date, type }: { date: string; type: string }) {
  const [report, setReport] = useState<Report | null>(null),
    [live, setLive] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api<Report>(`/reports/${date}?type=${type}&live=${live}`)
      .then(setReport)
      .catch((e) => setError(e.message));
  }, [date, type, live]);
  if (error) return <Feedback text={error} />;
  if (!report) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>
            {type === "morning" ? "今日安排" : "打卡晚报"} · {report.date}
          </CardTitle>
          <CardDescription>
            {live ? "实时结果" : "生成时快照"} · {report.timezone} ·{" "}
            {time(report.generatedAt, report.timezone)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries({
              需执行: report.total,
              双卡成功: report.counts.both,
              仅开始: report.counts.startOnly,
              仅结束: report.counts.endOnly,
              漏打: report.counts.missed,
              未截止: report.counts.pending,
              手动完成: report.counts.manual,
              已取消: report.cancelled,
            }).map(([label, value]) => (
              <div className="stat" key={label}>
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-semibold">{value}</p>
              </div>
            ))}
          </div>
          <Button variant="outline" onClick={() => setLive(!live)}>
            {live ? "查看发送时快照" : "查看实时结果"}
          </Button>
        </CardContent>
      </Card>
      {report.tasks.length ? (
        report.tasks.map((t) => <TaskCard key={t.id} task={t} />)
      ) : (
        <Card>
          <CardContent>今日没有已接入的定时任务。</CardContent>
        </Card>
      )}
    </div>
  );
}
function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(
      null,
    ),
    [binding, setBinding] = useState({
      url: "",
      channelId: "",
      channelName: "",
      password: "",
    }),
    [message, setMessage] = useState("");
  useEffect(() => {
    void api<Record<string, unknown>>("/settings").then(setSettings);
    void api<typeof binding>("/integrations/pushgo").then((b) =>
      setBinding({ ...binding, ...b, password: "" }),
    );
  }, []);
  async function save() {
    try {
      await api("/settings", settings, "PUT");
      setMessage("默认值已保存；未开放计划已更新，已开放实例保持原窗口。");
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  if (!settings) return <Skeleton className="h-64 w-full" />;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>提醒与统计</CardTitle>
          <CardDescription>调整默认值会更新尚未开放的计划。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ["startLeadMinutes", "开始提前分钟", "number"],
              ["endLeadMinutes", "结束提前分钟", "number"],
              ["timezone", "统计时区", "text"],
              ["morningTime", "早报时间", "time"],
              ["eveningTime", "晚报时间", "time"],
              ["retentionDays", "照片保留天数", "number"],
            ] as const
          ).map(([key, title, type]) => (
            <Field
              key={key}
              title={title}
              type={type}
              value={String(settings[key] ?? "")}
              min={1}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  [key]:
                    type === "number" ? Number(e.target.value) : e.target.value,
                })
              }
            />
          ))}
          <Button onClick={() => void save()}>保存默认值</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>PushGo 频道</CardTitle>
          <CardDescription>
            频道密码只提交到服务端，不会回显。网关地址必须在部署允许列表中。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(["url", "channelName", "channelId", "password"] as const).map(
            (key) => (
              <Field
                key={key}
                title={
                  {
                    url: "API 网关地址",
                    channelName: "频道名称",
                    channelId: "频道 ID",
                    password: "频道密码",
                  }[key]
                }
                type={key === "password" ? "password" : "text"}
                value={binding[key]}
                onChange={(e) =>
                  setBinding({ ...binding, [key]: e.target.value })
                }
              />
            ),
          )}
          <div className="flex gap-3">
            <Button
              onClick={() =>
                void api("/integrations/pushgo", binding, "PUT")
                  .then(() => {
                    setBinding({ ...binding, password: "" });
                    setMessage("频道已绑定，请发送测试通知验证密码。");
                  })
                  .catch((e) => setMessage(e.message))
              }
            >
              保存频道
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void api("/integrations/pushgo/test", {})
                  .then(() => setMessage("测试消息已提交网关，请检查手机。"))
                  .catch((e) => setMessage(e.message))
              }
            >
              发送测试
            </Button>
          </div>
        </CardContent>
      </Card>
      <Feedback text={message} />
    </div>
  );
}
function App() {
  const [logged, setLogged] = useState(false),
    [ready, setReady] = useState(false),
    [password, setPassword] = useState(""),
    [message, setMessage] = useState(""),
    [tasks, setTasks] = useState<Task[]>([]),
    [timezone, setTimezone] = useState("Asia/Shanghai");
  useEffect(() => {
    void api<{ csrf: string }>("/auth/session")
      .then((s) => {
        csrf = s.csrf;
        setLogged(true);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    if (logged)
      void api<{ timezone: string }>("/settings").then((s) =>
        setTimezone(s.timezone),
      );
  }, [logged]);
  useEffect(() => {
    if (logged)
      void api<{ tasks: Task[] }>("/instances")
        .then((v) => setTasks(v.tasks))
        .catch((e) => setMessage(e.message));
  }, [logged]);
  async function login() {
    try {
      const v = await api<{ csrf: string }>("/auth/login", {
        password,
        client: "web",
      });
      csrf = v.csrf;
      setPassword("");
      setLogged(true);
      setMessage("");
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  const path = window.location.pathname;
  const match = path.match(/^\/tasks\/([a-f0-9-]+)$/),
    report = path.match(/^\/reports\/(\d{4}-\d{2}-\d{2})$/);
  const type =
    new URLSearchParams(location.search).get("type") === "evening"
      ? "evening"
      : "morning";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex items-center justify-between gap-4">
        <a href="/" className="text-xl font-semibold tracking-tight">
          TaskNotes <span className="text-muted-foreground">× PushGo</span>
        </a>
        {logged && (
          <nav className="flex flex-wrap gap-2">
            <Button variant="ghost" asChild>
              <a href={`/reports/${today}?type=morning`}>今日安排</a>
            </Button>
            <Button variant="ghost" asChild>
              <a href={`/reports/${today}?type=evening`}>晚报</a>
            </Button>
            <Button variant="ghost" asChild>
              <a href="/settings">设置</a>
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                void api("/auth/logout", {}).then(() => {
                  setLogged(false);
                  csrf = "";
                })
              }
            >
              退出
            </Button>
          </nav>
        )}
      </header>
      {!ready ? (
        <Skeleton className="h-64 w-full" />
      ) : !logged ? (
        <Card className="mx-auto max-w-sm">
          <CardHeader>
            <CardTitle>登录任务服务</CardTitle>
            <CardDescription>照片和打卡记录仅对你的账号开放。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void login();
              }}
              className="space-y-4"
            >
              <Field
                title="账号密码"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <Button className="w-full" type="submit">
                登录
              </Button>
            </form>
            <Feedback text={message} />
          </CardContent>
        </Card>
      ) : match ? (
        <Detail id={match[1]!} />
      ) : report ? (
        <Reports date={report[1]!} type={type} />
      ) : path === "/settings" ? (
        <SettingsPage />
      ) : (
        <div className="space-y-5">
          <div>
            <h1 className="text-2xl font-semibold">已接入任务</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              服务器保存的计划 · 修改请通过 TaskNotes 界面提交
            </p>
          </div>
          {tasks.length ? (
            tasks.map((t) => <TaskCard key={t.id} task={t} />)
          ) : (
            <Card>
              <CardContent>
                暂无任务。请先在 Obsidian 配置服务并创建任务。
              </CardContent>
            </Card>
          )}
          <Feedback text={message} />
        </div>
      )}
      <footer className="mt-10 text-xs text-muted-foreground">
        到开始/结束时间立即关闭打卡，不提供超时补卡。
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
