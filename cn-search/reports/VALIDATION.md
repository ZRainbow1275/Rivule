# 公共网页 worker：Moli 常驻，Linux Chromium 兼容镜像已验收

最终 VPS 环境：Ubuntu 24.04.5 x64、Docker 29.1.3、Compose 2.40.3、cgroup v2；镜像内 Python 3.12、固定官方 Moli 1.1.18。2026-10-21 最终镜像 `c3d29466ee19` 已通过 **39 / 39 Linux 检查**，`rivule-cn-search.service` 为 enabled / active，容器 running。结构化记录见 [VALIDATION.json](VALIDATION.json)。

同日已构建并验收独立 Linux Chromium 镜像 `0688af9ee042`，Playwright **1.61.0** / Chromium **149.0.7827.55**，sandbox 与实际隔离检查通过。TASS / VK 未取得可用正文，正式服务已恢复默认 Moli；真实用户派单仍待所有者创建 Google OAuth 客户端。

早前本机环境为 Windows x64、Python 3.12.3；可选 Playwright 1.61.0 与已有 Chromium 151.0.7922.34。下文单独保留这些历史检查。

## 共享客户端与搜索来源修复

根线程在真实 VPS 复现：相同鉴权和 claim 数据使用 `Python-urllib/3.12` 时，Cloudflare 返回 HTTP 403 / `error code: 1010`；改为 `Rivule-regional-worker/0.1` 后返回 HTTP 200 / `{"job":null}`。

共享 `Bridge.request()` 现固定发送该应用 User-Agent，覆盖 claim、heartbeat、result 和附件 PUT；TLS、禁用继承代理、拒绝重定向的策略保持原样。本地真实 HTTP 服务先确认新增断言在旧实现下失败，再验证修复后 **7 / 7 BridgeTests 通过**，包括四类请求的实际头部、未知确认下相同 packet 重投、已确认附件不重复上传及撤租取消。该次输出附带一次 socket `ResourceWarning`，已在 JSON 记录。

成功命令：`PYTHONPATH=tests python -m unittest test_worker.BridgeTests -v`、`python -m py_compile worker.py tests/test_worker.py`。修复版源码在 VPS 原生入口和最终容器的实际 `poll --once` 均退出 0。

本轮继续修复 `HTTPError` 响应未关闭的问题，保留状态码与原异常链；真实 HTTP 302 / 撤租检查确认响应已关闭。百度实测发现 `/baidu.php` 广告跳转混入自然结果，现按百度域名与精确路径过滤，包括嵌套结果容器；保留正常 `/link?url=`、其他站点同名路径及原文，跳过非法 authority / 端口。新增断言在旧版复现失败，修复后 Bridge + Parser **18 / 18** 通过，最终 Linux 全套无 `ResourceWarning`。最终镜像重验原百度查询，返回 3 条自然结果，没有该广告入口。

## VPS 实际部署进展

2026-10-21，根线程使用 `secure-remote-admin` 与用户在本机解锁的限域 agent 成功登录 `160.236.111.203:22`，免密 sudo 可用。主机为 Ubuntu 24.04.5 x64、Docker 29.1.3、Compose 2.40.3、cgroup v2，原 NetBird 两个容器保持运行。

明确列出的模块源码、部署文件、测试及许可证已传入独立 `/opt/rivule-cn-search`。匹配的真实 worker Secret 已在 Cloudflare 与 VPS 配置，VPS `.env` 权限为 0600；线上健康实际返回 `workerConfigured:true`，真实领取返回 HTTP 200、`{"job":null}`，修复后的完整轮询入口退出 0。

首次 Linux 镜像构建在 apt 阶段报 `Temporary failure resolving 'snapshot.debian.org'`；实际原因是原 `inet secure_remote_v1` forward 默认 drop。用户确认继续限域方案后，新建独立 `rivule-search-egress` / `rv-search`，只允许指定 DNS 的 UDP/TCP 53 和公网 IPv4 TCP 80/443，先拒绝非公网，其余丢弃。原 input / forward 策略、NetBird 规则和 docker0 出口保持。内核 `--check`、apply/remove/reapply 与结构化还原比较通过。

