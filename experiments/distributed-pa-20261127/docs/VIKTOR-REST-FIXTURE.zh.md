# Viktor REST：创建线程已经派工

[REST 官方说明](https://viktor.com/docs/public-api) · [MCP](https://viktor.com/docs/mcp-server) · [托管地区与数据说明](https://viktor.com/security) · [隐私](https://viktor.com/legal/privacy)。

    一条公开短任务 ── 事务内签发一次 POST /threads ──┬─ 202 有原三 ID → 只读原 run
                                                     └─ 没有 ID → 只核原回执，不会重发
     原 run ─┬─ completed + 文本结果 → 主 Agent 待验收
            ├─ requires_action + 问题 → 保留原工作等待决定，无自动回答
            └─ 失败／取消／超时 → 待证据，不解锁合稿

- 只浏览公开文档。离线夹具固定一个专属合成账号、工作区、通道和公开输入。最少的三个 scope 仍需另行真实授权；Viktor 的 runs:create 同时包含取消能力，接口主机必须拦住取消、续发、文件下载和脚本。无浏览器、登陆、令牌、付费、任何 provider 网络调用。
- 用 ID 定位线程、消息和原执行，读回计划只允许 GET 原 run 和其 result。等待在时间窗内超时与实际运行报为 timed_out 是两件事。前者用原 ID 查，后者只进终态待证据；无 ID 永不另建线程或自动复用 idem key。官方没有公布 replay 期限。
- 状态和结果在测试里用独立可信网关归一化收据；实时 endpoint 形状仍须实际获准使用官方完整 schema 核对。只有同源同 run 的有限纯文本给待审者；摘要留台账；附件、脚本、Markdown 动作指令和自行继续不在范围。当前没有将 Viktor 连进生产板或发送给其他 Agent。
- Coworker.ai 的 [Agent Builder 触发](https://intercom.help/coworker-ai/en/articles/14759188-configuring-triggers-for-your-agent) 与 [人工执行历史](https://intercom.help/coworker-ai/en/articles/14799776-understanding-your-agent-execution-history) 分开记录。它的 [MCP](https://intercom.help/coworker-ai/en/articles/14745496-coworker-mcp-overview) 有不同的授权和工具面，保持 schema 待查，不用未知合约假装可收成果。

## 主 Agent 任务板演练

本地、默认关闭的 SQLite 桥接共享同一事务。任务板锁定派送与 Viktor 样本原请求保留记录一并写入；已知原请求的回执才可以进入查状态。核对原任务、原运行编号和当前修订后，把核查结论与任务板状态一起写入。两边任何一处写入失败，双方都回到原状态。

| 样本回执 | 任务板 | 其余任务 |
|---|---|---|
| needs input | 待补充资料。冷重启后保留状态，不自动回复、不重试派送、不把问题当成成果 | 无依赖的任务照常；合稿继续锁定 |
| completed | 已交稿，等待主 Agent 对准确摘要单独验收 | 验收后才解除依赖 |

问题原文仅经过测试内存，不写入任务板或 SQLite。快照只显示状态和授权可见的任务。没有内置回答按钮，没有真实密钥，也没有请求过真实 Viktor。运行 `node examples/rebuild-verified-replay.mjs --check` 可直接从 SQLite 回归重现放进看板的四个画面。
