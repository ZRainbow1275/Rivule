# 遇到提示，接着做什么

先记下出错的步骤和原始错误码，再按下面对应项处理。报告问题时附上版本、时间和不含凭据的错误信息即可。

[开始使用](GETTING_STARTED.zh.md) · [部署](OPERATIONS.md) · [接入](INTEGRATIONS.md)

<a id="build"></a>
## 构建与资源

| 你看到的提示 | 下一步 | 谁来做 |
| --- | --- | --- |
| Node 版本低于 24 | 在支持的环境中使用 Node 24+，重新执行构建步骤 | 构建者 |
| `Noto font missing` | 在源码根目录运行 `node scripts/install-font.mjs`，成功后重建 | 构建者 |
| 字体下载失败 | 检查错误中的官方资源是否可达，恢复网络后重试字体安装器 | 构建者 |
| `MODULE_NOT_FOUND`（resvg WASM） | 在 源码根目录 执行 `npm ci --ignore-scripts` 后重建 | 构建者 |
| `Noto font integrity mismatch` / `resvg WASM integrity mismatch` / 字体安装器完整性错误 | 检查是否混入了不同版本文件，按同一源码版本的安装器和 lockfile 恢复；不要跳过 SHA 校验 | 构建者 |

<a id="connection"></a>
## 服务与助手连接

| 提示 | 下一步 | 谁来做 |
| --- | --- | --- |
| `source_config_missing` / `source_config_invalid` | 检查 `SOURCES_JSON` 是否为当前来源的有效配置，不能保留空模板 | 所有者 |
| `project_config_missing` / `project_config_invalid` | 检查 `ALLOWED_PROJECT_IDS_JSON`；模板的空数组不是已配置项目 | 所有者 |
| `origin_config_invalid` / `origin_not_accepted` | 核对 `PUBLIC_ORIGIN` 与实际请求的协议、主机、端口；配置值不能带尾部 `/` 或子路径 | 所有者 / 集成方 |
| `mcp_oauth_not_configured` | 检查 OAuth 配置和 `OAUTH_ENABLED`，再用所有者提供的来源专属 MCP 地址连接 | 所有者 |
| `oauth_client_not_bound` / `source_not_authorized` | 核对当前客户端、来源 ID 和授权绑定；配置变化后完成对应来源的正常授权 | 所有者 / 助手 |
| `oauth_storage_missing` | 核对 owner 的 `OAUTH_KV` 是否绑定到实际 KV 命名空间 | 所有者 |
| `insufficient_scope` | 检查本次操作所需的 `pa:publish` 或 `pa:receipt`，通过正常授权流程更新权限 | 所有者 / 助手 |
| Muse `401 unauthorized` | 核对该连接的安全凭据配置及 Bearer 鉴权方式；不要把密钥贴进问题报告 | 集成方 |
| `muse_api_not_configured` / `muse_source_not_configured` | 检查服务端 API 设置、`muse-main` 来源及 API-key 接入配置 | 所有者 |
| Muse 路由 `404 not_found` | 检查路径和 `MUSE_API_ENABLED`；只有当前文档列出的 Muse 路由可用 | 所有者 / 集成方 |
| `invalid_signature` | HMAC 集成方核对时间、签名算法和原始请求字节；不要换来源 ID 试错 | 集成方 |

<a id="delivery"></a>
## 连接成功，但没有看见消息

先用原来的 `receipt_id` 查询 `get_delivery_status` 或对应 HTTP receipt 路由。读取回执不会重新发送消息。

| 状态 / 提示 | 下一步 |
| --- | --- |
| `queued` / `retry_wait` | 等待当前队列或服务端限流退避，再查同一回执 |
| `delivery_not_enabled` | 所有者确认目标、配置与测试授权后，检查该渠道的发送开关 |
| `preflight_bot_identity` / `preflight_dm_identity` | 所有者核对 bot 应用与目标 DM 绑定，修复后按实际回执决定下一步 |
| `blocked` / `http_401` / `http_403` / `http_404` | 查看同一回执的具体原因，核对凭据有效性、bot 权限和目标是否仍可用 |
| `uncertain` / `send_result_unknown` / `operation_result_unknown` | 先查看原回执和目标聊天，保留未知结果；不要自动重新发一条 |
| `receipt_not_found` | 检查回执是否来自当前来源、当前安装，是否抄写完整 |
| `event_id_conflict` | 比较该事件原内容与本次内容，保留原事件 ID 的含义；不要覆盖同 ID 的不同更新 |
| `stale_ignored` / `unsequenced_needs_review` / `terminal_guard` | 读取同一任务分支的现状，交给维护事件顺序的来源核对；必要时按合同做显式更正 |
| `sent` | 到正确的 Discord DM 核对来源和内容；其他渠道单独看 `channels` 的状态 |

`accepted` 或 HTTP 202 表示接收了事件，不等于通知已经送达。第一条通知以“回执核对 + 接收方实收”验收。

<a id="qq"></a>
## QQ 的下一步

- **固定回复能收到，主动通知没来**：先确认一次性主动测试，再检查是否由所有者开启了本轮持续通知
- **每日连接预算已用完**：查看设置页的剩余预算与连接状态；默认预算为 120 分钟连接时间，不是消息条数
- **已暂停或权限 / 绑定变更**：由所有者检查当前绑定、来源证明和权限，再决定是否开启新一轮
- **`queue_capacity`**：查看容量提示并等待容量恢复；项目记录保留，不把被跳过的通知当作已送达
- **结果未知**：保留当前状态，先检查接收聊天和回执；不自动重试主动发送

持续通知属于当前已授权会话。完整配置见[部署文档](OPERATIONS.md#qq-session)。
