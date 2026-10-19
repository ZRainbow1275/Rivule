# 助手接入与验收

所有者负责服务、渠道和允许名单；助手负责当前来源的认证、明确上报和回执查询。先用一个来源完成[第一条通知](GETTING_STARTED.zh.md#first-message)，再扩展。

<a id="connect"></a>
## 选择接入方式

向所有者确认实际 `PUBLIC_ORIGIN`、当前来源 ID、允许的项目 ID，以及已约定的任务 / run / branch 标识。以下路径均相对于该实际服务 origin。

### MCP + OAuth

连接地址：`/mcp/<source_id>`。MCP 资源 origin 为 `PUBLIC_ORIGIN/mcp`；具体请求绑定到当前来源。

1. 完成当前客户端的正常 OAuth 授权
2. 执行 `initialize`、`tools/list`，检查响应中的 RPC / 工具错误，不能只看 HTTP 200
3. 按当前工具返回的 schema 使用下列能力

| 工具 | 用途 | scope |
| --- | --- | --- |
| `get_task_snapshot` | 只读查询自己的精确项目 / 任务 / run / branch | `pa:receipt` |
| `publish_task_update` | 上报一条明确选择的任务更新，可能发送真实通知 | `pa:publish` |
| `get_delivery_status` | 读取当前来源创建的回执 | `pa:receipt` |
| `get_connection_diagnostics` | 读取配置来源的有限连接诊断；仅向专门配置的诊断读取身份开放 | `pa:receipt` |

普通来源无需诊断工具。连接认证成功与通知实际送达分别验收。

<a id="http"></a>
### HTTP：先确认是哪一种鉴权

| 接入 | 路由 | 请求方式与内容 |
| --- | --- | --- |
| Muse API | `GET /v1/muse/health` | Bearer 鉴权；验证该密钥对应的配置，不发送通知 |
| Muse API | `POST /v1/muse/events` | Bearer 鉴权；JSON 为 `{event, notification_mode?}` |
| Muse API | `POST /v1/muse/receipt` | 同一来源鉴权；JSON 为 `{receipt_id}` |
| HMAC | `POST /v1/events` | 签名的 JSON 事件本体，不套 MCP / Muse 的 `event` 外壳 |
| HMAC | `POST /v1/receipt` | 签名的 JSON `{receipt_id}` |
| HMAC | `POST /v1/task/snapshot` | 签名的 JSON，含 `project_id`、`task_id`、`run_id`、`branch_id` |

Muse API 需所有者启用 API，配置 `muse-main` 来源和服务端安全凭据；当前没有 Muse task-snapshot 路由。HMAC 请求通过 `x-pa-source`、`x-pa-timestamp`、`x-pa-signature` 鉴权，签名针对时间戳加 `.` 再加原始请求字节；具体实现以当前源码为准。

HTTP 路由、鉴权和事件校验实现在 `src/owner/worker.js`；MCP 接入以当前 `tools/list` 返回的 schema 为准。不同接口的鉴权、封装不能混用。

## 一条更新如何验收

1. 读取同一任务分支的快照或来源自己维护的当前状态
2. 使用当前 schema 发布一条已获准的测试内容，记录 `receipt_id`
3. 用同一来源查询回执，区分事件接受、排队、送达、阻塞和未知结果
4. 在实际目标聊天确认收到、内容正确、来源正确

`notification_mode=standard` 可能更新总览并发出单独的重要状态卡；`overview_only` 只更新总览，并会拒绝审批或需复核的更新。该参数不选择或授权 QQ 等渠道；独立配置且获授权的 QQ 渠道可能另行送达。

回执顶层 `delivery` 和 `deliveries` 描述 Discord；其他渠道看可选的 `channels`。遇到未知结果时查询原回执并核对聊天，不自动生成新事件重发。具体操作见[排查指南](TROUBLESHOOTING.zh.md#delivery)。

## 精确任务快照与序号

快照查询需要 `project_id`、`task_id`、`run_id`、`branch_id`，只能读取该认证来源自己的精确任务。

符合条件时，`source_seq=null` 可返回 `initialize_sequence` / `next_seq=0`。它只是观察时刻的建议，不预留序号，不提供 compare-and-swap，也不是批准任务。由维护事件顺序的来源决定如何使用。发生冲突时重读并核对原分支，不盲目递增、自动重试或换分支规避。

快照读取不写入来源证明或通知队列。其他成功认证读取可刷新已有来源证明存储；初始化和工具列表可建立当前证明。详情见[只读能力](CAPABILITIES.md)。

## 逐个配置来源

1. 确认助手支持远程 MCP OAuth，或由集成方实现所选 HTTP 鉴权方式
2. 由所有者建立来源、允许的项目及当前客户端授权绑定
3. MCP 连接执行初始化与工具列表读取；HTTP 连接按对应路由和鉴权检查
4. 发送一条已获准的更新，查询同来源回执，并在目标聊天确认实收

名称或图标不能替代当前连接证明。更换绑定、配置或撤销授权后，重新检查当前来源；历史任务不会因此变成新的连接证明。

## QQ 的独立验收

固定回复成功不代表已获得主动通知许可。一次性主动测试与会话持续通知分开处理；公开配置模板默认关闭持续通知；开启后每日连接预算 120 分钟、主动通知上限 100 次、最小间隔 3 秒。机器人资料卡中的主动消息开关由用户控制，证明信息不能手动伪造。

QQ 主动 API 不带 `msg_id` / `event_id`；唤醒为单独模式。官方被动回复说明存在正文 60 分钟与参数 5 分钟的差异，当前固定回复采用保守的 5 分钟检查。

官方参考：[发送 C2C 消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[C2C 消息事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_msg_receive.html)。
