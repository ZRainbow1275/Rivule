# 下一阶段：普通对话上下文（未实现，不构成授权）

本批协议只接受真实已上报任务的 project/task/run/branch/thread。SQLite 登记记录显式限制 context_kind='task'，来源能力列出 context_kinds:['task']。不能省略 ID、使用占位 ID 或复用任务授权来发送普通聊天。

后续独立 v2 协议应采用互斥的上下文类型：

- task：{kind:'task',source_id,project_id,task_id,run_id,branch_id,thread_id}。继续核验已有任务、项目允许列表、当前来源绑定。
- conversation：{kind:'conversation',source_id,conversation_id,thread_id}。禁止出现 project_id/task_id/run_id/branch_id；不创建进度、任务状态或项目授权。

conversation_id、thread_id 必须由已认证来源显式登记并证明属于当前受控会话。来源及 owner 双方都不能通过自由文本猜测它们。用户指令只关联到提供商确认接收的、当前授权的不可变消息，或所有者明确选择的登记上下文。

普通对话需要独立持久授权，至少绑定 owner、来源及连接代际、context_kind、渠道、实际接收人、允许的消息类别。旧 task_updates、每次任务回复以及 QQ 任务通知授权均保持不变，不能自动迁移成 conversation 授权。来源端应使用明确的 conversation 发布/指令操作范围，不能悄悄扩展旧 pa:publish 令牌。

消息应进入独立的 user-visible-message 日志与顺序游标，renderer 不显示完成率或任务阶段。接收回执仍分别表示 accepted、queued、provider_accepted、unknown 与 recipient_confirmed；最后一种必须有真实接收证据。

复用已验证的控制原则：固定可信 owner 验权端点、当前接收人绑定、撤销代际与新事件起点、来源主动领取、领取丢失不重发、TTL 清除正文、独立来源策略、安全分类与来源 hook 排除回声/思考/工具流。不存在源运行时 hook 或主动拉取能力时，明确报告接入缺口，不承诺自动截获或唤醒。

这一文档是工程差异说明，不启用新权限、不修改部署、不代表此功能已经可用。
