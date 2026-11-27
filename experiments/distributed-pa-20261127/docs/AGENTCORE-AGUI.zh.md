# Rivule 与阿里云 AgentCore：先试单一 Worker
[托管 Harness AG-UI](https://help.aliyun.com/zh/agentcore/ag-ui-protocol-reference) 和 [Team](https://help.aliyun.com/zh/agentcore/using-team-tasks) 分开登记。前者明确能接收一次原任务和重新接原流；后者提供班组、工作房间、特定 Worker 和评审卡片，公开 API 索引未找到从 Rivule 创建、查看和取回团队任务的闭环。Rivule 仍是协调者和验收权威来源，不为测试单一 Worker 购买协作管控面。

离线测试是一份小协议模拟，关闭默认行为，不读凭据，不调用阿里云。主 Agent 固定地域、工作单、主体、账号、Harness 及审批摘要后最多发放一次原任务请求。模拟响应由受信测试夹具提供，以会话和原请求凭证关联。模拟每次只处理一个完整事件，把游标和该事件的影响写入同一 SQLite 事务。掉线后只有已看到原 RUN_STARTED、已经持久化事件序号且原 Harness 启用 Attach 才可尝试。原 threadId/runId 和会话头保持不变，messages、tools、context 为空，游标取最后落盘事件。原启动只给一次，恢复最多一次；无游标、运行已结束、他人占用相同流、进程已重启或不支持时转人工核查。

| 候选结果 | 到达条件 | Rivule 后续 |
| --- | --- | --- |
| 待验收 | 同一执行成功结束；只有一个完整有内容的助手消息 | 返回原文与摘要，只存摘要；主 Agent 独立验收 |
| 等待输入 | 同一执行以 interrupt 结束 | 不自动答复或重派 |
| 待核对 | 运行结束但没有完整正文、事件间隔、重复下线或不支持 Attach | 不另开 run、不借其他 PA 执行同一请求 |

官方要求事件 ID 递增，本实验刻意只验连续编号、单一文本消息的最小档；不自行假设跳号一定代表丢包，也不实现推理、临时文件、工具调用、取消或人审续接。事务测试数据库只暂存合成公开文本片段，结束清除正文。若未来处理真实公开材料，应另行复核内容用途、记录保留和归属。若提交事务后调用者丢失正文，当前仅能读回摘要，留给人工；不会重开任务。

[计费说明](https://help.aliyun.com/zh/agentcore/agentcore-billing-instructions) 与 [上海示例](https://help.aliyun.com/zh/agentcore/enterprise-billing-and-cost-management-best-practices)：专享协作管控面参考每小时 3 元，720 小时约 2160 元，另有模型、算力、网关等。单独测试 AG-UI 不等于同意开通 Team，真实账号和账单未核。
