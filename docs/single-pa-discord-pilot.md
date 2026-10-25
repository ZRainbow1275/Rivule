# 单 PA、单会话、本人 Discord：首次验证

先验证一次主动调用和指令回传，不先开启全部会话或自动每次回复。MCP 协议提供六个 `bridge_conversation_*` 工具；实际入口须包含 f7e413b 的 OAuth facade 接线修复，不能仅凭 tools/list 存在判定可调用。修复部署后可直接调用，无须先安装 HTTP SDK。自动每次最终回复调用才需要 PA 运行环境支持。

## 1. 找回已有工具清单，不新建连接

先核对原连接详情中的真实 MCP endpoint 与来源绑定，不凭显示名称认定身份。当前候选为 `zot-main`，但有效 initialize / generation 只证明该来源已认证，不能证明上游账号或当前线程归属。

官方当前入口（2026-10-25 查阅）：
- 直接自定义 MCP：打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，进入原连接，选择 **Refresh**，核对新增工具与说明，再在新会话复测。[官方刷新说明](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)
- Legacy workspace app：Workspace settings → Apps → 原应用的 ⋯ → Action control → Refresh。新增 actions 默认禁用，是否启用须单独确认。[官方管理说明](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
- Published plugin 使用发布审核更新，不套用直接连接刷新流程。若入口不符，先确认连接类型，不删除重建，不猜测 OAuth 权限，也不通过插件工具权限设置推断 token scopes。

刷新只更新清单，既不授予会话 OAuth scopes，也不启用转发。旧 token 的 `pa:publish pa:receipt` 不足以调用会话工具。

## 2. 准备真实身份材料，再确认最小权限

操作方须记录以下事实的可信出处，不要求用户在聊天中贴凭据：
- 原连接所绑定的 `source_id`，配置中的 `provider_id`，当前 source proof 的 generation。
- 此 PA 所属上游账号与本 Rivule 所有者的对应关系，以及本次真实 conversation/thread 标识和归属证据。host 可验证元数据或本人明确核对的准确账号/会话资料可作为人工验收材料；无法确认则停在准备阶段。
- `account_binding` 是部署时指定、用于固定这份已核对映射的稳定非秘密标识，不是自动发现的提供商账号 ID。可以使用记录在受信配置中的不透明映射标识，但必须先有实际映射证据；不能直接把 source label、OAuth client ID、Discord owner ID 或 generation 当成上游账号证明。不得声称平台独立验证。

对于单人 dot 试验，已验证所有者可以明确确认“此 zot-main 连接对应我的当前 dot，只使用本房间”。将可信 delivery metadata 的 room_id 记录为此扁平房间的 conversation_id 和 thread_id（两者相同，明确没有声称平台子线程）；如要选择房间内独立子线程，才需真实 host 元数据。随后由操作方创建非秘密随机映射标识作为 account_binding，并记录本人确认的来源，不需要提供商独立验真或用户找一个不存在的 provider account API。此映射只限该已确认身份，不能自动覆盖其他 PA/用户。

当前产品没有生成或核验上述上游映射的管理向导。缺少映射时，点击工作台开关不能补足它。`CONVERSATION_OPERATION_GRANTS_JSON` 由部署方在明确授权后配置，页面本身不扩来源权限。

最小完整双向试验授权包：
1. 仅选定 PA 的 `pa:conversation:publish`、`pa:conversation:read`、`pa:conversation:commands` OAuth 权限；保留原 task scopes 不意味着扩大其他来源。通过 host 支持的明确请求 scopes 的重新授权流程完成，不手工拼接缺 client/state/PKCE 的授权 URL。若 host 无法请求新增 scopes，先解决该能力缺口，不默认改全体来源 OAuth scope。
2. 仅该 source 的来源操作授权：`register_context`、`publish_response`、`response_receipt`、`claim`、`acknowledge`，精确 provider/account/generation，使用经核对的单调递增 revision。这个操作授权是来源级；下述中转同意才限制到一个会话。无 QQ binding、无新服务账号、无其他 PA 权限。
3. 只允许一个已核对会话向原本人 Discord 私信转发，开启此会话指令回传；不选择 `all_registered`。准许一次明确的无敏感测试回复，和一次“仅确认收到，不执行其他动作”测试指令。测试后保留还是撤销需按授权范围处理，不默认为持续所有回复。

## 3. 在 Rivule 保存单会话中转规则

先由已授权 PA 调用 `bridge_conversation_register_context`，传真实 conversation/thread，保存返回的 context_ref。注册不发送 Discord，也不证明提供商独立认证。

在已登录的 Rivule 工作台：
1. **管理普通对话中转规则** → 选准确 PA → **Discord** → **授权管理 · 5 分钟**。
2. 若提示来源/渠道未就绪，不绕过；先检查前一步权限与现有 Discord 配置。
3. 使用本地登记目录的独立查看授权，选刚登记的一个真实上下文；或在高级引用输入中填已核对的 context_ref。目录标识是来源声明，不读取提供商全部会话。
4. 范围选指定会话，开启中转和指令回传 → **核对并保存** → **确认此来源、渠道和范围**。核对接收说明是原本人 Discord 私信。

## 4. 分段验收，不把 queued 当实收

PA 调用 publish_response，只提交正常、用户可见最终文本，长度不超过 1200 UTF-16 单元，不含工具流、思考、秘密、媒体或其他用户消息。保持稳定 response_id，不因超时换 ID 重发。通过 response_receipt 区分 accepted、queued、provider accepted、unknown；由用户确认 Discord 实际可见后，才记实收。

用户在对应卡片发出测试指令；PA 在同一 context_ref 主动 claim，核对原请求者/上下文并按自身政策处理，最后 acknowledge 真实结果。不承诺唤醒暂停 PA。完成一次闭环不等于已配置每次回复自动调用。

本指南不执行上述授权或发送。OAuth 扩权、来源 grant、持久转发同意和测试消息均须落实各自的明确授权；刷新动作不代替它们。
