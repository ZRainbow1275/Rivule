# 普通对话桥接 v2：独立授权，不伪装成任务

此功能是独立的 `kind: conversation, version: 2` 协议。它不扩大 v1 的 `task_context_only` 承诺，不制造 project/task/run/branch，不把未知任务降级为普通对话，也不证明 dot、Muse、Grok 的运行时已经安装 hook。

## 三个独立范围

1. **来源操作权限**：服务端预先明确配置该 PA 的 provider/account/generation/revision 和允许操作，默认不存在。任务凭据、旧 `every_response` 模式、所有者转发开关均不授予这些权限。MCP 使用独立 `pa:conversation:read` / `publish` / `commands` scopes。
2. **所有者转发同意**：按 PA、渠道和 `general_conversation_response` 类别分别保存。Discord 与 QQ 不互相授权。默认关闭；范围为明确指定 context refs，或明确选择“此 Rivule 所有者与此 PA 当前及后续登记的会话”。这绝不包含共享 Grok/QQ 机器人其他用户的会话。5 分钟仅管理权限，已保存同意持续至撤销或绑定变化。
3. **工作台查看范围**：转发同意不是查看会话标题、正文或日志的授权。只有另行明确授予 5 分钟本地目录查看许可后，面板才展示该 PA 为此所有者登记的会话/线程标识。不读取回复正文、不向提供商枚举会话、不扩大任务选择器范围。显示的标识明确标注为来源声明，不冒充提供商独立验证；选择只写入待核对草稿，不启用转发。

QQ 普通对话通道如果缺少独立接收人绑定与发送路径，必须显示不可开启；不得借用任务 QQ 授权或假装已支持。关闭已有同意仍应可用，但不会恢复旧队列。

## 所有者控制接口

这些路径位于现有本人认证、同源保护之下，不对来源凭据开放。

- `GET /dashboard/conversation`：仅返回静态来源描述和 CSRF；不读取偏好、context refs 或活动统计，也不创建业务表、清理任务或发送消息。
- `POST /dashboard/conversation/access`：`{csrf,source_id,channel,confirm:true}`。返回短期 `access_token`、`expires_at`、类别、已脱敏接收人说明、`can_enable` 与此来源、此渠道的 `preference` 和 `observation`。先保存并复验管理能力，再查询；返回前再次复验。此操作不保存转发同意。
- `POST /dashboard/conversation/preference`：`{csrf,source_id,channel,access_token,enabled,commands_enabled,selection,expected_revision,confirm:true}`。`selection` 为 `{mode:'none'|'selected'|'all_registered',context_refs:[]}`。开启时不能选择 none 或空 selected；非 selected 不可携带 refs。

`POST /dashboard/conversation/cancel` 接收 `{csrf,source_id,channel,access_token}`，仅撤销匹配的短期管理能力，不关闭持久转发同意；旧 token 不影响新能力。

管理 capability 绑定本人 session、具体来源操作绑定、具体渠道和真实接收人绑定。最终事务内重新验证 session、capability、时限和当前绑定；revision compare-and-swap 防止重复确认或覆盖并发修改。界面编辑、刷新、打开、关闭都不保存。设置失败或网络未知不自动重试。

## 来源使用

`src/sdk/conversation-bridge.mjs` 是通用客户端，不是提供商专属安装器。只在真正的来源运行时有权实现 hook 时使用。

```js
import {
  createConversationBridge, conversationMcpTransport
} from '../src/sdk/conversation-bridge.mjs';

const bridge = createConversationBridge({
  source_id: configuredSourceId,
  ownerBinding: configuredRivuleOwnerBinding,
  recipientBinding: configuredUpstreamOwnerPeerBinding,
  resolveConversationOwner: context => trustedProviderAdapter.resolveOwner(context),
  call: conversationMcpTransport(args => authenticatedClient.callTool(args))
});
const registered = await bridge.registerContext({
  kind: 'conversation', version: 2,
  conversation_id: actualConversationId, thread_id: actualThreadId
});
// 保存来源返回的 reference，以及本条回复真实且稳定的 ID。
const scope = {kind:'conversation', version:2, context_ref:registered.context_ref};
const result = await bridge.reportResponse(scope, {
  response_id: stableSourceResponseId,
  text: approvedFinalUserVisibleText,
  content_kind:'user_visible_response', origin:'source',
  sensitivity:'normal', reviewed:true
});
```

