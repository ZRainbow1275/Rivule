# 协作控制面已发布；实际 Google 与双产品联调待配置

## 有效检查

- 认证 17 项：本地真实 RSA JWT 验签、nonce/issuer/audience/email_verified/过期校验、受邀名单、会话轮换、CSRF、原子一次性消费，以及实际安装 OAuth Provider 的 DCR/PKCE/consent/token/refresh。扩展 Origin 的正负边界已覆盖。
- 核心/UI 15 项：工作空间/来源隔离、依赖与环、参数/revision、撤租、未知发送、租约到期、人工核对、不泄漏租约、CSV 往返、工作空间切换竞态及合法默认操作。
- 连接器 7 项：固定 origin/会话 URL、模式/发送 guard、领取中停用/配置竞态、未知 HTTP 确认保留同一回执、恢复既有观察器不重发、按真实观察控件形成的 Pro/Task guard，以及完整序列化回执的字节边界。
- 源码包 1 项：对应源码含扩展 HTML 与许可，写到独立目录后可重新运行源码生成器，不依赖上级 Rivule LICENSE；同时检查 preview URLs 关闭、日志 / trace 抽样 0.1 与查询脱敏。
- `npm run check`、JS `node --check`、Wrangler dry-run 通过。
- `npm run test:runtime`：真实本地 workerd 的 SQLite DO、KV、R2 与 MCP HTTP/SSE，**38 个检查组通过**。包含两位标注身份的隔离、scope 拒绝、只读免调度、幂等、附件、迟到回执、跨运行旧回执重放、历史快照、原租约撤销、通用 MCP 的派单/领取/续租/回报、人工核对，以及指定网页来源不能走通用 MCP 执行。

单元合计 **40 项**。本轮定向运行连接器 7 项、源码包 1 项，合计 **8 / 8 通过**；认证 17 项与核心/UI 15 项沿用未变源码和依赖的有效检查。runtime 是 1 个集成测试中的 38 个检查组，身份为明确标注的本地夹具。

## 本轮修复：完整回执的字节边界

发布审查复现：140,000 个双引号通过了原来的 220,000 UTF-8 正文字节检查，JSON 转义后的完整回执却超过 API 的 262,144 字节上限，收到 413 后停留在不可变待确认重传中。

现于 `terminalAttempted` 之前检查包含 `job_id`、`lease_token` 的完整 JSON UTF-8 大小。超限交付现有的小型 `unknown / observation_interrupted`，由用户在原页面导出完整结果；原回执重试语义保持。新增回归执行真实 content / background 脚本：普通中文及 120,000 个双引号完整成功；140,000 个双引号只交付小型 unknown，确认后清除 pendingReport / spool。旧候选该项失败，修复后 8 项定向检查、strict tsc 与 JS 语法检查通过。

修复后的 minified dry-run 为 **1138.30 KiB / gzip 290.70 KiB**。此后显式固定原部署的 preview / 抽样配置并更新兼容验收状态，对应源码 28 文件的独立重建检查再次通过。所有者完成官方设备授权后，最终实际部署为 **1761.90 KiB / gzip 362.92 KiB**、启动 **76 ms**；12:20 UTC 的线上 `/source` 已读回修复、配置回归与最终 README。

## 运行与视觉

实际 ShardBrowser 已在本地同一 Worker/UI 中完成创建空间、来源、两个依赖节点、查看详情、暂停、继续与取消；后继节点保持阻塞，图和数据库返回的状态一致。移动宽度下路线图优先显示；截图 `.runtime/evidence/ui-local-fixture-final.png` 已打开检查。测试身份只存在于独立的 `tests/runtime-worker.ts` 入口与本地运行态。

实际登录态页面只做控件校准：

- ChatGPT 普通 Chat 页显示 Pro，当前输入为 `main form [data-composer-markdown][contenteditable=true]`；发送按钮在输入后出现，当前页面标签为 `Wyślij`。
- Gemini 当前 Task 按钮的祖先为选中的 `gem-segmented-button`；编辑器为 rich-textarea，输入后才出现 `Send message`。
- 检查文字均已清空，Gemini 恢复检查前的 Chat 模式；没有发送产品消息、加载扩展或点击审批。

原始浏览器输出包含扩展注入的字体 CSP 错误；本轮未放宽 CSP 或改动用户扩展。工作台自身 JS 和关键交互正常。

## 发布与实际接收