真实专网容器的 UDP DNS、TCP DNS、HTTPS 通过；私网 `10.255.255.254`、保留地址 `192.0.2.1` 和公网 TCP 853 均超时拒绝；默认 Docker bridge 仍无法连接公网 443。实测出口 IPv4 为 `160.236.111.203`。镜像使用该专用网络完成 Debian 快照和固定 Moli 安装；此主机没有 buildx，已记录 legacy builder 的受限使用及后续升级条件。

最终服务由 root 所有的 systemd unit 在 Docker / 原防火墙之后启动。VPS overlay 的 `restart:on-failure` 避免 Docker 在启动 gate 前自动恢复。实际 start、reload、stop、start 均成功：生效时只有一个自有链 / jump，停止后两者撤除，再启动恢复。空闲时仅强制终止自有 worker 进程，Docker restart count 从 0 到 1，容器恢复 running，原 PNG 在手动重启和故障恢复后均保留。原 NetBird 两容器持续运行，启动时间仍为 2026-10-17。

实际容器 UID/GID 10001、只读根写入返回 EROFS、CapEff=0、NoNewPrivs=1、Seccomp=2。有效 cgroup 为 `memory.max=1073741824`、`cpu.max=100000 100000`、`pids.max=128`；spool 0700，仅有私有 named volume、无公开端口 / Docker socket / 宿主目录挂载。恢复后的 worker 日志为空，无控制请求错误。部署、检查与回滚见 [deploy/README.md](../deploy/README.md)。

## Linux Chromium：sandbox 已通过，两个目标站点仍受限

构建沿用 `DOCKER_BUILDKIT=0` 与 `rivule-search-egress`，固定 SDK 安装 revision **1228** 的 headless shell 与完整 Chromium。独立 tag 为 `rivule-cn-search-regional-worker:chromium-1.61.0`，最终镜像完整 ID 为 `sha256:0688af9ee042044dbe1f7a0311aa435acfbc1473d4196514a5bb1e23b7594130`，大小 **589,409,828 字节**；默认 Moli 镜像未覆盖。

真实运行暴露了两处兼容配置问题，均已修复并保留检查：

1. Chromium overlay 重复列出基础 Compose 已有的 `no-new-privileges:true`，实际 Compose 合并后报 `security_opt items at 0 and 1 are equal`。删除 overlay 的重复项后，实际合并结果同时保留 NNP 与指定 seccomp。
2. 固定上游 seccomp 的 `chroot` 规则要求容器拥有 `CAP_SYS_CHROOT`，与 `cap_drop: [ALL]` 不兼容；真实启动在 `sys_chroot("/proc/self/fdinfo/")` 失败并触发 zygote SIGTRAP。获准后只在既有 namespace allow 组增加 `chroot`，不增加 capability 或修改宿主策略。该文件现明确标为官方固定版本的派生修改，见 [第三方来源](../THIRD_PARTY.md)。新增拒绝式策略回归先在旧 profile 失败，修改后通过。

验收使用无 token、无 volume / host mount / 公开端口的有界临时容器，正式 worker 在此期间停止。实际 UID/GID **10001**、`cap_drop: ALL`、`no-new-privileges`、`docker-default` AppArmor、只读根 **EROFS** 均保留；有效限制为 **1 GiB / 1 CPU / 256 pids**，`/dev/shm` **256 MiB**。整个检查的内存峰值为 **453,881,856 字节**，OOM / pids-limit 事件均为 0。

实际 headless shell 的 renderer 没有 `--no-sandbox`，`CapEff=0`、`NoNewPrivs=1`、`Seccomp=2`、`Seccomp_filters=2`，独立 user namespace 映射为 `10001 → 10001`。headless shell 不提供 `chrome://sandbox`；同容器、同版完整 Chromium 的该诊断页显示 **Namespace、PID namespaces、Network namespaces、Seccomp-BPF / TSYNC 均开启**，结论为 `You are adequately sandboxed.`。namespace helper 的临时能力限于自身 user namespace，未向容器增加宿主 capability。

