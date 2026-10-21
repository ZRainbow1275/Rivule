# Rivule 应用协作桥

把一个项目拆成有依赖的节点，分别交给自己的 ChatGPT 网页 Pro、Gemini 任务和公开网页 worker。Cloudflare Durable Objects 保存任务、租约、回执与审计；网页、MCP、CSV 使用同一份状态。

## 先运行工作台

```sh
cd app-bridge
npm ci --ignore-scripts
npm run dev
```

本地入口 `http://127.0.0.1:8791`。本地 OAuth 还需把 `PUBLIC_ORIGIN` 改为这个来源，并按 [Google 配置向导](docs/GOOGLE_SETUP.zh-CN.md)设置独立测试客户端、受邀邮箱和 Secrets。没有 Google 配置时只开放登录提示、健康检查和对应源码下载；不会生成默认管理员。

控制面已发布到 **https://rivule-bridge.hybridrevis.workers.dev**，MCP 地址为该来源的 `/mcp`。公开健康、OAuth 元数据与登录提示已实测，区域 worker 已配置密钥并常驻 VPS；Google OAuth 客户端尚未创建，按向导完成后再验收真实用户派单。版本与逐项证据见 [当前进度](../reports/PROGRESS.md)。

1. 受邀用户用自己的 Google 账户登录，创建工作空间。
2. 在「助手来源」创建 ChatGPT、Gemini 或 MCP 来源，记录 workspaceId/sourceId。
3. 将远程 MCP 地址添加到产品，通过 OAuth 明确选择来源绑定和权限；也可按下节安装限域浏览器连接器。
4. 添加节点、选择目标来源和前置任务。前置节点全部成功后才可领取下一节点。
5. 在路线图查看进展、打开回执；暂停、继续、取消和重试都带修订号，冲突时刷新后处理。结果未知时，先核对原页面，再人工标记完成/失败/放弃，或明确开始新运行。

每个工作空间最多 100 个节点、20 位成员、30 个来源；一次导入最多 100 行。所有者邀请成员后，成员使用自己的 Google 登录。工作台成员共享本空间的任务；MCP/连接器只读取分配给本来源或由本来源创建的任务。公开网页 worker 不接触模型账号和对话。

## 明确绑定浏览器任务会话

`connector/` 是 Manifest V3 扩展源码。加载未打包扩展会改变浏览器扩展清单，请由用户在 **独立任务 profile** 的扩展管理页手动加载。现有 Capture 扩展和默认 profile 不需要改动。

1. 在工作台为自己的来源生成连接器配置，粘贴到扩展设置；凭据保存在该 profile 的 `chrome.storage.local`，不使用 sync。
2. 手动打开一个准确的任务会话：ChatGPT `/c/<id>` 或 Gemini `/app/<id>`。选择指定产品模式、确认当前账号，粘贴无查询/片段的完整 URL，保存后手动启用。
3. 保留一个匹配的标签页。扩展每 30 秒检查待办，领取前确认模式、空草稿、空闲状态和已知发送按钮。输入填充后再次检查，才点击发送。
4. 每 7 天从工作台续绑同一来源；离开会话、失去租约、主动停止生成或观察中断后，任务进入待核对状态，不自动重新输入。

连接器不会切换模型，不操作登录、验证码、系统权限或工具批准。原页面的草稿不会被覆盖，网页原生 Stop 由用户控制。工作台暂停/取消撤销协调租约；已经开始的模型生成继续保留在原页面，需停生成时在原页面操作。

**指定产品验收仍需真实账号完成。** 页面适配器严格检查可识别的 Pro/任务模式和结束标志；产品 DOM 变化或无法确认 Gemini Tasks 时停止并提示。普通 Gemini 对话和 API 不作为 Tasks 验收替代。连接器恢复先探测原观察进程，绝不通过重发输入恢复。

2026-10-21 已在实际页面核对 ChatGPT 普通 Chat 的 Pro 模式、当前 ProseMirror 输入控件，以及 Gemini 选中的 Task 按钮、rich-textarea 与输入后才出现的 Send message 控件。只做临时草稿检查并清空，未提交产品消息；真实任务发送、结束检测和双产品结果回收仍按下文验收门完成。

## MCP 与浏览器分工

| 工具 | 用途 |
|---|---|
| `list_inbox` | 只读查看本来源相关任务和可分配来源 |
| `get_task` | 读取可见任务的回执、依赖和 revision |
| `claim_task` | 明确领取本来源的对话节点，默认 15 分钟，可指定 90 秒至 3 小时租约 |
| `heartbeat_task` | 对所领取节点续租，收到 409/410 时停止 |
| `report_task` | 回报真实结果，网络未知时只重传原回执 |
| `dispatch_task` | 带幂等键创建节点，指定来源与依赖 |
| `update_task` | 修改尚未开始的输入或依赖 |
| `control_task` | 有 control scope 的创建来源或所有者控制任务 |