这是来源对自身上下文的声明，不是提供商独立证明。只能用真实来源/会话/线程信息，不导入任意其他用户会话。注册、发布、回执和命令操作分别受服务器权限校验。上下文被撤销或未知时停止，不改走 v1 或换虚构任务。

通过 `createResponseRouter({task,conversation})` 明确选择唯一 kind，避免同一回复同时走 v1/v2。任务对象要求 `kind:'task',version:1` 与真实项目/任务上下文；会话对象要求上述 v2 reference。两种客户端各自使用对应内容审查字段：v1 为 `reviewed_for_secrets:true`，v2 为 `reviewed:true`。不要把同一个未经转换的结构默默发到两个接口。

HTTP 适配器 `conversationHttpTransport({origin,sign,fetch})` 使用 HTTPS `POST /v2/bridge`，严格 envelope `{version:2,kind:'conversation',action,arguments}`。sign 为准确正文 bytes 提供现有来源 HMAC headers，密钥仅从运行时安全存储读取。MCP 工具名为 `bridge_conversation_<action>`。适配器不存密钥、不记录正文、不跟随重定向、不自动重试。

## 内容与命令边界

必须先由来源审查最终用户可见回复。原始思考过程、工具流、用户输入转发、秘密、受限内容、收到的 relay 回声不得上传。SDK 在非 normal、非 reviewed、非 source/user_visible_response 或检测到常见密钥格式时返回固定 `withheld` 状态，不返回正文。模式匹配不是完整 DLP；不能用 reviewed 标记替代真实审查。

响应 ID 跨重试稳定，同 ID 同内容去重、不同内容冲突。网络未知时保存原回执/标识并查询，不生成新 ID 重发。接收、渠道服务接受与接收人确认是三件不同的事。

命令仍由来源主动 claim。SDK 不自动执行，也不承诺唤醒暂停 PA；来源须核对确切 source/context、应用自身政策、获取必要确认。duplicate claim 不执行。仅在真实结果确定时 acknowledge `completed` / `rejected` / `unknown`，不能把领取视为完成。回执里的执行结果只是来源自报。

## 验证范围

controller 测试覆盖 CSRF、严格 schema、scope、TTL、session 和绑定变化、事务内撤销、CAS、离线撤销、长度界限。UI 测试覆盖无自动保存、默认 none、明确确认、过期、401、过时异步结果、关闭/隐藏清理、焦点和只读刷新。SDK 测试用真实 ConversationBridge/schema 验证独立权限、登记、指定范围、去重和命令边界，mock MCP/HTTP 验证实际 v2 路径。

这些离线测试不产生真实所有者同意，不安装真实 PA hook，不发送通知。仍需逐来源安装验收、端到端渠道实收验证与独立查看权限设计后，才能声明相应运行能力已就绪。

## Source operation authority lifecycle

Conversation operation grants are separately configured, default absent. Existing `pa:publish`, `pa:receipt`, task `every_response`, and task QQ response consent do not authorize this protocol. OAuth requires explicitly requested `pa:conversation:publish`, `pa:conversation:read`, or `pa:conversation:commands`; omitted scopes remain the legacy task pair. HMAC requires the separate server operation grant even when its existing signature is valid. No credential or live grant is created by this implementation.

The authenticated `register_context` mutation can establish fresh source connection evidence without creating a task, including a cold HMAC source. Configured provider/account binding, expected connection generation, explicit registration operation, and a nonrevoked operation revision must match first. This is an authenticated source handshake and a source assertion about the conversation, not independent provider ownership verification.

Observed operation-grant removal, disablement, same-revision content change or rollback durably tombstones that revision. Reenable requires a strictly newer revision, new context registration and fresh owner relay consent. Read-only calls do not write the authority ledger or alarms. Source proof expiry alone does not permanently revoke a grant; a lawful same-generation proof refresh remains valid. A deployment rollback that is entirely unobserved by any mutation or alarm cannot be detected by this local ledger; deployment management must maintain a monotonic revision and must not restore old grant configuration.

Relay consent is per source, channel, recipient and `general_conversation_response` category. `all_registered` explicitly means the current and future conversations that this authorized PA registers for this Rivule owner, never all users of a shared bot. The provider adapter must establish the current user's conversation ownership before invoking this hook; authenticated registration alone cannot independently prove that platform ownership. No upstream discovery is performed.