当前版本 **`0ed030c3-0d1b-4547-9482-d858262f72cb`**，2026-10-21 **12:19:16 UTC** 发布，官方 `wrangler deployments status` 读回 **100%** 生效；migration 保持 `bridge-v1`。本次发布完整回执边界修复、对应源码及兼容验收文档，保留原 DO / KV / 私有 R2 与 `WORKER_TOKEN` 加密绑定。最终实际上传与启动指标见上节。

初次通过已授权 Cloudflare API 连接发布独立的 `rivule-bridge`，创建专用 KV/R2 与 DO namespace；本次通过官方 Wrangler / OS keyring 授权更新同一 Worker，未改动其他 Workers。R2 的 r2.dev 开关此前实读为 false，附件只通过成员/来源鉴权读取。最终配置显式保持 `preview_urls:false`、日志 / trace 抽样 `0.1` 与 query-string redaction，新增的源码包断言先在旧配置失败、修正后通过。

2026-10-21 12:20 UTC，VPS 真实 HTTPS 通路读取最新健康（200）：

```json
{"ok":true,"service":"rivule-bridge","version":"0.1.0","googleConfigured":false,"workerConfigured":true}
```

此前实际 OAuth authorization-server / protected-resource 元数据可读，包含固定 `/mcp` resource 与 S256，匿名工作空间读取 401；这些后端路径本轮未改。本地夹具路径在线上不开放。最终 `/source` 返回 200、28 个对应源码文件，确认完整 JSON 回执 guard 及其回归测试、最终 Chromium 状态 README、`preview_urls:false`、两类抽样 `0.1` 与查询脱敏；此前编辑器 guard、执行快照、扩展 HTML 与独立许可定位保留。

VPS 的正确 SSH 账号为 `secure-remote-admin`，解锁后实际登录和免密 sudo 均成功。通过所有者手动登录的 Cloudflare 工作台创建加密 worker 密钥；匹配 `.env` 经 SSH 写入 VPS，权限 0600。真实领取请求在默认 Python UA 下得到边缘 403 `error code: 1010`，应用标识 `Rivule-regional-worker/0.1` 返回 200、`{"job":null}`；共享客户端已修复并通过 7 项定向回归，更新后的实际 `python3 worker.py ... poll --once` 退出 0。最终 Linux 容器的同一轮询入口也实际退出 0。

2026-10-21，限域公网出口已授权实施，最终 Moli 镜像 `c3d29466ee19` 的 **39 / 39 Linux 检查**通过；`rivule-cn-search.service` enabled / active、容器 running。可选 Chromium 镜像 `0688af9ee042` 的 Linux sandbox 与原生 2/2 检查也通过，但 TASS 返回 403、VK 仍无正文，正式服务已恢复 Moli。实际 cgroup、非 root、只读根、seccomp、启停 / reload、自有进程崩溃恢复和 spool 保留有原生证据。微信、知乎、Interfax、Telegram 及百度搜索取得真实内容，细节见 [区域 worker 验收](../../cn-search/reports/VALIDATION.md)。

本机 Node 直连 workers.dev 曾出现 `ERR_TLS_CERT_ALTNAME_INVALID`，curl 也曾发生 schannel 握手错误；最终健康与对应源码通过 VPS 的正常 TLS 通路核验。Google 配置向导保留控制台路线，Wrangler 官方 API 更新已成功。

## 恢复与剩余门

当前健康版本为 `0ed030c3-0d1b-4547-9482-d858262f72cb`；此前兼容同一数据库且带 worker 密钥绑定的基线 `f3dc669f-c949-44e6-9cbc-eab6806d892f` 可用于代码回退，其源码基线为 `f7191a53-7c5f-4a6f-8a3f-279aa65c20c2`。本地源码和公开对应源码均已保留。后续故障可用当前代码重新构建、部署，保留绑定、DO 数据与 Secrets，再检查健康、已有任务和回执。

本轮早期版本 `3c5b80fc-153e-4075-92db-d14501924f86` / `6f58298e-6c47-4562-9726-84737ce1dd3f` 的 jobs INSERT 不兼容最终追加的 snapshot 列，不能作为当前数据库的可写回退。未来通过 Cloudflare Versions 回滚前先确认 SQL 写入兼容性。需立即止住外部访问时，可在控制台暂时关闭该 Worker 的 workers.dev 路由并停止自己部署的 worker，随后恢复当前基线；不要删除 namespace 或 named volume 来回滚。

实际 Google OAuth 客户端尚未创建；真实 Google 登录、真实两人隔离和 Pro/Gemini Task 的完整消息回路等待所有者完成向导后联调。VPS 已常驻运行；真实用户从工作台派发区域任务、结果写入及私有附件读取，同样在 Google 配置完成后验收。生产入口保持真实认证要求。
