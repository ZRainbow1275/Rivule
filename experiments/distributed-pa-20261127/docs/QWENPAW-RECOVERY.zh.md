# QwenPaw：断流时接回原任务

仅离线，默认关闭；没有启动实例、登录账号、使用令牌、调用模型或消耗额度。先固定 v2.3.0.post1 的原生 QwenPaw 后端：[控制台 SSE 教程](https://raw.githubusercontent.com/agentscope-ai/QwenPaw/v2.3.0.post1/website/public/docs/api-tutorial.en.md)、[稳定版路由](https://raw.githubusercontent.com/agentscope-ai/QwenPaw/v2.3.0.post1/src/qwenpaw/app/routers/console.py#L411-L534)、[会话 ID](https://raw.githubusercontent.com/agentscope-ai/QwenPaw/v2.3.0.post1/src/qwenpaw/app/channels/console/channel.py#L196-L206)、[历史及状态路由](https://raw.githubusercontent.com/agentscope-ai/QwenPaw/v2.3.0.post1/src/qwenpaw/app/chats/api.py#L766-L867)。Beta 和主干的读取接口须另行测试。

    只签发一次原任务 ──→ 原会话还没确认 ──→ 待人工核查
            │
            └──→ 独立核对实例／版本／Agent／用户／会话／Chat UUID
                     ├── 断流 → 只接回原 SSE（没有 prompt，最多一次）
                     └── 按该 UUID 读历史 → 核对原用户回合与纯文本成果
                                          → 主 Agent 待验收

- 一任务一会话。任务正文只在一次性的模拟出站对象里，台账保存摘要、会话、阶段、绑定及待审文本。两进程争抢原任务、恢复、结果入账，分别至多一次成功。空 SSE、运行/空闲状态和缺失结果不能触发重派。
- 稳定版在 attach 之前走 get-or-create，重连不应作为查找会话的手段。首轮真实试验还需核对独享实例、凭据、真实版本和工具禁用，使用独立网关序列化绑定注销、接回和读取。模拟要求最近 30 秒的精确绑定；不以 SSE 内容冒充鉴权。原 Chat UUID 未知时不发恢复请求。
- 历史接口的响应不复述实例、Agent 或会话身份，从网关核验原请求，并排除其他 App 管理的聊天。上游会把多种消息块标成 completed；这里只允许 idle 状态、专用会话中一条原用户内容与一条完整纯文本助手答复，且摘要和成果标识吻合。工具、推理、分页、第二回合、旧收据和异常均进入待核查。待审内容以纯文本保留，不执行其指令。
- 第一个真实试验只发公开短文本。在启用前确认安装版本、实例权限、隔离措施以及模型和 MCP 的数据去向。

## 与统一任务看板的演练

    主 Agent 拆分 ─┬─ 国内 QwenPaw 断流 → 待核查 → 原会话历史 → 待主 Agent 验收 ─┐
                  └─ 海外 Glean 正常 → 先验收独立任务 ──────────────────────────┤
                                                                      全部验收 → 合稿解锁

- SQLite 同一个事务写入看板的开始事件与 QwenPaw 原派工登记。结果回收同理：供应商台账和候选结果卡一同落地、一同回滚。断电恢复或重复按钮从旧事件拿不到发送许可。
- 套用项目范围、任务 ID、派工代次、地区规则和角色授权。两个看板可以有同名任务，但永远得到不同的会话；旧修订、账号撤销或错误归属必须停住。看板只保留证据摘要，不保存任务正文和成果文本。国内试验原文没有送给海外任务。
- 两个箭头是测试环境内不同的模拟执行通道。主 Agent 的“验收”仍须独立动作；回执与结果均不直接解锁合稿。当前未改变市场清单中的真实试用状态。
