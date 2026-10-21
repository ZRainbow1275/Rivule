# Rivule v2：搜索与跨应用协作

## 当前任务

搜索资料归档、公开网页 worker、多用户应用协作桥归入 **`v2` 分支**，作为第二代版本的开发与发布成果；`main` 保持现有通知版本，不包含这些新增模块。通知模块沿用 **`41a407b` / v0.4.2** 基线，初始实现基线为 `1d0f060`；原开发分支为 `work/search-and-collaboration`。

## 状态

| 交付 | 状态 | 当前证据 / 下一步 |
|---|---|---|
| 搜索资料 | 已归档 | `search-tool/` 的 14 条清单、运行指南、凭据辅助工具及机器证据；文档/格式检查通过 |
| 区域网页 worker | Linux 最终镜像与实测完成 | 固定 Moli v1.1.18；最终 39 项 Linux 检查通过，百度 3 条自然结果，微信 / 知乎 / Interfax / Telegram 正文和 Rust PNG 成功 |
| 可选 Chromium | Linux sandbox 与隔离已验收 | Playwright 1.61.0 / Chromium 149.0.7827.55；原生检查 2/2 无 skip；TASS 403、VK 空壳，正式服务保留 Moli |
| 多用户协作控制面 | 已实现并发布 | 独立 Cloudflare Worker、工作空间/来源隔离、8 个 MCP 工具、Google OIDC、任务 DAG、CSV、限域连接器；实际账户验收见下 |
| VPS 部署 | 已常驻运行 | `/opt/rivule-cn-search`，最终镜像 `c3d29466ee19`；systemd enabled / active、容器 running，限域出口、cgroup、启停和自有进程崩溃恢复已验收 |
| Google 实际登录 | 配置待完成 | 所有者确认没有 OAuth Web 客户端；生成精确回调与安全配置向导 |
| 真实 Pro / Gemini / 第二用户验收 | 等待配置后联调 | 已检查实际 Pro / Task 页面控件，未发送产品消息；需 Google 客户端、安全录入、两名实际用户与用户绑定的任务会话 |

两个 Capture 资料目录保留原状；现有搜索服务和上游 dirty worktrees 不迁移、不改写。凭证、浏览器登录态、原始任务数据不进入仓库。

## 可用入口与发布证据

- 工作台：<https://rivule-bridge.hybridrevis.workers.dev/>
- 健康：<https://rivule-bridge.hybridrevis.workers.dev/health>
- MCP：`https://rivule-bridge.hybridrevis.workers.dev/mcp`
- 当前部署对应源码：<https://rivule-bridge.hybridrevis.workers.dev/source>，28 个源码/构建文件的 JSON 文件映射。
- 当前版本：`0ed030c3-0d1b-4547-9482-d858262f72cb`，2026-10-21 12:19:16 UTC，官方 Wrangler 读回 100% 生效。完整回执大小修复与 28 文件对应源码已发布；DO migration 仍为 `bridge-v1`，现有存储与加密绑定保留。
- 12:20 UTC，VPS 实际 HTTPS 健康与 `/source` 均返回 200；健康为 `ok:true`、`googleConfigured:false`、`workerConfigured:true`。源码读回确认完整 JSON 边界、回归测试、最终 Chromium 状态，以及关闭 preview URLs、日志 / trace 抽样 0.1 和查询脱敏。此前实际鉴权领取返回 200、`{"job":null}`，匿名工作空间为 401；R2 托管公共域名 `enabled:false`。
- 所有者完成官方设备授权后，本机 Wrangler 登录已恢复，凭据由 OS keyring 管理。本机 Node / curl 直连 workers.dev 曾遇到 TLS 错误，最终公开入口经 VPS 正常 TLS 验证；未降低 TLS 校验。Google 配置向导保留控制台录入路线。

## 已执行检查

