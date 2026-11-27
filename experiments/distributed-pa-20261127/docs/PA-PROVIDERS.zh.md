# Rivule｜个人助理接入证据与首轮选择
核查：2026-11-27 北京时间。以下核的是提供方公开接口及 Rivule 已有接口的方向；本轮未使用用户凭据、未向任何 PA 发任务。

## 优先接哪三条线
1. **境外全流程：Manus Cue。** 可以找到具体 Cue 身份、投递任务、回读原会话，最适合首个“从派工到验收”的外部适配器。
2. **国内全流程：百度搭子 DuMate。** Agent / Session / Event 天然对应人员／工作单／活动流；先订阅、后投递，掉线可用历史事件追平。
3. **多 Muse 协作：反向认领。** 同一主 Agent 让经过独立授权的 Muse 席位取走不同工作单。Rivule 发出“可领”与 Muse 实际接单是两个事件。每个席位只看到分给自己的项目和交付物。

### 首轮能力矩阵

| 提供方 | 经官方资料核实的方向 | 能验收什么 | 关键约束 |
|---|---|---|---|
| **Manus Cue** | Rivule → 已有 Cue 的持久主会话；可轮询消息，查该身份生成的子任务。[Agents](https://open.manus.ai/docs/v2/agents-overview) | 用 `agent.list/detail` 解析经批准的 agent ID → 主 `task_id`；在同一主线程串行发送、以发送前游标/消息 ID 和输出工件关联工作单；没有匹配结果就待核 | 查身份仅账户 API Key 或 Trusted OAuth；普通 OAuth 不支持此端点。[agent.list](https://open.manus.ai/docs/v2/agent.list) 账户 Key 权限广，不给前端；同一用户所有 key 合并限流：发 10 次/分钟，读消息 100 次/分钟。[鉴权](https://open.manus.ai/docs/v2/authentication) · [限额](https://open.manus.ai/docs/v2/rate-limits) |
| **豆包 · 小豆** | 开发者已发布独立消费者 App，可在个人指令与授权下做待办、查询、购物售后等。[开发者商店页](https://apps.apple.com/cn/app/id6815582077) | 用户可以复制工作单到小豆，在 Rivule 粘回简报并明确标作“人工回传” | 在所核官方资料中未找到第三方可直接投递和读取小豆任务的协议；不要代用火山方舟或扣子，另行登记这两类产品 |
| **蚂蚁 · 灵光** | 灵光 2.0 可主动调用外部 MCP、CLI，依授权在云端跟进任务。[蚂蚁发布稿](https://www.antgroup.com/en/news-media/press-releases/1793066400000) | 候选为灵光主动向 Rivule 领单/回报；只有账户实际支持并走通目标自定义工具且有来源回执，才升为可领单 | 暂无查实的灵光开放派工/状态查询 API；不能倒置 MCP 客户端与服务端的方向。支付宝开放平台、蚂蚁基础模型并非灵光 PA |
| **Meta Muse** | 个人可让 Muse 创建自定义 Connector，凭据进 Muse 的安全存储；面向公众的目录提交另有审批。[个人连接器](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/) · [目录审核](https://platform.muse.ai/docs) | 每个自有、获授权席位分别领取并回报；先验回执，再验工件。已有 Rivule `/v1/muse/health`、`/events`、`/receipt` 是 Muse→Rivule 的来源接入，不是 Meta 给外部的启动 API | 用户达到授权边界时仍须确认；已核官方公开资料没有给出按 Muse 个人账号静默发起任务的通用 API。账号池取决于合法独立授权的身份，而非 key 个数；不得借轮换绕限额。Muse 分地区推出：[英国公告](https://about.fb.com/news/2026/11/introducing-muse-in-the-uk-a-personal-ai-agent-you-control/) |
| **百度搭子 DuMate** | 新版 /api/dma/v1 绑定 Agent 版本与 Environment 创建 Session，订阅 SSE、发 user.message；可按 Last-Event-ID 续传或补拉历史，支持 Skills/MCP、用户独立 Vault。[11 月 13 日官方指南](https://cloud.baidu.com/doc/Dumate/s/8mwc0j8yi) · [SSE](https://aca.bce.baidu.com/doc/Dumate/s/kmwbl5n43) | 入队事件 processed_at=null；真正开跑看 status_running，结束看 status_idle/end_turn 与工件。单 Agent 最多 20 个 MCP 服务；每个终端用户隔离凭据 | 账户 API Key 可访问该账号 Agent 和数据，先限定租户与目标 agent；开发者创建的 Agent 与用户原有桌面搭子的记忆不能混称 |
| **Poke** | V2 Bearer Key 向 `/api/v1/inbound/api-message` 发送消息，正文整个 JSON 都会交给个人助理；可另连自定义 MCP。[入站 API](https://poke.com/docs/api) · [外部 MCP](https://poke.com/docs/mcp-servers) | `success:true` 仅表示进入 Poke 会话。只有后续收到了指定工件/结果回执，才可推进至“待验收” | 不送完整工单历史、凭据或私人邮箱数据；该入站文档没有给出可直接取回执行结果的接口 |
| **千问办公 QwenWork** | 客户端可接自定义远程 MCP，支持 Streamable HTTP/SSE 及认证 Header。[阿里云连接器指南](https://help.aliyun.com/zh/qwenwork/qw-connectors-1) | 接 Rivule 受限工具，让 PA 主动领取、回报 | 这是千问办公，不把它记成“千问 Go”或境内通用远程任务 API |
| **腾讯 WorkBuddy** | 用户安装远程 MCP 连接器，可配 OAuth 或令牌，配套 Skill 定义操作步骤。[官方连接器规范](https://open.workbuddy.cn/docs/connector) | 让 WorkBuddy 在授权内主动认领，传证据和工件 | 静态令牌模式要求客户端最低 4.23.0；只向 Rivule 服务提供该席位的权限，不能跨用户取数 |
| **豆包开放平台**（另外一项） | 豆包官方把“将 Rivule 装进豆包对话的插件”和“开发者应用调用豆包 OpenAPI”分开。插件可定义 Skills＋MCP；MCP Events 可触发用户事先设定的任务。[官方插件指南](https://open.doubao.com/document) · [应用权限](https://open.doubao.com/document/store-app-development/development-configuration/request-and-manage-api-permissions) | 可评估发布为豆包的领单工具，按平台纳入、认证、用户安装分别显示状态 | 官方主页写明平台在内测。[平台状态](https://open.doubao.com/) 不把豆包工作、远程业务卡或应用调用能力记在“小豆”身份上 |
| **自托管 OpenClaw**（可选运行时） | 默认关闭的入站 Hook 能指派白名单 Agent，支持 Idempotency-Key 和可选 waitForCompletion。[官方入站 Hook](https://docs.openclaw.ai/automation/cron-jobs/webhooks) | 默认 HTTP 200 只拿到准入与 run ID；等完成可拿执行/投递状态，仍须独立拿输出工件 | 固定允许的 agent、禁任意会话键、仅私有授权网关。部署地点与模型服务处理范围独立登记 |
| **扣子 CN / Coze 国际**（可选 Agent 平台） | 调用已发布 bot，按 user、conversation 和 chat 追踪；两站分别绑定端点和租户。[扣子对话](https://docs.coze.cn/developer_guides_chat_v3) · [消息结果](https://docs.coze.cn/developer_guides_list_chat_messages) · [Coze 国际](https://www.coze.com/open/docs/developer_guides/coze_api_overview) | 用匹配 conversation_id、chat_id 的 assistant answer 验结果，工具过程、流分片不算结案 | 这是平台上的既定 bot，不是豆包的小豆。数据与凭据按站和主体隔离，超时不自发切区 |

**工具与身份的区分：** `有文档`、`本产品有适配器`、`用户已授权`、`实际通端得到回执` 四格分别显示。只读健康检查达到的仅是连接有效。个人助理提供发邮件、付款、电话等能力，不自动纳入 Rivule 的派工白名单。

### 一个可当晚走的验收任务
选一份用户指定的公开产品说明书，由国内的搭子抽指标、国际的 Cue 核英文原文；另一个已绑定的 Muse 席位只对比这两份**脱敏结果**。主 Agent 先定义交付物的字段、引用要求和谁可以读，让两个子任务独立运行。只有收到 provider 真实回执、各自的结果、主 Agent 对引用的验收后，主卡才进“完成”。中途若 Cue 请求授权，停在该分支并显示原因，国内分支继续。初次真实派单需通道配置、凭据和任务范围齐备后再进行。

**多账号升级门槛：** 席位是已授权的独立执行身份，不是共享会话/凭据；同一工作单一次只有一个有效接单凭据（lease＋generation）。旧席位迟回可留作审计，不能覆盖新结果。发送超时未明先查询，不从国内/外账号补发相同副作用。统计用可按时交付、能验证的任务数，而非接口个数。

## 可查阅、可认领与可派工是三个层级

- **腾讯元宝**：企业资质审核后，合作方可上传 `SKILL.md`，以 Streamable HTTP／OAuth 2.0 配置远程 MCP Connector，勾选工具、联调并提交评测。它适合在用户主动问起时查同一张看板。离线实验现在只允许读总览和单卡；不声明自动唤醒、外派或个人客户端可用。[平台介绍](https://open.yuanbao.tencent.com/docs/overview) · [Connector](https://open.yuanbao.tencent.com/docs/mcp-integration) · [评测用例](https://open.yuanbao.tencent.com/docs/test-case-sample)
- **WorkBuddy Managed Agents**：与普通用户版远程 MCP 不同。企业管理 API 创建会话非幂等且启动计费沙箱。每次只给一个已核定、专用且有预算的席位留一个活跃 prompt；断 ACP 连接不等于关闭沙箱，收到历史回放不等于本轮开始或有结果。不自动复用整个账户的最新会话。[企业直连](https://cloud.tencent.com/document/product/1831/140759) · [开通、计费](https://cloud.tencent.com/document/product/1831/140272)
- **A2A 1.0.1**：供应商可以按 messageId 去重，协议没有统一保证。List Tasks 的筛选没有 messageId；第一回包丢失时，taskId 和 contextId 可能还未知，空列表不能证明未派出。Rivule 应把原尝试证据保留在账本里；在核明前不重新派工、换号或把收到回执写成已验收。A2A 在此是网关协议，不代表上面列出的消费产品已有接口。[幂等](https://a2a-protocol.org/v1.0.1/specification/#331-idempotency) · [任务列表](https://a2a-protocol.org/v1.0.1/specification/#314-list-tasks)
