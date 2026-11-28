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

## 离线预算门测试
`storage/model-budget-fixture.mjs` 默认关闭，输入必须是可信宿主核算的上界，固定本地模拟模型，禁止工具和回退；要求独立权限才能读取前次调用的用量。SQLite 在队列写入一次性名额，按原看板和原任务识别，因此重启、换账号、换授权纪元、换远端运行别名都不重置。账单回执未到、没计入推理用量、超预算都不允许再投；只有同一调用的确切合规回执才进主 Agent 复核。表只有作用域标记、上限和状态，无正文、模型密钥和远端数据。此夹具没有计价或网络传输功能；仓库未接入实际计量、输出截断、模型请求发送和自动扣费。

## 本地模型线级复演（未接真实运行时）

QwenPaw v2.3.0.post1 的 [Ollama provider](https://raw.githubusercontent.com/agentscope-ai/QwenPaw/v2.3.0.post1/src/qwenpaw/providers/ollama_provider.py) 向 [AgentScope 2.0.10](https://raw.githubusercontent.com/agentscope-ai/agentscope/v2.0.10/src/agentscope/model/_openai_chat/_model.py) 传入类型化生成限制。后者的基类使用 `max_completion_tokens`，Ollama [兼容文档](https://docs.ollama.com/api/openai-compatibility#v1chatcompletions) 和[映射代码](https://github.com/ollama/ollama/blob/main/openai/openai.go#L693-L709) 则列出 `max_tokens` → `num_predict`。这是待实装版本抓包核对的拼写风险。不要将“界面已填 1000”当作运行时截断证明。[Ollama 的 SSE 实现](https://github.com/ollama/ollama/blob/main/middleware/openai.go#L126-L150) 将停止、用量和 `[DONE]` 分开发送。

- 本实验使用按上述源码手写的最小入站 JSON 和真实的本机假 HTTP 服务，不是 QwenPaw / AgentScope 进程抓包。宿主仅允许写死的公开摘要、固定假模型和一个上限字段；把列入许可的字段重组为 `max_tokens`，发送前将规范正文哈希和输出上限绑定同一个 SQLite 原任务许可。
- 同一个原任务和授权窗口最多发一个实际 POST。503、重定向、停止帧后断开或额度不明都不重发、不退款、不转其他模型。取得同一模型、同一流 ID 的正常停止、合规终止用量、`[DONE]` 和可见答案，且账号仍有原任务权限后才将结果交给主 Agent；不会向外发布。实测包含两条相互独立的 SQLite 连接、延迟回复时撤销、另一任务正常完成。这里只解析假服务给出的用量；真正的模板分词和推理用量校验尚未实现。
- 等用户选择真实本地实例时，核对 [禁云启动日志](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)、[/api/tags 的模型摘要](https://docs.ollama.com/api/tags)、服务及模型精确版本、渲染后提示词实测分词和上下文余量。空工作区、无工具、无回退，先抓确切客户端请求和上限字段，再做一次真实本地摘要；仅有 127.0.0.1 不足以证明模型未走云端。若找不到隔离实例，不改 V388、不装供应商依赖、不调用真实账户。
- 公开验收题：[TPS 起航事实](https://www.tps.cl/tps-inicio-servicio-cherry-express-con-12-900-toneladas-de-cerezas)及 [ProChile 深圳活动](https://www.prochile.gob.cl/noticias/detalle-noticia/2026/11/18/dan-inicio-a-nueva-temporada-de-cerezas-en-china-en-chileweek-2026)。验收两句：11 月 14 日瓦尔帕莱索启航，388 箱、8,500 吨；11 月 18 日深圳另有新季启动活动。不推断到港。此题是一个人工验收样本，代码不自动判内容。

运行：`node --test tests/qwenpaw-ollama-wire-fixture.test.mjs tests/model-budget-fixture.test.mjs`。