| 检查 | 证据 |
|---|---|
| 搜索资料格式 | 4 JSON、1 TOML、14 CSV 条目、24 本地链接检查通过；提供方调用与注册器测试分别标注 |
| 区域 worker | 最终 Linux 39/39（worker 29 + 出口规划 10），两个真实 Moli 网络检查无 skip，原 `ResourceWarning` 已修复；早前 Windows 26/26、解析 9/9、安全 7/7 保留 |
| 显式 Linux Chromium | 独立镜像 `0688af9ee042`；出口 / 生命周期 / profile 11/11，原生 Chromium 2/2；真实 sandbox、1 GiB / 1 CPU / 256 pids / 256 MiB shm，OOM / pids-limit 事件为 0 |
| VPS 实际限制 / 恢复 | UID/GID 10001、EROFS、cap=0、NNP=1、seccomp=2；有效 1 GiB / 1 CPU / 128 pids；start/reload/stop/start、强制终止自有 worker 后自动恢复，原 PNG 保留 |
| Bridge 单元检查 | 认证 17、核心/UI 15、连接器 7、源码包重建 1，合计 40 项通过；本轮连接器 / 源码包 8/8，其余未变切片复用有效证据 |
| Bridge 本地 runtime | 真实 workerd + SQLite DO + KV + R2 + MCP wire，38 个检查组通过；身份为明确标注的本地夹具 |
| 类型 / 构建 | strict tsc、连接器 JS 语法、Wrangler dry-run 通过；最终实际部署 1761.90 KiB / gzip 362.92 KiB，启动 76 ms；此前 minified dry-run 指标另列于 Bridge 报告 |
| 实际工作台 UI | ShardBrowser 中创建空间/来源/节点、设依赖、暂停/继续/取消，回执与图状态吻合；实际截图已目视检查 |
| 实际产品 DOM | 已核对普通 ChatGPT Chat 的 Pro 控件、Gemini 选中 Task、编辑器与输入后出现的发送按钮；临时检查文字已清空，未发消息 |
| 原项目 | v0.4.2 的 `node scripts/check.mjs`、固定资源完整性检查和 `npm run build` 通过；GitHub main 合并按本轮授权执行 |

## 后续工作与责任

1. **Google OAuth 配置。** 按 `app-bridge/docs/GOOGLE_SETUP.zh-CN.md` 创建 Web 客户端，回调固定 `/auth/google/callback`；在 Cloudflare Secrets 或隐藏输入脚本中录入，不经聊天传密钥。
2. **指定产品与两名真实用户。** 配置完成后，由各用户在独立浏览器 profile 中绑定自己的来源与任务会话，实测 Pro → Gemini Task 分派/回收、暂停、断连恢复和跨用户拒绝；同时派发真实区域任务，核对结果与私有附件。
3. **受限站点需要可访问的公开入口。** Linux Chromium 镜像与 sandbox 已验收，实际 TASS 返回 403，VK 仍无正文；Yandex 保留此前验证码状态。默认 Moli 继续常驻，后续按明确来源做定向兼容验证。

完整证据：`search-tool/verification.json`、`cn-search/reports/VALIDATION.md`、`app-bridge/reports/VALIDATION.md`。现有 Discord/QQ 服务没有已提供的运行入口，本轮协作桥独立发布，通知接入仍沿用原来源认证与实收检查。

## 2026-10-21：SSH 账号纠正与本机解锁

- 早前使用错误账号 `root`，收到 `Permission denied (publickey)`；用户现已明确正确账号为 `secure-remote-admin`。此前要求向 root 追加公钥的建议撤回。
- 改用 `secure-remote-admin@160.236.111.203:22` 后，Git OpenSSH 及 Windows OpenSSH 的详细日志均实际显示 `Server accepts key`；主机 ED25519 指纹匹配已有记录。指定公钥指纹为 `SHA256:9wWFkKOuO4fgMWjSIcOvTr0jmYv5DtX5FoDGVR91iSU`。
- 当时本机没有运行中的 `ssh-agent.exe`；Windows OpenSSH 返回 `ssh_get_authentication_socket: No such file or directory`。原生 `ssh-keygen -y -P ''` 检查返回 `incorrect passphrase supplied to decrypt private key`，确认私钥需要原有加密口令。该阶段阻塞为本机解锁，现已解除。
- 已创建忽略目录中的临时交互助手，PowerShell 语法检查通过；独立 agent 通过 `ssh-add -h secure-remote-admin@160.236.111.203` 绑定目的账号和现有主机密钥，解锁后实际核对远端用户名。用户已完成解锁，主线程实际登录与 `sudo -n -l` 成功；临时助手与运行状态不进入发布件。
- 远端 SSH 配置和原 NetBird 解锁入口均未修改。VPS 为 Ubuntu 24.04.5 x64、Docker 29.1.3、Compose 2.40.3、cgroup v2；约 7 GiB 可用内存、73 GiB 可用磁盘。原 NetBird 两个容器保持运行。