## Offline evidence and live boundary

The development implementation has real-module offline roundtrips for ordinary conversation responses through Discord and QQ, provider-accepted receipts, verified owner commands, exact-context claim and source-reported acknowledgement. It creates no task event/branch or synthetic project tuple. QQ uses a distinct typed protocol and independently verifies standing owner consent through a fixed service binding at both prepare and commit. Legacy task grants cannot substitute.

All examples default off. Deploying code, installing final-response hooks, configuring operation grants or the reverse service binding, enabling channels and observing actual recipient delivery are separate setup actions and have not been performed by these tests. Tool acceptance, queue admission, provider acceptance, recipient confirmation, command claim and source-reported execution outcome remain distinct.
## 共享机器人隔离：必须有真实运行时所有权解析

普通对话客户端构造时必须提供 `ownerBinding`、`recipientBinding` 和 `resolveConversationOwner(context)`。前两者来自受信部署配置，不是消息发送者可覆盖的字段；recipientBinding 是上游提供商中属于此所有者的用户/peer 映射，不是 Discord/QQ 下游转发目标。

受信 provider adapter 必须通过其已认证运行时会话/参与人信息返回 `{owner_binding,recipient_binding,source_id,conversation_id,thread_id}`，与配置及当前精确上下文全部相符。不能实现成“把输入值直接原样返回”，也不能相信响应 payload 的 `reviewed:true`、自称所有者或任意布尔标记。提供商无法提供可靠映射时，不安装此 hook，SDK 必须停止登记和上传。通用 SDK 不能替代真实提供商适配器的安装、所有权验证和权限验收。

注册前后都验证映射，每次发布及 claim 再验证；只允许此 SDK 实例曾通过验证登记得到的 context_ref。重启后用真实 conversation/thread 重新验证并登记，不能直接恢复任意 ref 列表为可信。其他 owner、共享机器人的其他用户/peer、其他 thread/source、未知 ref 全部拒绝，不降级到任务接口。源端登记仍是来源声明，服务器不据此宣称它完成了独立 provider 验证。

## 独立本地目录查看

- `POST /dashboard/conversation/display-access`：`{csrf,source_id,request_id,confirm:true}`，request_id 为每次打开新生成的 UUID。只授予该来源 5 分钟本地会话/线程元数据查看，不授权转发或 PA 操作。
- `GET /dashboard/conversation/catalog?source_id=...&request_id=...&after=...`：现有本人 session + 独立显示 capability；after 是可选上一页 next_cursor。每页最多 20 条，只有 context_ref、conversation_id、thread_id、registered_at、evidence_kind。没有回复正文或提供商远程枚举。
- `POST /dashboard/conversation/display-cancel`：`{csrf,source_id,request_id}`。关闭即清除目录并撤销该请求；取消先于授权到达也不会晚授予，旧取消不能撤销新请求。

查看 grant 与转发 grant 分开存于 session。关闭、隐藏、来源变化、过期、logout 或 source authority 漂移清除目录；后端在读前和返回前重新校验。GET 不写表、不清理、不设闹钟。目录中勾选条目只成为 selected 转发草稿，仍需现有来源/渠道/类别确认；不会自动开启 enabled。没有持久化的隐式会话显示范围。

## 中转规则不等于 PA hook 已安装

所有者界面把“中转规则授权”与“真实观察”分开显示。规则只管理中转；PA 侧仍需按上述方式配置主动上报。最近上报时间、待领取和已领取命令数仅来自本地真实记录；没有上报时显示“等待 PA 主动上报”，缺失或无效数据不制造时间或计数。`source_hook_verified:false` 不会因为设置了开关、登记了会话或存在旧回执而变成已验证。

## 管理信息的查看范围

默认工作台 GET 仅返回静态来源描述，不返回中转偏好、已选 context refs、QQ 状态或上报/命令统计。界面显示“授权后查看”，不把未知当作没有活动。只有明确选择来源与渠道并取得管理 capability 后，才显示该来源、该渠道的偏好和观察记录；任务中转与 QQ 回复管理也分别取得对应权限。

关闭、过期、来源/渠道变更和授权错误会清空已显示偏好、引用和统计，并尽力取消精确管理 token。迟到的授权结果不重新显示私有信息，使用原请求 CSRF 取消其 token；不会取消更新的管理能力，也不会改变持续转发同意。独立目录查看权限不能替代管理权限。
