# PA 主动消息桥接：来源侧 hook

状态：本仓库提供通用、可测试的来源客户端，不代表已在 dot、Muse、Grok 或任一提供商安装全局 hook。无需、也不能靠此 SDK 拦截所有提供商响应。PA 或其受控运行时必须主动调用 Rivule。

## 当前范围：task_context_only

服务器能力 `context_support: registered_existing_task_only` 表示仅支持已上报、已获准项目内的真实 task/run/branch，以及其真实来源 thread。普通对话回复不支持。不能创建占位项目或伪造任务 ID 来绕过此范围。

- 默认 `task_updates`：通过已有 `publish_task_update` MCP 或任务 HTTP 接口上报任务事件。
- 所有者明确选择 `every_response`：每次最终用户可见的任务回复后调用 `bridge_publish_response`。UI 用语是“每次任务回复”，不是所有普通对话。
- 每个 PA 独立选择模式和指令回传。读取、打开设置、编辑选项不保存设置。
- 5 分钟仅为所有者管理权限。已保存的转发选择持续有效，直至关闭或相关授权绑定变化，不要求用户每 5 分钟重新同意转发。
- QQ 用户可见回复有独立的所有者接收人 / 来源 / 类别授权；不能用普通任务通知授权替代。该授权不启动网关、不恢复已暂停通知、不证明消息实收。QQ 当前会话、接收许可、预算和队列仍分别校验。

## 接入顺序

1. 所有者配置来源和允许项目；来源通过自己的 MCP OAuth 或 HMAC 凭据认证。不得借用另一个 PA 身份。
2. 来源先通过既有任务事件接口上报真实任务。读取 `bridge_capabilities`，核对 `source_id`、模式和当前能力。
3. 在该真实任务 / thread 上显式调用 `bridge_register_context`。同意或绑定变更可能使旧登记失效，核对最新状态后再登记。SDK 不静默替你重新登记。
4. 在来源实际生成最终用户可见回复的位置安装 hook。完成自身内容审查后调用下例。收到 Rivule 转发消息时不再次调用这个 hook，避免回环。
5. 保存原始 `response_id` / `event_id` 和收到的回执。网络结果未知时不要换 ID 重发；用原回执核查。同 ID + 同内容重试由服务器去重；同 ID + 不同内容被拒绝。SDK 不自动重试，不自动生成标识或递增任务序号。

```js
import {createSourceBridge, mcpBridgeTransport} from '../src/sdk/source-bridge.mjs';

// client 是该 PA 已正常授权的 MCP 客户端；这些变量来自真实运行时。
const bridge = createSourceBridge({
  source_id: configuredSourceId,
  call: mcpBridgeTransport(args => client.callTool(args)),
  publishTaskUpdate: event => client.callTool({
    name: 'publish_task_update', arguments: {event}
  })
});
const task = {project_id, task_id, run_id, branch_id, thread_id};
await bridge.registerContext(task);

// 持久化的来源响应 ID，重试时必须保持原 ID 和原正文。
// 仅在来源自身安全审查通过后设置 reviewed_for_secrets。
const result = await bridge.reportResponse(task, {
  response_id: sourceResponseId,
  text: approvedFinalUserVisibleText,
  content_kind: 'user_visible_response', origin: 'source',
  sensitivity: 'normal', reviewed_for_secrets: true
});
// result.state === 'withheld' 时仅记录状态/原因，不记录被扣留正文。
```

任务更新用 `bridge.reportTaskUpdate(event, {reviewed_for_secrets:true})`；它保留既有事件结构和 ID，交给注入的任务发布函数。事件仍须满足实际服务器 schema；此便捷方法保守限制完整序列化事件至 1200 字符，较长事件使用既有接口并执行同等安全审查。`publishTaskUpdate` 返回的 MCP 结果仍需检查 `isError`，HTTP 返回亦须检查状态，不能把成功发起调用当成成功上报。

## 内容边界与凭据

禁止发送原始思考过程、工具调用/输出流、受限内容、凭据、收到的转发回声或未经审查的消息。SDK 默认扣留未分类、非正常敏感度、未审查和非用户可见的内容；附加常见密钥格式检测只是补充，不能证明任意文本不含秘密。来源必须审查整个事件和正文，包括嵌套字段；不要通过标记 `normal` 代替真正审查。

`withheld` 仅带固定原因，不含正文。SDK 不写日志、不保存密钥。凭据从运行时环境 / 安全存储注入，不能嵌入代码、示例、日志、事件或用户命令。绑定身份由服务器鉴权决定，SDK 的 `source_id` 只用于交叉核对。

HTTP 适配器 `httpBridgeTransport({origin,sign,fetch})` 发往实际 HTTPS origin 的 `/v1/bridge`，正文严格为 `{version:1,action,arguments}`。`sign(bytes)` 使用运行时 HMAC 密钥为这些准确字节生成 `x-pa-source`、`x-pa-timestamp`、`x-pa-signature`；签名规则见 [现有 HTTP 接入](INTEGRATIONS.md#http) 与服务器实现。适配器不实现 OAuth 获取、不自动跟随重定向、不自动重试。不要把 Muse Bearer 事件接口的鉴权混用到此 HMAC 路由。MCP 对应 `bridge_<action>`，工具 schema 以 `tools/list` 为准。

## 指令回传不是执行授权

当前 transport 为来源主动拉取。来源必须有运行中的轮询/调度能力；Rivule 不承诺唤醒暂停的 PA。

`claim(task, stableClaimId)` 只领取精确上下文的最多一条指令。SDK 没有执行回调、shell 或自动执行功能。来源必须：

1. 核对用户、任务和来源上下文；按自身授权、平台政策和逐次确认要求决定是否执行。
2. 不执行 duplicate claim，不因超时自动再次执行。保留 claim ID 和原结果；未知结果先核查。
3. 仅在确有结果时 `acknowledge({command_id,claim_token,outcome})`，其中 outcome 为 `completed`、`rejected` 或 `unknown`。收到或领取不等于完成，不能提前回报 completed。

这些是来源自报状态，不是服务器独立验证的执行事实。对外显示也应保留这一差别。

## 验证与上线边界

`tests/bridge-source-sdk.test.mjs` 使用 mock transport 与真实 MessageBridge / schema 验证内容扣留、来源隔离、真实任务登记、幂等、HTTP 字节签名及无自动执行。`tests/dashboard-bridge-controls.test.mjs` 验证管理权限与明确确认分离、到期、取消、401、过时响应、刷新和焦点恢复。

测试不产生真实所有者授权、不调用外部 PA、不发送实际消息。安装提供商 hook、端到端通知实收、网关运行和真实命令执行必须分别验收。回执区分服务端接收、渠道 provider acceptance 和接收人确认；不可将其中一个冒充另一个。