两个 opt-in 原生检查实际启动 sandboxed headless shell：不设置 route 拦截时，SOCKS 仍阻断 loopback；固定 data 夹具中的 Fetch 子资源与替换导航也被阻断，受控服务收到 **0 个请求**。生产模块来自镜像，测试通过 stdin tar 放入 tmpfs，没有 host mount。最终命令为 **2 / 2 通过，无 skip**：

```sh
RUN_NATIVE_CHROMIUM_CHECKS=1 PYTHONPATH=/tmp/regional-tests/tests:/opt/regional-worker \
  python -W error::ResourceWarning -m unittest test_chromium_runtime -v
```

另有 Safety 7、Guard 2、出口 / 生命周期 / profile 11 项在兼容容器通过；最初 native fixture 误将 data URL 当作有 HTTP 主响应的页面，已改为直接观察真实 SOCKS 与服务器请求后重验上述 2 项。

| 目标与明确选择 | 真实结果 | 实际图片目视检查 |
| --- | --- | --- |
| TASS `https://tass.ru/nauka`，默认 headless shell | `blocked/access_denied`，HTTP **403**，约 **4.48 秒**；未取得正文 | 独立诊断 PNG **1280 × 800 / 21,308 字节**，明确显示 `Forbidden` 与站点拒绝报告 |
| VK `https://vk.com/rtnews`，默认 headless shell | `failed/compatibility_engine_failed`，约 **5.00 秒**；诊断原因为 `Target page, context or browser has been closed` | 此失败未生成内容附件 |
| 同一 VK，操作者额外显式指定已验证 sandbox 的完整 Chromium | `blocked/empty_content`，约 **11.08 秒**；未取得正文 | 独立诊断 PNG **1280 × 800 / 11,822 字节**，仅 VK 标志与灰色加载骨架，无公开帖子 |

两张诊断 PNG 均已在本机打开检查，保存于忽略目录 `.runtime/chromium-{tass,vk}-diagnostic-20261021.png`；它们用于解释失败，没有当作成功正文或任务附件上传。TASS / VK 的显式兼容检查未改善可用性，**继续默认 Moli**。未再请求 Yandex，未处理其验证码，也未换 IP、代理或放松 TLS / 网络边界。

2026-10-21 **12:00 UTC** 已移除临时容器，默认 `rivule-cn-search.service` 恢复 enabled / active；仅一个正式容器 running，内核为 Moli，原镜像 `c3d29466ee19`、原 spool 保留，无 pending state。**12:10 UTC** 交付检查仍为相同镜像 / 启动时间，恢复以来 worker 日志 **0 字节**。未安装 Chromium drop-in。原 NetBird 两容器启动时间仍为 2026-10-17。受限字段、实际进程、cgroup 与图片记录在 `.runtime/chromium-{sandbox,final-state,delivery-state,samples}-20261021*.json` 及相应日志；没有重启主机、Docker 或 NetBird。

## 执行检查

| 检查 | 结果 |
| --- | --- |
| Moli 部署基线，本轮兼容专项前：`python -W error::ResourceWarning -m unittest discover -s tests -v` | **39 / 39 通过**：worker 29、出口 / 生命周期规划 10；两个实际 Moli 内核检查均执行，无 skip / warning；只向 tmpfs 测试目录传入测试与部署夹具，生产代码从最终镜像读取 |
| 早前 Windows：`python -m unittest discover -s tests -v` | **26 / 26 通过**，包括两个实际 Moli 内核网络检查，无 skip |
| 早前 Windows 搜索来源 URL 凭据检查：`PYTHONPATH=tests python -m unittest test_worker.ParserTests -v` | **9 / 9 通过**；新增来源回归已纳入上方最终 39 项 |
| 早前 Windows 浏览器环境 / 缓存定位检查：`PYTHONPATH=tests python -m unittest test_worker.SafetyTests -v` | **7 / 7 通过** |
| 六个生产 Python 文件 `python -m py_compile …` | 通过 |
| `docker compose config --quiet` | 通过，使用无真实凭据的配置夹具 |
| `docker compose -f compose.yaml -f compose.chromium.yaml config --quiet` | 通过，使用无真实凭据的配置夹具 |
| 发布件安装 | 官方固定 Windows x64 资产摘要校验通过，版本为 1.1.18，原附属许可已保留在忽略目录 |

