# Rivule × 百度搭子 DuMate｜国内企业 Agent API 适配器

**状态：24 项离线契约测试通过。默认关闭；未接入真实账户、未发送真实任务。** 本包只做一个面向已有 DuMate 企业 Agent 的任务通道，不创建账户、Agent、环境、MCP、技能或凭证库。没有依赖包、默认网络客户端或读取环境变量密钥的代码。

```text
主 Agent 批准这份输入、席位、项目、区域、版本与预算
  → 账本领取本代的“建会话”写许可
  → 固定 Agent 版本 + 环境 + POINT 预算，创建专用空闲会话
  → 核对回显：无工具/MCP/技能/文件/子 Agent、无资源/凭证库
  → 将会话 ID 存入恢复账本，先订阅 SSE
  → 账本领取“发消息”写许可，只发送批准的纯文本
  → POST 回显：sevt_…，processed_at 为 null                    [已入队]
  → SSE 同条 user.message + session.status_running             [已运行]
  → 完整 agent.message + session.status_idle/end_turn          [待主 Agent 验收]
```

例如：**“核对产品说明里的三个尺寸”** 可以派给国内席位。消息入队后，看板仍没有结果；模型输出了文字，看板仍没有“完成”。收到同一会话本轮结束的回执才交出候选文本与事件 ID，主 Agent 另验尺寸、单位和引用。演练只用合成夹具。

## 已实现的四个官方请求

固定前缀 `https://api.dumate.cn/api/dma/v1`。由服务端注入传输，禁重定向、附带浏览器凭据与缓存。客户端不能传 URL、请求头、远程接收身份、命令或任意会话 ID。

| 方法、路径 | Rivule 的使用范围 | 官方依据 |
|---|---|---|
| POST `/sessions` | 使用已授权 Agent ID、整数版本、环境；先建空会话，不发送 initial_events | [快速开始](https://cloud.baidu.com/doc/Dumate/s/8mwc0j8yi) · [创建会话](https://cloud.baidu.com/doc/Dumate/s/8mwbkjyq6) |
| GET `/sessions/{id}/events/stream` | 先完成订阅；只接完整帧，本地可按上次完整事件 ID 续读 | [订阅会话事件流](https://cloud.baidu.com/doc/Dumate/s/kmwbl5n43) |
| POST `/sessions/{id}/events` | 一次仅发一条纯文本 user.message；核对标识、原文和空处理时间 | [发送会话事件](https://cloud.baidu.com/doc/Dumate/s/zmwbkrj9r) |
| GET `/sessions/{id}/events?order=asc&limit=50[&page=…]` | 逐页从头对账，检查缺页证据、游标循环、重复标识和冲突 | [获取会话事件历史](https://cloud.baidu.com/doc/Dumate/s/Pmwbl2gn3) |

> POINT 预算是服务端的事前检查；百度说明模型调用结算可能滞后并略过所设阈值。需严格硬封顶的任务先不启用此通道。[预算字段说明](https://cloud.baidu.com/doc/Dumate/s/8mwbkjyq6)

## 失败之后，看板显示什么？

| 情况 | 本适配器行为 |
|---|---|
| SSE 断开，有完整事件 ID | 返回已知进度与断点。由上层显式发起只读续传，发消息计数不变。 |
| 恢复游标被 400/409 拒绝，或一帧都没有 | 停用该游标。本原型选择一直用正序历史补全，不在补完和重新无游标订阅之间留下空窗。 |
| 发消息后超时或收到损坏回显 | 标为“投递不确定”，保留会话，允许只读对账。历史中同文只算人工核验线索，即使没搜到也不重发。 |
| 本轮需确认、预算达到、拒答、重试耗尽 | 分别标为待用户处理/提供方停止；不执行确认，不补派其他席位。 |
| 混入别人的输入、配置改变、相同 ID 的数据矛盾 | 停止归并，转人工核验。 |
| 仅有 HTTP 成功/入队、增量预览、空闲或无法关联的输出 | 不展示为可验收结果。 |

## 主服务的接入契约

入口为 `adapter/dumate.mjs` 的 `makeDuMateAdapter`。调用处必须是经过身份验证的服务端。

| 注入项 | 职责 |
|---|---|
| `enabled`、`binding` | 默认关闭；每实例固定 principal、project、bindingId、region=CN、credentialRef、agentId、agentVersion、environmentId、budgetPoints。地区标记是路由策略，数据驻留条件由实际部署另验。 |
| `authorize(scope)` | 根据当前认证身份和**已批准记录**返回相同绑定字段、provider、taskId、fence、inputDigest、action 与 expiresAt。输入摘要为原文 UTF‑8 的 SHA‑256，投递、读回分别授权。不要在生产中照抄测试里“直接回显 scope”的做法。 |
| `getToken(binding)` | 只按当前席位从服务端密钥服务取凭据。凭据不会进看板、日志回执或投递正文。 |
| `claimWrite(key)` | **持久事务**；对主体、项目、任务、代次及写阶段只准首次插入者返回 true；同步校验活跃租约和席位。跨区域和提供方派工也要由同一主账本限制，不能用进程内 Set 充当正式持久层。 |
| `recordReceipt(row)`、`loadReceipt(scope)` | 按同一绑定持久化会话及回显事件标识。以空→session_opened→provider_enqueued 单向推进，禁止换掉已绑定的会话或回执；行中无凭据或正文。账本无法保存会话时，不发送文字。 |
| `fetcher(url, init)` | 显式注入的可信传输，必须保留 `AbortSignal` 与 `redirect:'error'` 的语义；不对 POST 添加重试或主动跟随跳转。 |
| `dispatch({taskId,fence,text})` | 凭相同任务的当前代次进行一次派工。成功时返回本实例专用 handle、sessionId、inputEventId、持久化状态。 |
| `observe(handle)`、`reconcile(handle)` | 前者读取已订阅的流或显式续传；后者仅扫描历史。输出文本始终当作不可信的候选工件，UI 必须按纯文本渲染。 |
| `restore({taskId,fence,text})` | 重启后从可信账本恢复，只能读历史。摘要/席位/项目/授权不符就不恢复；不接受用户提交的 sessionId 来读取任意会话。 |

**边界：** 当前不带生产 OAuth/密钥托管、分布式账本实现、收费授权、Rivule 前端接线、部署或实机验收。文档与测试都不把此 PA 列为“账户已连通”。首次实机测试需单独授权实际账户、受限 Agent、一个具体可发送的公开数据包和费用范围；先检验传输与回执，再启用该席位。

**复验（Node 24）：** 在本包目录运行 `node --test --test-reporter=tap tests/dumate.test.mjs`。