标准 MCP 使用 OAuth 2.1/DCR/PKCE 和服务端来源绑定；连接器 token 不可替代 MCP OAuth。ChatGPT/Gemini 网页来源的 MCP grant 可读、派单和控制任务，执行回报必须走绑定浏览器；`claim_task` / `heartbeat_task` / `report_task` 仅供「其他 MCP 助手」来源执行，避免把通用 MCP 输出算成指定网页产品的运行。读工具不会领取任务或触发网页生成。对话任务只发送节点中明确写入的 input；跨来源消费前序材料时，创建来源可用 `get_task` 读取自己派发任务的回执，再编排后续节点，避免把整个工作空间历史自动注入各个对话。

ChatGPT 普通网页 Pro、Gemini Tasks 的连接权限、账号/地区资格和工具确认，应在产品内逐项验收。Work/Dots 的事件接口不用于替代本轮普通网页版目标。

## 公开网页 worker

使用相邻的 [`cn-search`](../cn-search/README.md) 部署包。控制面暴露 claim、heartbeat、result 和私有附件上传；worker 使用单独的 `WORKER_TOKEN`，不持有用户 OAuth 或模型登录态。

```text
POST /api/worker/claim          {capabilities:["regional_search","fetch_public_page"]}
POST /api/worker/heartbeat      {job_id,lease_token}
POST /api/worker/result         {job_id,lease_token,status,result?,error?}
PUT  /api/worker/artifacts/<job_id>/<filename>  X-Worker-Lease: <lease_token>
```

浏览器/公开网页 worker 租约 90 秒，健康心跳返回续租截止时间；409/410 要停止本次执行。结果最大 256 KiB，附件单文件最大 8 MiB、每次运行最多 16 个，存入非公开 R2。相同执行和文件名只有相同内容可以重试；结果未知时重传原回执，不重新执行网页任务。已撤销或过期执行的正确迟到回执保存为 `applied:false` 并返回确认，不改变任务状态、不释放依赖；worker 收到 2xx 后可以清理已确认 spool。

## CSV 导入不会覆盖原任务

从当前工作空间导出作为模板。列为 `id,title,operation,source_id,dependencies,input,arguments,branch_id`；依赖用分号分隔，arguments 是 JSON。导入生成新任务 ID 并重映射批内依赖，整批校验环和来源后一次写入。导出的危险表格公式前缀经过转义，回读时保留原值。

任务保留 projectId、task id、runId、branchId、来源与每次执行回执；显式重试生成新的 runId。网络断开时保留原幂等键，刷新任务路线核对后再决定是否清除待确认请求。

运行时保存领取时的输入与来源快照。历史索引为 `GET /api/workspaces/<workspaceId>/tasks/<taskId>/runs?after=<seq>`（每页 20 条）；选择其中的 job_id，使用同一任务 GET 的 `?job_id=<job_id>`，或 MCP `get_task` 的可选 `job_id` 读取历史回执。重试后默认回执为空，直到新的运行提交结果；历史结果不会冒充新运行。

## 发布、检查和恢复

```sh
npm run check
npm test
npm run test:runtime
npm run build
# 所有者准备好 Cloudflare CLI 登录与 Secrets 后：
npm run deploy
```

`test:runtime` 使用独立的本地 `tests/runtime-worker.ts`，真实启动 workerd，调用 SQLite DO、KV、R2 和 MCP wire。身份是明确标注的测试夹具；生产入口只指向 `src/worker.ts`。测试不登录真实产品、不发送模型请求、不通知 Discord/QQ。

Cloudflare 配置使用两个 SQLite-backed DO class、一个专用 AUTH_KV 和一个非公开 R2 bucket。不要删除 DO namespace 或回滚到不兼容迁移；先保存原版本，回滚仅替换代码且保留绑定。已部署版本可通过 Workers Versions 回滚，随后检查 `/health`、登录、现有任务读取与租约恢复。暂停/取消、租约过期和不明发送都保留审计记录；观察超时不会悄悄切换 API 或重发。

根仓库现已同步 **v0.4.2**；协作桥使用独立的部署与存储。接入 Rivule Discord/QQ 通知时，沿用新版的来源 / 项目允许名单、当前会话授权及[连接与实收检查](../docs/INTEGRATIONS.md)。当前没有用户已运行的通知服务 URL，协作桥先独立运行，不向未配置渠道发送任务正文。

对应部署源码可从 `/source` 下载为文件映射 JSON；`scripts/source-bundle.mjs` 只打包源码、构建说明、锁文件和许可，不读取运行时数据或 Secrets。将其中 `files` 写到空目录后按 usage 构建。

### 尚需所有者完成的实际门

- VPS 默认 Moli 与可选 Linux Chromium 的运行隔离已验收，正式服务保留 Moli；Yandex 验证码、TASS 403、VK 空壳的逐站结果见[区域报告](../cn-search/reports/VALIDATION.md)，后续兼容验证需可访问的公开入口。
- Google 控制台建立 Web 客户端、录入 Secrets，并由两位真实受邀用户分别登录验收。
- 使用真实 ChatGPT Pro 与 Gemini Tasks 做一次分派、回收、暂停和恢复；必要的页面 selector 校准仅针对该产品实际 DOM。
