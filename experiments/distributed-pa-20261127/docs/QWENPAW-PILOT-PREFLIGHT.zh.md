# Rivule · QwenPaw 单任务接入验收

目前只做了离线回放。真实工作区、账户、模型或预算尚未开通，也不修改线上 V388。

| 顺序 | 选择 | 通过条件 |
| --- | --- | --- |
| 1 | 用户已有的隔离 QwenPaw 和本地模型 | 独立实例、空历史、无联接工具、无外部模型回退。只提交人为准备的公开短文。 |
| 2 | 无可用本地模型，再单独请用户决定按量测试 | 专用百炼业务空间与凭据；核对具体模型的中国内地部署范围、存储及日志；按量方式和上限须先确认。 |
| 3 | 首次真实闭环 | 只派一项公开摘要；断线只查原任务回执，不重投。结果待主 Agent 验收，不自动向外发送。 |

## 模型与账单

- 不用 Token Plan 或 Coding Plan 跑这一条无人值守后端。它们虽可配置到交互工具，但官方将自动脚本、自建应用后端和非交互批量场景排除在适用范围之外。[Token Plan](https://help.aliyun.com/en/model-studio/token-plan-permissions-and-usage#plan-usage-scope) · [Coding Plan](https://help.aliyun.com/en/model-studio/coding-plan-faq#using-with-dify)
- [北京接入规则](https://help.aliyun.com/zh/model-studio/beijing-access-information)：北京端点表示接入和存储位置；2026 年 10 月 13 日起在该地域上线的模型默认中国弹性区，推理可在规定的其他地域执行。候选 [qwen3.7-flash-2026-07-15](https://help.aliyun.com/zh/model-studio/qwen3-7-flash) 应在实际专用空间确认具体推理范围为「中国内地」，不把主机名当成证明。模型、代理宿主、日志和工具出站分别核对。
- 按该模型在北京不超过 32K 的公开标价，一次 8,000 输入与 1,000 输出模型请求约 ¥0.0024。这是一次模型请求的例算，不是一项任务的总费用。先在模型出口做原子预留并约束调用次数、输入与输出（含思考计费），拒绝未计量或自动回退；可先只准 1 次模型请求、8,000 输入、1,000 输出，需求超出时暂停。服务商[预算停用](https://help.aliyun.com/zh/model-studio/budget-management)可能延迟，只作额外保护。
- 本地优先的资料：[QwenPaw 模型配置](https://github.com/agentscope-ai/QwenPaw/blob/v2.3.0.post1/website/public/docs/models.en.md)。无需现在采购共享账户或 AgentCore Team。不可把个人聊天、原文件、连接器数据或密钥发给试验。
