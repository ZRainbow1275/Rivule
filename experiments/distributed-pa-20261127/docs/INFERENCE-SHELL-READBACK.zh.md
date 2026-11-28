# inference shell Agents：一原任务、一空会话、一次派送

**阶段：公开接口已核对，离线只读判定已有合成测试。尚无账号绑定、HTTP 执行器或生产开关。QwenPaw 仍是第一试点。**

| 顺序 | 可信宿主要执行的步骤 | 异常落点 |
| --- | --- | --- |
| 1 | 任务仅公开短文本。独立空间、私有新会话、固定文本 Agent 版本、无工具/无钩子；核模型地域、留存、费用 | 未核实就不绑定 |
| 2 | 创建空会话，验证初始无消息、无 run；持久写入原任务和尝试号所拥有的 chat ID，再签发仅一次的消息许可 | 创会话断线后不得猜 chat ID；不给派送许可 |
| 3 | 仅在原 chat POST 一条，不走合并创建与发送的便捷路由 | 回包丢失仍可在服务端运行；不重发 |
| 4 | 从该 chat 的完整历史和该 chat 的 run 列表，再用单 run 的读权限核对终态；不得截断分页 | 额外消息或 run、排队、无回复、超限、权限变化，都留原任务待核 |
| 5 | 有清晰完整文字时，仅以原 run 回执和结果摘要进入主 Agent 验收 | 主 Agent 明确验收后，合稿才解锁 |

公开 REST transcript 示例没有给 assistant 消息展示可直接绑定的 run ID。当前夹具仅重演「预先确认空会话、唯一写入者、恰一组输入/答案/终态与恰一个 run」的保守关联。audit 字段是受信宿主归一化后的合成观察，不是可凭供应商回包取值的标志，也不是 API JSON schema。验证结果只回摘要，不放原问题与答复；只读判定不写队列、不签许可。实际试点须另外核对 run 详情身份和读回竞态，拒绝并发写入，绑定审批世代，先拿真实 wire 夹具。A2A 是同一供应商的另一入口，按真实 Agent Card 核能力；不因示例卡自动启用。这里不做自动接收或重试。

官方出处：[建空会话](https://inference.sh/docs/api/rest/agents#create-chat)、[消息与排队](https://inference.sh/docs/api/rest/agents#send-chat-message)、[终态](https://inference.sh/docs/api/rest/agents#run-endings-in-the-transcript)、[原 run](https://inference.sh/docs/api/rest/agents#agent-runs)。相邻目录的 Poppy 是企业互通，TaskBullet 是真人服务；两者都不扩大个人 Muse 席位的自动派送。
