# 部署与维护

先完成[本地构建](../README.md#build)。需要自己的 Cloudflare 账户、Discord 应用与 bot；新安装须自行验证完整的认证和实收流程。

<a id="owner-setup"></a>
## 1. 建立私人配置

```sh
cp config/wrangler.owner.example.json config/wrangler.owner.private.json
cp config/wrangler.qq.example.json config/wrangler.qq.private.json
```

填写自己的 Worker 名称、实际 HTTPS 服务域名、KV 命名空间、Discord 应用公钥、所有者和目标 DM。`PUBLIC_ORIGIN` 不带尾部 `/` 或子路径。配置 `SOURCES_JSON` 和 `ALLOWED_PROJECT_IDS_JSON`，先允许一个来源与一个项目；按[接入方式](INTEGRATIONS.md#connect)准备 OAuth、Muse API 或 HMAC。

私人配置不得提交。公开模板的发送与可选功能开关默认关闭，空允许名单和身份占位值不可直接使用。

### 先填一个来源，再配置选定的认证方式

模板中的 `SOURCES_JSON` 与 `ALLOWED_PROJECT_IDS_JSON` 是 JSON 字符串，不能保留空数组。下面是可填写到 owner 私人配置 `vars` 中的结构示例；ID 和显示名由你选定，保持与助手接入时一致：

```json
{
  "SOURCES_JSON": "[{\"source_id\":\"assistant-main\",\"provider\":\"custom\",\"display_name\":\"我的助手\",\"enabled\":true,\"allowed_hosts\":[],\"secret_name\":\"PA_ASSISTANT_MAIN\",\"auth_methods\":[\"oauth\"]}]",
  "ALLOWED_PROJECT_IDS_JSON": "[\"first-project\"]"
}
```

这只是 `vars` 的部分字段，不要用它覆盖整份配置。`source_id`、项目 ID 与 `OWNER_ID` 使用 1–100 位字母、数字及 `_.:-`，首位为字母或数字。来源可配置 1–16 个，项目可配置 1–3 个，ID 不可重复。`provider` 可为 `dot`、`spark`、`muse` 或 `custom`。`allowed_hosts` 只填写获准的来源链接主机名，不含协议或路径；空数组表示不允许提交来源链接，不影响无来源链接的更新。`secret_name` 是绑定名，必须以 `PA_` 开头并使用大写字母、数字或下划线；每个来源使用不同的绑定名。即使只使用 OAuth，也要保留这一字段；仅启用 OAuth 不需要配置对应的 HMAC secret。

选定一种接入方式后，再补齐它自己的配置：

- MCP OAuth：将 `OAUTH_ENABLED` 设为字符串 `"true"`。保持动态客户端默认关闭时，填写 `OAUTH_CLIENT_BINDINGS_JSON`，例如 `"[{\"client_id\":\"REPLACE_WITH_ACTUAL_CLIENT_ID\",\"source_id\":\"assistant-main\"}]"`；client ID 必须来自实际客户端流程，不是 Discord application ID。每个 client ID 与来源各有一个绑定。客户端需要动态登记时，由所有者确认接入方式后再启用 `OAUTH_ALLOW_DYNAMIC_CLIENTS`，不要为排错直接放开
- HMAC：将该来源的 `auth_methods` 设为 `["hmac"]`，在 owner Worker 的 secret 设置中配置该来源 `secret_name` 对应的密钥（示例绑定名为 `PA_ASSISTANT_MAIN`，至少 32 个 UTF-8 字节）。请求签名细节见[HTTP 接入](INTEGRATIONS.md#http)
- Muse API：来源 ID 必须为 `muse-main`，`provider` 为 `muse`，`enabled` 为 `true`，`auth_methods` 为 `["api_key"]`；保留其余必要来源字段。将 `MUSE_API_ENABLED` 设为字符串 `"true"`，在 owner Worker 的 secret 设置中配置 `PA_MUSE_API_KEY`

Discord 通知使用 owner Worker 的 `DISCORD_BOT_TOKEN` secret。MCP OAuth 另需同一 Discord 应用的 `DISCORD_CLIENT_SECRET` secret，并在 Discord 应用的 OAuth2 设置中登记实际 `PUBLIC_ORIGIN/callback` 作为回调地址。它与后续设置的 `PUBLIC_ORIGIN/discord/interactions` 是两个不同用途的地址。

下面是两种 HTTP 方式各自完整的来源字段示例；每次只选择与你的集成对应的一种，合并到 owner 私人配置的 `vars` 中，不要删除其他身份、域名及绑定配置：

HMAC：

```json
{
  "SOURCES_JSON": "[{\"source_id\":\"assistant-main\",\"provider\":\"custom\",\"display_name\":\"我的助手\",\"enabled\":true,\"allowed_hosts\":[],\"secret_name\":\"PA_ASSISTANT_MAIN\",\"auth_methods\":[\"hmac\"]}]",
  "ALLOWED_PROJECT_IDS_JSON": "[\"first-project\"]"
}
```

Muse API：

```json
{
  "SOURCES_JSON": "[{\"source_id\":\"muse-main\",\"provider\":\"muse\",\"display_name\":\"我的助手\",\"enabled\":true,\"allowed_hosts\":[],\"secret_name\":\"PA_MUSE_SOURCE\",\"auth_methods\":[\"api_key\"]}]",
  "ALLOWED_PROJECT_IDS_JSON": "[\"first-project\"]",
  "MUSE_API_ENABLED": "true"
}
```


### 账户、KV 与 secret 的操作顺序

先由所有者确认登录授权与创建 KV，再执行以下命令：

```sh
./node_modules/.bin/wrangler login
./node_modules/.bin/wrangler whoami
./node_modules/.bin/wrangler kv namespace create OAUTH_KV --config config/wrangler.owner.private.json
```

将创建结果中的实际 namespace ID 填回 owner 配置的 `kv_namespaces` 中，绑定名保持 `OAUTH_KV`，不要保留全零 ID。已有安装复用已有 namespace，不要新建后替换。Wrangler 可能提示更新配置，继续前核对实际目标文件与变更。

先保持发送开关关闭，按下文检查并首次部署两个 Worker；Worker 已存在后，再配置需要的 secret。每条 `secret put` 会更改远端 Worker 的 secret，执行前确认目标与变更。在自己的终端输入凭据，或使用 Cloudflare 的 secret 设置；值不要写入配置文件或命令参数。

所有 Discord 通知需要：

```sh
./node_modules/.bin/wrangler secret put DISCORD_BOT_TOKEN --config config/wrangler.owner.private.json
```

只在使用 MCP OAuth 时需要：

```sh
./node_modules/.bin/wrangler secret put DISCORD_CLIENT_SECRET --config config/wrangler.owner.private.json
```

只在使用上面的 HMAC 来源时需要（若更改了 `secret_name`，命令使用同一个绑定名）：

```sh
./node_modules/.bin/wrangler secret put PA_ASSISTANT_MAIN --config config/wrangler.owner.private.json
```

只在使用 Muse API 时需要：

```sh
./node_modules/.bin/wrangler secret put PA_MUSE_API_KEY --config config/wrangler.owner.private.json
```

`DISCORD_BOT_TOKEN` 和 `DISCORD_CLIENT_SECRET` 属于 owner Worker / Discord 应用；HMAC secret 按来源分别配置，不能在来源之间复用。Muse 使用固定的 `PA_MUSE_API_KEY` 绑定，来源中的 `PA_MUSE_SOURCE` 仅为必填绑定名字段；只有另行启用 HMAC 时才需要为它配置 HMAC 密钥。Discord 的 `DISCORD_PUBLIC_KEY` 是用于验证交互签名的公钥，填写在配置变量中，不是 bot token 或 client secret。

只使用 Discord 时无需 QQ secret。可选 QQ 的 `QQ_APP_SECRET` 只放在 gateway Worker；`QQ_BRIDGE_SECRET` 在 owner 和 gateway 上配置为同一值，用于两个 Worker 之间验证请求，不能用来源的 HMAC 密钥替代：

```sh
./node_modules/.bin/wrangler secret put QQ_APP_SECRET --config config/wrangler.qq.private.json
./node_modules/.bin/wrangler secret put QQ_BRIDGE_SECRET --config config/wrangler.qq.private.json
./node_modules/.bin/wrangler secret put QQ_BRIDGE_SECRET --config config/wrangler.owner.private.json
```

QQ 继续按后文完成绑定、权限证明和本轮授权。所有 secret 完成后检查配置与目标，再由所有者启用所需渠道并进行一次实收测试。


## 2. 检查模块与绑定

- owner 入口：`dist/owner/worker.js`
- QQ gateway 入口：`dist/gateway/worker.mjs`
- 保留模板的 `no_bundle`、`base_dir` 和资源规则，部署整个对应模块目录
- gateway 使用 `QQGatewayObject`；owner 使用 `OwnerTerminal`
- owner 的 `QQ_GATEWAY` 指向实际 gateway Worker，`OAUTH_KV` 指向自己的 KV
- 新安装使用模板中的迁移；已有安装保留原命名空间、身份与迁移历史

先只使用 Discord 也要准备当前模块依赖的绑定。不要把单个入口文件脱离相邻模块与资源上传。

使用 lockfile 安装的 Wrangler 做本地配置检查：

```sh
./node_modules/.bin/wrangler deploy --dry-run --config config/wrangler.qq.private.json
./node_modules/.bin/wrangler deploy --dry-run --config config/wrangler.owner.private.json
```

检查目标、模块、资源、绑定和迁移。dry-run 不验证远端账户权限、OAuth、Discord 握手或消息实收。

<a id="release-check"></a>
## 3. 发布与确认

通过 Wrangler 官方认证流程登录。确认账户、Worker 名称、目标及授权后，新安装依次部署：

```sh
./node_modules/.bin/wrangler deploy --config config/wrangler.qq.private.json
./node_modules/.bin/wrangler deploy --config config/wrangler.owner.private.json
```

这些命令会改变远端服务，执行前确认发布目标。已有安装应先保存当前配置与可回滚版本，核对迁移、绑定及数据兼容性，再按该安装的更新流程发布。回滚代码不会回滚 Durable Object 中的数据。

发布后检查服务配置与绑定，将 Discord 应用交互地址设置为 `PUBLIC_ORIGIN/discord/interactions`，确认签名握手和 bot / 所有者 / DM 绑定。由所有者启用需要的发送渠道，然后完成[一条通知的实收确认](GETTING_STARTED.zh.md#first-message)。健康探针有响应不等于通知已送达。

网络部署应提供与运行版本对应的 AGPL 源码入口，并保留第三方许可与源码来源说明。

<a id="qq-session"></a>
## QQ 会话内通知

先完成连接、接收账户绑定和固定回复检查，再由所有者点击一次性主动验证。部署方配置所需开关、来源和项目允许名单及 bridge secret，所有者在设置中确认当前账户、权限并开启本轮持续通知。

- 公开模板默认关闭发送；已有安装的实际状态以设置页为准
- 连接时长默认只提醒，不强制暂停；`QQ_DAILY_ACTIVE_BUDGET_MS=7200000` 设置初始每日阈值为 120 分钟
- 在「运行预算」切换「仅提醒」与「到点暂停」，以 30 分钟为步长增减阈值，范围 1 分钟至 24 小时；「重置为 120 分钟」只重置阈值，不清零计时或改变所选模式
- 仅累计运行状态下的连接时长，每日 00:00 UTC 重新计时；它不是 Cloudflare 实际账单额度，不能代替控制台用量查询
- 保存预算会暂停当前持续通知授权，需要所有者重新开启；不会自动启动连接、发消息、修改套餐、消费上限或平台配额
- 当前主动通知上限为每日 100 次，最小发送间隔为 3 秒；配额按 UTC 日期重置
- 持续发送需要当前来源、绑定、权限和会话证明，并受去重与容量规则约束
- 暂停结束本轮授权；连接会话、绑定、权限或预算策略变化后需重新确认。仅提醒模式没有 Rivule 固定两小时终止，不等于永久授权
- 未知发送结果先核对接收聊天和原回执，不自动重发
- 容量不足时，通知可能跳过，项目记录仍保留

两端 `QQ_ALLOWED_PROJECT_IDS` 必须明确包含获准项目；空列表拒绝所有普通项目，不表示允许全部。一次性验证消息走独立验证路径，成功后仍需用获准项目的真实事件查询原回执并确认实收。

这是一项会话内能力，尚不提供跨会话自动续权的全天候 QQ 通知，也未覆盖 Discord 的全部功能。在 QQ 主面板点击“刷新”可原地更新状态，使用“返回总览”入口回到任务总览。设置提示与处理步骤见[QQ 状态指南](QQ_STATE_MATRIX.md)。

## QQ 任务队列诊断

持续通知需要网关授权和 owner 任务队列同时可用。网关本轮授权存在，不代表队列仍在推送；设置页会在队列暂停或无法读取状态时显示实际限制。

- `preflight_not_sent` 表示在发送前检查阶段被抑制。回执可带 `diagnostic.stage` 与 `diagnostic.code`，只包含允许公开的有限代码，不含原始异常文本。
- `bridge_outcome_unknown` 表示调用发送链路后的结果不确定。不得把它当作确认未发送，也不要重复提交；先查询原回执并核对接收聊天。
- 队列与网关状态不一致时，先检查连接会话、当前权限、来源/项目配置和预算；若原因无法确认，按状态待确认处理，不猜测具体故障。
- 刷新面板不会重新授权或补发。修复配置后由所有者重新开启当前会话，再对一条新的、已获准通知核对原回执及接收方实收；不要重放旧的未知结果通知。

v0.4.4 的认证只读诊断返回 `current_qq_delivery`，将当前 owner 任务队列状态与最近一条已应用事件的入队状态分开。读取不会初始化队列、重新授权或发送通知；当前状态不是历史事件原因的证据。

- `activation_inactive`、`activation_expired` 等有限代码说明新事件为何被跳过；仍需按面板核对当前授权，而不是仅检查连接和绑定。
- `admission_not_recorded` 表示没有可核对的 QQ 入队记录，历史原因未知；`receipt_history_unavailable` 表示历史记录已不可用。不要把它们改判为确认未发送。
- `provider_accepted` 只表示已提交 QQ，实收仍以接收端确认为准。`provider_outcome_unknown` 与其他未知发送结果均不得自动重试。
- 跳过记录按保留期限和数量上限清理，不能作为永久审计日志。升级为既有容量跳过记录保留 `queue_capacity` 含义，不为缺失历史补造原因。

健康响应、网关验证成功和诊断更新都不等同于普通任务通知已送达。

## QQ 冷启动状态恢复

v0.4.2 的网关状态解码在读取 v2 通知状态时恢复拆分存储中缺失的空表；已有记录与发送结果保持不变。owner 模块和消息协议未改变。

遇到 `durable_state_schema_invalid` 时，不要删除状态、清空表或自动重放通知。先保留现有存储与备份，再核对状态结构和安装版本；损坏的表类型、非法拆分路径和混用格式会被拒绝，而不是静默重建。代码回滚也不会回滚已存储的数据。

冷启动恢复不会重新授权或补发。安装更新后按面板要求确认当前会话，再对明确获准的新通知逐渠道核对原回执与接收方实收；未知发送结果不要自动重试。


## 部署环境重建后的最小恢复

浏览器登录状态、Wrangler CLI 授权和项目私有配置是不同状态，不应互相推断。环境重建后，先确认源码提交和既有部署目标；公开示例不能直接覆盖生产配置。

将已批准的 Wrangler CLI 配置保存在仓库之外的私有目录，并通过 `XDG_CONFIG_HOME` 指向该目录。同一次操作中的身份检查、构建与部署应使用同一配置环境。目录中可能含授权信息，不得提交 Git、打印令牌内容或复制到文档。缺失授权时走官方支持的授权恢复流程；新增授权仍须确认，不改用浏览器上传绕过指定部署方式。

恢复后先用 Wrangler 身份检查确认账户可用，再读取既有 Worker 配置。保留全部现有绑定、秘密、兼容设置和部署目标，只修改本次明确批准的配置。运行项目检查、测试及完整构建，然后通过 Wrangler 部署已核验提交。部署后分别确认版本/流量、未登录拒绝数据访问、所有者登录以及选定任务读取。只有这些检查的实际结果才能写入验收记录，不用新通知或历史事件重放测试面板。