### 安全与恢复使用什么证据

- 真正启动 Moli，访问受控 loopback 服务：初始导航被拦，服务收到 **0 个请求**。
- 受控 `data:` 页执行了固定测试脚本，等待 Fetch Promise 拒绝后的 DOM 标记；Moli network trace 明确记录 `blocked private network address`，loopback 服务仍为 **0 个请求**。同测试继续验证跳往 loopback 的替换导航被拦。worker 的公共任务入口始终拒绝 `data:`，这些仅是内核测试夹具。
- 真正连接 loopback SOCKS 服务：私网 CONNECT 被拒；DNS 重绑定 / 数字 IP 固定连接采用标明的本地单元夹具，不连接模拟的远端地址。
- 使用真实本地 HTTP 控制服务与标明的 fixture job，覆盖 claim、续租、私有附件 PUT、结果 POST。模拟服务端收到结果后断连：重启的 Worker 只重发相同序列化 packet，不初始化浏览器、不重抓、不重复上传已确认附件。
- 活跃任务中断会交付 `worker_interrupted`；410 撤租会传播取消；控制请求 302 不转发 bearer；到期判断不等待阻塞的续租 I/O。
- Windows 自有进程 Job Object、执行锁、实际子进程取消、9 MB 输出拒绝、凭据环境剥离均运行了对应检查。
- 中文、俄文 Unicode、声明为 Windows-1251 的文本、微信 / 知乎正文节点、VK / Telegram 多条公开内容、验证码 / 认证 / 空壳 / 浏览器错误均有可运行解析夹具。

## 真实公共网页

每项是一次功能检查，不是持续监控或对站点可用率的统计。

### 2026-10-21，VPS 真实出口

