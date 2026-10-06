# TaskNotes × PushGo 业务服务

Node.js 24、Fastify 5、SQLite 和 React/shadcn/ui 的单账号任务提醒与拍照打卡服务。PushGo Gateway 继续负责投递，HMS 传输 urgency 保持 NORMAL。插件官方基线为 callumalpass/tasknotes 的 69535cd956d11474b980deef8429ff0be232185f；插件 ID 保持 tasknotes。

## 快速部署

1. 安装 Docker Compose v2，复制本目录至服务器。
2. `cp .env.example .env`，填写公网 HTTPS 的 PUBLIC_URL 和对应 TASKNOTES_DOMAIN，以及现有网关的 ALLOWED_GATEWAYS。地址是允许列表，插件不能绑定其他网关。
3. `node scripts/init-secrets.mjs` 生成独立账号密码和加密密钥。在本地读取 secrets/owner_password 登录，把现有 Gateway token 写入 secrets/gateway_token。它们不提交到 Git，也不进入镜像。没有 Node.js 的服务器可以先加载镜像，再执行 `docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/setup" -w /setup --entrypoint node tasknotes-pushgo:0.1.0 scripts/init-secrets.mjs`。
4. `docker compose build`；已有镜像包可先执行 `docker load -i tasknotes-pushgo-0.1.0-image.tar.gz`。交付的预构建镜像为 Linux amd64，ARM64 服务器请从源码构建。
5. 已有反向代理：`docker compose up -d server`，并代理至本机 8787。让 Caddy 管理公网证书：域名指向服务器、开放 80/443 后执行 `docker compose --profile https up -d`。
6. 在插件“定时通知与拍照打卡”中填业务地址，启用并配对，再保存默认值、网关地址、频道 ID/名称/密码，点击发送测试。
7. 在新版 Android PushGo 设置中填同一个业务 HTTPS 域名，通知才显示“去打卡”。打开网页后用独立服务账号密码登录。

PUBLIC_URL 不能含路径；TLS 在反向代理终止。公网业务地址必须是 HTTPS。若现有网关在受控内网使用 HTTP，需要设置 ALLOW_HTTP_GATEWAYS=true；该开关不放宽拍照页面 HTTPS 要求。

初始化脚本使用 secrets/ 目录权限 0700、文件权限 0644，目录仅部署用户可进入；Compose 挂载单个文件时，容器中的 node 用户可读取。服务以 node 用户运行。如果用外部工具替换密钥文件后出现 EACCES，重新运行初始化脚本以修复权限，现有值不会被覆盖；不要开放 secrets/ 目录权限。

桌面本地验证：`docker compose -f compose.yaml -f compose.local.yaml up -d`，然后访问 http://localhost:8787。该配置仅绑定回环地址，不用于手机拍照验收。手机需可访问且被信任的 HTTPS 域名/证书；不要将自签未信任证书当作通过项。

## 使用与规则

- 在 TaskNotes 原界面创建的新任务自动接入；scheduled=开始，due=结束。日期没有时分的任务保存在“待配置”，不发送打卡提醒。
- 已有任务在命令“接入或设置当前任务的推送打卡”明确接入。任务级提前分钟可覆盖默认 10/10 分钟。
- 只有已审查的 TaskNotes 可视化入口与专用设置提交计划。手改 MD、原生属性面板或直接删除文件不更改服务器。只改优先级不会夹带手改的时间。
- 两卡独立，窗口均为 [时间−提前量, 时间)。最终服务器提交时刻决定有效性；上传成功不延长截止。一卡仅一张照片，成功后不覆盖。
- 任一窗口开放后冻结时间/提前量，可取消。完成任务和拍照打卡分开；完成或归档停止未投递的提醒。循环模板不安排。
- 插件使用每设备独立队列文件持久化操作 ID/基础版本，重试内容不变；冲突进入同步中心等待选择。离线 UI 删除待联网确认后取消；手动删文件保留服务器计划、记录待关联。
- 启动、恢复前台和在线事件会拉取，失败按 15 秒至 5 分钟退避。命令“拉取打卡记录和照片”和按钮可手动触发，同步并发合并。
- 照片默认保存到 vault 的 PushGo附件/，不允许与任务目录相同或互相包含。按媒体 ID 命名；每条记录一个托管区块，用户修改区块后保留并提示核对。
- 多设备从任务笔记的 pushgo_task_id 关联已有服务器计划。唯一匹配才自动关联；复制产生重复 UUID 或笔记缺失时，需要同步中心手动关联，不恢复被删笔记。首版只服务一个账号的一套 vault 和一个频道。
- 早报默认 07:00、晚报 22:00，Asia/Shanghai。常规每种每天一条，快照不被后续改动覆盖；长列表在网页看。跨日任务按与当天的时间区间相交统计，未截止单列。
- 照片服务端保留 90 天，可配 1–3650 天；清理后保留打卡元数据，本地已经下载的照片不自动删除。

## 存储、备份与恢复

业务数据在 tasknotes_data Docker 卷，SQLite /data/tasknotes.sqlite，照片 /data/photos。停服务后同时备份两者，另在安全位置保留 secrets/encryption_key、owner_password、gateway_token 和 .env。换加密密钥不能解开旧频道密码。

在项目目录运行 `sh scripts/backup.sh /absolute/backup-dir`，会停服务、归档卷并恢复服务。先将密钥和配置恢复至新部署，再运行 `sh scripts/restore.sh /absolute/tasknotes-data.tgz`；恢复只允许空的数据卷，不覆盖已有数据。Windows 可用 WSL 或等价的 Compose 停止、归档/解压操作。备份时提醒暂停，恢复后只投递仍在窗口内的作业。

OWNER_PASSWORD 只在首次初始化写入密码哈希；单改部署文件不改变已有账号。令牌可通过 /auth/logout 撤销当前设备，或 /auth/tokens + DELETE /auth/tokens/:id 撤销指定设备。插件配对令牌 180 天、浏览器会话 30 天，到期重新登录。

## API 与验证

接口前缀 /tasknotes/v1：auth/login/session/logout/tokens、settings、integrations/pushgo、workspaces/owner/mutations、workspaces/owner/sync、instances、uploads、media、reports、operations/status。写任务携带 operationId、taskId、baseVersion、action、changes 和 origin=tasknotes_ui。服务端只认可该协议来源，来源保证由插件入口隔离实现，不是防止持有集成令牌的账号伪造请求。

开发：`npm ci`、`npm run typecheck`、`npm test`、`npm run build`、`npm run test:browser`。浏览器依赖需先 `npx playwright install chromium`。数据库使用 Node 24 内置 node:sqlite；镜像使用相同运行时。

详细测试结果与尚需真机验证的项目见工作区 artifacts/TaskNotes-PushGo-验收记录.md。实际凭据只在被忽略的部署文件保存。