## 2026-10-21：VPS 部署与线上 worker 联调

- 18 个明确列出的源码 / 部署 / 测试文件及根许可证已通过 SSH 传入新建的 `/opt/rivule-cn-search`；未传浏览器 profile、Capture 配置或本地运行目录。
- 原 Cloudflare MCP 连接本次返回 HTTP 404 `Session not found`。所有者在既有 ShardBrowser profile 手动登录后，通过官方运行时设置表单创建 `WORKER_TOKEN` 加密密钥并部署；匹配的 `.env` 已经加密 SSH 传入 VPS，权限 0600。本机临时传输文件已删除，工具临时内存中的新 token 已清除。
- 实际 GET `/health` 为 `workerConfigured:true`；实际 POST `/api/worker/claim` 在默认 `Python-urllib/3.12` 下返回 Cloudflare 403 `error code: 1010`，使用真实应用标识 `Rivule-regional-worker/0.1` 后为 HTTP 200、`{"job":null}`。共享 HTTP 请求头修复已交付，7 项定向回归通过；更新源码后 VPS 实际 `python3 worker.py ... poll --once` 退出 0。
- 首次 Docker 镜像构建在 apt 阶段失败：`Temporary failure resolving 'snapshot.debian.org'`。同一 VPS 宿主机的 IPv4 / IPv6 HTTPS 均可访问该快照；实际基础容器不能解析 DNS。已定位至原 NetBird 专用防火墙 forward 默认 drop，未修改该策略或用 host 网络绕开。

## 2026-10-21：专用出口生效

- 用户确认继续已提出的限域方案后，创建独立 `rivule-search-egress` 网络：bridge `rv-search`、172.20.0.0/16、ICC=false。仅从该 bridge 跳入 `rivule_search_out`，指定 DNS 的 UDP/TCP 53、公网 TCP 80/443 可出站，非公网与其他协议 / 端口丢弃；没有增加入站或放开 docker0。
- nft 规划与生命周期回归 **10/10**；真实内核 `--check`、apply、再次 check、remove/reapply 均成功。结构化比较确认原表对象在移除后完全恢复，在生效时除本项目链与 jump 外均未变化。
- 独立基础容器实际 DNS UDP、DNS TCP、HTTPS 通过；10.255.255.254、192.0.2.1 和公网 TCP853 连接被阻断。对应规则计数为 nonpublic=4、dns-udp=1、dns-tcp=1、web=1、other=2。默认 Docker bridge 仍无法连接公网443；原 NetBird 两容器持续运行。
- 新 `rivule-cn-search.service` 随原防火墙 / Docker 正常启停、保留 spool。VPS overlay 使用 `restart:on-failure`，避免 Docker 绕过启动 gate 自动恢复；Moli/显式 Chromium 通过持久 COMPOSE_FILE 选择，Chromium 使用独立 tag。独立只读复核发现的两项生命周期问题已修正，结论无剩余阻断项。
- 新 helper / unit 已安装为 root 所有，最新 unit 原生校验通过；现已 enable/start，最终运行验收见下一节。既有 NetBird unit、Docker unit 和原防火墙文件未改动。

## 2026-10-21：最终镜像与常驻服务验收

- 专网首次完整构建成功；后续实测发现百度 `/baidu.php` 广告入口混入自然结果，以及 `HTTPError` 响应未关闭。补充旧版失败回归并修复共享解析 / 客户端后，增量构建最终镜像 `c3d29466ee19`，最终 Linux 全套 **39/39**，无 skip / warning。构建与检查日志在忽略目录 `.runtime/`。
- 最终容器实际 `poll --once` 退出 0；同一百度查询重验得到 3 条自然结果。`rivule-cn-search.service` enabled / active，容器 `rivule-cn-search-regional-worker-1` running。真实 start / reload / stop / start 均通过；停止时自有链 / jump 撤除，启动时恢复为各一个。
- 有效 cgroup 是 `memory.max=1073741824`、`cpu.max=100000 100000`、`pids.max=128`；非 root、只读根、cap=0、NNP=1、seccomp=2，spool 0700。空闲时仅强制终止自有执行进程，restart count 0→1，恢复 running，原 PNG 保留；恢复后日志无错误。
- 同一出口 `160.236.111.203` 的真实 Moli 样本：微信 6,178、知乎 20,577、Interfax 7,959、Telegram 5,727 字符。Rust 正文 2,781 字符，PNG 1920×1080 / 201,521 字节，Linux 生成图片已目视检查。Yandex `blocked/captcha`、TASS `blocked/empty_content`、VK `failed/timeout` 均据实记录。
- 原 NetBird 两容器仍 running，启动时间均为 2026-10-17；未重启整机、Docker 或 NetBird。维护与回滚入口为 `cn-search/deploy/README.md`。真实 Google 用户派单 / 产品消息回路在 OAuth 配置后继续。