| 操作 | 实际结果 |
| --- | --- |
| Rust 官网正文 + PNG | 成功，正文 **2,781 字符**，PNG **1920 × 1080、201,521 字节**；已在本机打开 Linux 生成的实际图片，标题、正文和布局正常 |
| 百度“中国 开源 浏览器”，limit 3 | 最终镜像成功，**3 条自然结果**；保留原搜索链接、摘要、provider、language |
| [微信公开文章](https://mp.weixin.qq.com/s/qginKyKMlRqQM2O-zkoVfw) | 成功，`8 款不容错过的开源项目`，**6,178 字符** |
| [知乎公开页](https://www.zhihu.com/question/2019722609273631935/answer/2043652551678112660) | 成功，`浏览器自动化操作工具有哪些？ - 知乎`，**20,577 字符** |
| [Interfax](https://www.interfax.ru/) | Moli 成功，`Интерфакс: новости`，**7,959 字符**俄文 |
| [Telegram 公开频道](https://t.me/s/rian_ru) | 成功，`РИА Новости – Telegram`，**5,727 字符** |
| Yandex `новости науки` | `blocked/captcha` |
| [TASS 科学页](https://tass.ru/nauka) | `blocked/empty_content` |
| [VK 公开页](https://vk.com/rtnews) | `failed/timeout`，25 秒就绪截止未完成 |

这些样本均使用 Moli；没有对验证码自动换引擎。微信、知乎、Interfax 与 Telegram 的返回正文已检查首尾。Rust 图片存于远端私有 volume 的 `local.m6n83e_y/viewport.png`，本机视觉证据在忽略目录 `.runtime/rust-vps-20261021.png`。网页原始输出、测试日志和受限字段的容器检查保存在远端 / 本机忽略目录 `.runtime/`。

### 早前 Windows 真实样本

| 操作 | 实际结果 |
| --- | --- |
| Moli 抓取 `https://www.rust-lang.org/` | 成功，跳转到 `https://rust-lang.org/`，HTTP 200、真实正文 |
| Moli 抓取 `https://rust-lang.org/ --screenshot` | 成功，正文 **2,781 字符**；PNG **1920 × 1080、201,521 字节**，已打开目视检查，标题、正文及版式正常 |
| Moli 百度检索“ 中国 开源 浏览器 ”，limit 3 | 成功，返回 **3 条**有标题、原搜索链接、摘要、provider、language 的结果 |
| Moli Yandex 检索 `новости науки` | `blocked/captcha`，没有尝试换引擎或绕过验证码 |
| 显式 Chromium 抓取 `https://www.interfax.ru/` | 成功，标题 `Интерфакс: новости`，HTTP 200，**8,180 字符**俄文；记录实际浏览器版本、兼容引擎与 non-GET / networkidle 警告 |
| Moli 抓取 `https://tass.ru/nauka` | `blocked/empty_content`，空壳未作为来源正文接受 |
| Moli 抓取 Runoob Python 教程并请求截图 | `failed/timeout`，parser-blocking 就绪截止未完成 |
| 初始原生 Moli 抓取 `https://www.gov.cn/` | 20 秒 parser-blocking script 等待超时，未作为成功计数 |

PNG 保存在 `.spool/local.mh4_qc2b/viewport.png`，原始诊断与本机结果在 `.runtime/`，均由本模块 `.gitignore` 排除。报告只保留必要元数据，不包含控制 token、cookie 或浏览器状态。

## 修正记录

- Windows 的第二个执行者会在读取已锁字节时收到 `PermissionError`，已统一转为执行槽占用错误，防止另开浏览器。
- 本机正常 DNS 查询实测约 5.1–5.3 秒；原 5 秒边界偏紧，已改为 10 秒有界查询，再次实测 Chromium 俄文站点成功。
- 原生 Fetch 网络测试增加 Promise 完成后的明确 DOM 就绪标记，避免在 trace 写入前检查。
- 本地 CLI 附件目录使用 `local.*`，不会被远程 pending job 扫描误认；交付 pending packet 时不要求重新初始化浏览器。
- 私有临时 HOME 与 Playwright 的只读浏览器安装缓存分别定位，不继承现有 profile。当前本机 1.61.0 SDK 要求默认浏览器 revision 1228，已有缓存为 revision 1234；未额外下载浏览器。本机俄文抓取使用明确的 `CHROMIUM_BIN`，默认缺失时返回 `chromium_unavailable`。专用兼容镜像按固定 SDK 安装对应浏览器，Linux 构建与 sandbox 已按上节验收。

## 下一阶段的实际验收门

1. **所有者完成 Google OAuth 配置，主线程再联调真实用户任务。** 最终容器的真实鉴权领取入口、常驻进程与隔离已验收；生产队列尚无真实用户派单。配置完成后提交实际 `fetch_public_page` / `regional_search`，核对结果、租约、私有 R2 附件与第二用户拒绝。未向生产加入身份夹具或测试后门。
2. **受限站点仍需可访问的公开来源。** Linux Chromium 镜像与 sandbox 已完成验收，TASS 为 HTTP 403，VK 仍无正文；Yandex 保留原验证码状态。当前出口与策略下继续默认 Moli。后续若必须覆盖这些来源，由操作者取得站点允许的公开入口，再做定向验证。
3. **用户决定暂不重启现有主机。** 本轮没有重启整机、Docker 或 NetBird；现有证据为原生 unit 依赖、enabled 状态、LiveRestore=false，以及本项目的启停 / reload 与自有进程崩溃恢复。

`/result` 2xx 是最终确认，包括 bridge 对正确历史归属保存 `applied:false` 审计的迟到回执；worker 可清理 spool。其他拒绝保留原身份，不重做网页任务。