## 2026-10-21：同步上游 v0.4.2 并继续余项

- 上游从 `1d0f060` 前进到 `6b6125d`，包含 v0.4.0 的 QQ 可配置提醒 / 暂停预算、v0.4.1 的发送前诊断与真实队列状态、v0.4.2 的缺失空表冷恢复。已读取相关实现差异，使用原生 fast-forward / autostash 同步；本地 README 入口和忽略规则已恢复，三个新模块保留。
- 根包版本为 0.4.2，公开 MCP server 元数据按上游保留 0.4.0；`node scripts/check.mjs` 通过。协作桥仍是独立的 0.1.0 部署，未将这次源代码同步记作原 QQ / Discord 服务升级。
- 更新后的协作桥 README 已纠正 worker Secret 的旧状态；对应源码包重新生成 28 个文件，独立重建检查 1/1 通过。MetaMCP Serena 的 `initial_instructions` 本轮超过三分钟无响应后中止；本仓库沿用此前无语义 / 图索引的记录，以当前 Git 差异、源码和可运行检查核对更新。
- 区域 worker 已完成显式 Linux Chromium 构建、sandbox 与真实 TASS / VK 兼容验证：原生 2/2、出口 / profile 11/11；TASS 403，VK 仍无正文。默认 Moli 已恢复，12:10 UTC 正式服务 enabled / active、唯一容器 running，恢复以来日志 0 字节。详见区域模块报告。
- 所有者本轮确认 Google OAuth 客户端仍未创建。现有 ShardBrowser profile 返回“being operated by another MCP process”；网页配置等待该任务释放浏览器后，由所有者完成登录 / 客户端配置。没有另开相同 profile 或绕过 lease。
- 首次根包构建发现本机缺少依赖 / 字体资源；按现有入口完成 `npm ci --ignore-scripts`、固定官方字体安装后，v0.4.2 `npm run build` 成功，owner / gateway 产物写入忽略目录 `dist/`。
- 所有者当时要求合并到 GitHub **main**，审查通过后以 `bac9bbe` 推送；随后修正为按第二代版本拆分，见下节。**暂不重启现有主机**的决定保持。
- main 发布审查另复现连接器完整回执的 JSON 转义膨胀：原始正文虽小于限额，序列化后可能 413 并卡在待确认重传。已在标记终态前按完整 packet 检查，超限交付小型 unknown，保留原页面完整输出；新增真实双脚本回归先失败后通过。本轮连接器 / 源码包 8/8、strict tsc、JS 语法和 dry-run 通过。官方设备授权恢复后已部署修复，最终 `/source` 读回全部标记；配置包检查还覆盖 preview URLs 关闭、日志 / trace 抽样 0.1 与查询脱敏。
- 发布前再次 fetch 发现 `41a407b` 仅更新根 README / RELEASES 的原通知服务部署状态，已完整核对两处差异并再次快进同步。保留上游“v0.4.2 已部署、双渠道实收仍待验收”的记录；本轮没有操作该通知服务，其既有构建证据仍适用。

## 2026-10-21：拆分为第二代版本

- 按所有者修正后的版本边界，从 `bac9bbe` 建立独立 `v2` 分支，保留本轮完整实现、部署文件、许可证与验收记录；README 明确区分第二代协作能力与现有通知模块。
- `main` 通过回退 `bac9bbe` 移除本轮新增模块与文档入口，保留正常提交历史；后续第二代工作在 `v2` 继续。
- 本次只调整 Git 分支与版本说明，不停止既有独立 Cloudflare / VPS 服务，不删除运行数据。Google OAuth、真实双用户与 Pro / Gemini Tasks 消息回路的剩余验收门保持。
