# 中文 / 俄文公共网页 worker

这个独立 worker 从 Rivule bridge 领取任务，串行检索百度 / Yandex，或读取指定公共网页。默认使用固定的 **Moli 1.1.18** 独立 Rust 内核；正文与搜索结果直接来自网页，不生成 LLM 综合答案。适用于中文公共站点、微信公开文章、知乎公开页，以及俄文新闻、公开 VK / Telegram 页面。登录、验证码、地区限制和空壳页面返回明确状态。

## 先在本机读取一页

需要 Python 3.12 或更新版本；Moli 路径只在本目录的忽略目录中安装，不改系统浏览器。

```sh
cd cn-search
python install_moli.py
python worker.py fetch 'https://www.rust-lang.org/'
python worker.py search '开源 浏览器' --engine baidu --limit 3
python worker.py search 'новости науки' --engine yandex --limit 3 --language ru
python -m unittest discover -s tests -v
```

退出码：`0` 成功，`1` 抓取失败，`2` 配置 / 传输失败，`3` 网页访问被阻断。stdout 是 UTF-8 JSON；诊断写 stderr，不输出 cookie、响应头或鉴权内容。

`fetch URL --screenshot` 额外产生 viewport PNG。Moli 只在截图时开启 `--layout --image --font`。正文与图片来自两次独立导航，`warnings` 记录这个差别；精确、可交互或高保真截图继续交给 Capture。

超过 160 KiB 的正文保留在 `content.txt`，响应中的 `warnings` 写明原始 / 返回字符数。CLI 把附件留在私有 `.spool/local.*` 目录并返回路径；轮询模式上传后返回附件标识。单附件最多 8 MiB，完整结果包最多 256 KiB；超出硬边界返回失败，未静默丢弃全文。

## 作为 Ubuntu x64 服务运行

默认镜像仅含 Python 标准库和固定官方 Moli 二进制，不安装 Rust 工具链或 Chromium。基础镜像按 digest 固定，Debian 软件源按快照固定；Moli 发布件按版本与上游资产摘要校验。构建时保留其许可文件。

本项目的 `160.236.111.203` 使用[专用网络与 systemd 部署入口](deploy/README.md)，包含限域出口、启动顺序、停启恢复与持久化内核选择。维护这台 VPS 时使用该入口。以下命令适用于由所有者自行准备网络的通用 Docker 主机。

由部署所有者在 VPS 上准备独立目录、Docker 与 Compose。不要复制已有 Capture 的配置、profile、凭据或 `.venv`。

```sh
cp .env.example .env
chmod 600 .env
# 在 .env 中填写已部署的 HTTPS BRIDGE_ORIGIN 和所有者签发的 WORKER_TOKEN。
docker compose config --quiet
docker compose build
docker compose up -d
docker compose logs --tail 30 regional-worker
```

`.env` 不包含默认凭据。不要把 `docker compose config` 的展开输出发到日志或报告，它可能包含环境中的 token。

容器为 UID / GID `10001`，只读根文件系统、移除全部 capabilities、`no-new-privileges`，无宿主机目录、Docker socket 或公开端口。私有 named volume 保留未确认结果；每页临时状态在 128 MiB tmpfs 内，结束后删除。容器限制 1 GiB 内存、1 CPU、128 个进程，浏览器操作有 25 秒就绪 / 45 秒外层截止。Windows 原生检查使用 Job Object 为整个浏览器进程树设置 768 MiB 内存与随 owner 关闭而终止；Linux 生产内存上界由 Compose cgroup 强制执行。

`docker compose ps` 只用于查看进程。实际验收需 bridge 提交一个 `fetch_public_page` / `regional_search` 任务并核对结果、租约与私有附件读取。没有周期性公共站点探测，也没有 CDP 服务。

### 明确选择 Chromium 兼容模式

只有 Moli 的站点兼容问题需要另一个内核时，操作者才选择这个模式；程序不会在验证码、认证或抓取失败后自动换浏览器。

本机复用已安装的固定依赖和浏览器；缺依赖时单独安装可选依赖，不修改 Capture 环境：

```sh
python -m pip install -r requirements-chromium.txt
# 可设置 CHROMIUM_BIN 为已有 Chromium 可执行文件，或由 Playwright 安装对应浏览器。
python worker.py --browser chromium fetch 'https://public-site.example/article'
```

需要 Playwright 自带浏览器时运行 `python -m playwright install chromium`。容器兼容镜像会安装对应浏览器，体积明显增加；先停默认实例，再构建 / 启动同一服务：

```sh
docker compose stop regional-worker
docker compose -f compose.yaml -f compose.chromium.yaml build
docker compose -f compose.yaml -f compose.chromium.yaml up -d
```

兼容镜像使用独立 tag，保留默认 Moli 镜像。切回时停止兼容服务，确认默认镜像已构建，再运行 `docker compose up -d`；默认 Compose 明确固定 `FETCH_ENGINE=moli`。本项目 VPS 的 systemd 服务按[持久切换步骤](deploy/README.md#显式切换-chromium重启后保留选择)操作。

兼容模式使用迁入的 Capture 网络 guard：每次 SOCKS CONNECT 重新解析、检查全部地址，并直连批准的数字 IP，覆盖重定向、弹窗和子资源；路由层另限 GET / HEAD、禁用 service worker、WebSocket 和 WebRTC。代理仅绑定随机 loopback 端口。Chromium sandbox 必须开启，失败时不尝试 `--no-sandbox`。

`chromium-seccomp.json` 以固定 Playwright 1.61.0 的官方 profile 为基底，保留其用户命名空间允许组，并在该组中增加 `chroot`：Chromium 在新命名空间内用它移除文件系统访问；上游按 `CAP_SYS_CHROOT` 条件放行的规则与本模块 `cap_drop: [ALL]` 不兼容。此派生 profile 仍默认 `SCMP_ACT_ERRNO`，不增加容器 capability，继续要求非 root、`no-new-privileges` 和浏览器 sandbox。宿主机若拒绝非特权用户命名空间，保留失败状态，由所有者处理宿主策略。结果记录 `chromium/playwright-1.61.0`、实际浏览器版本和兼容模式警告。

兼容容器为 Chromium 多进程模型保留 256 个进程 / 线程上限与独立 256 MiB `/dev/shm`，内存与 CPU 上限仍为 1 GiB / 1 CPU；不共享宿主机 IPC。

在上述 Linux sandbox 环境中，可显式运行原生回归：`RUN_NATIVE_CHROMIUM_CHECKS=1 python -m unittest discover -s tests -p test_chromium_runtime.py -v`。它使用固定 data / loopback 夹具，验证浏览器无法绕过 SOCKS 直连私网，以及子资源、替换导航的实际拒绝；不访问公共示例站点。Linux 镜像与真实站点结果见 [验收记录](reports/VALIDATION.md)。

## 轮询使用固定 HTTP 契约

配置：

- `BRIDGE_ORIGIN`：一个不带路径 / 查询 / 用户信息的公共 HTTPS origin；仅本地测试允许 HTTP loopback。
- `WORKER_TOKEN`：必填 bearer token，只在控制请求中发送。
- `MOLI_BIN`：可选，指向固定的 1.1.18 可执行文件。
- `FETCH_ENGINE`：`moli`（默认）或显式 `chromium`。
- `SPOOL_DIR` / `JOBS_DIR`：私有结果目录 / 每页临时目录。一个 spool 只有一个 worker 可持有执行锁。
- `CHROMIUM_BIN` / `PLAYWRIGHT_BROWSERS_PATH`：只在明确选择兼容模式时使用。

```sh
# 先由当前 shell 安全设置 BRIDGE_ORIGIN 与 WORKER_TOKEN。
python worker.py poll
python worker.py poll --once
```

控制请求都发送 `Authorization: Bearer <WORKER_TOKEN>`，拒绝跳转与继承代理，TLS 校验始终开启。只调用以下端点：

| 请求 | 数据 / 响应 |
| --- | --- |
| `POST /api/worker/claim` | 请求 `{"capabilities":["regional_search","fetch_public_page"]}`；响应 `{"job":null}` 或 `{"job":{job_id,workspace_id,task_id,operation,arguments,lease_token,lease_expires_at}}` |
| `POST /api/worker/heartbeat` | 请求 `{job_id,lease_token}`；2xx 可返回 `{lease_expires_at}`（带时区 ISO8601）；409 / 410 立即撤销本地执行 |
| `PUT /api/worker/artifacts/{job_id}/{safe_filename}` | 原始文件，额外 `X-Worker-Lease: <lease_token>`；响应 `{artifact_id,url?}`；最多 8 MiB |
| `POST /api/worker/result` | `{job_id,lease_token,status,result?,error?}`；任意 2xx 为确认 |

`operation` 与参数：

```json
{"operation":"regional_search","arguments":{"query":"公开问题","engine":"baidu","limit":5,"language":"zh"}}
```

```json
{"operation":"fetch_public_page","arguments":{"url":"https://public-site.example/article","screenshot":false}}
```

搜索 `engine` 仅为 `baidu` / `yandex`，`limit` 为 1..10（缺省 5），`language` 仅为 `zh` / `ru`。默认语言由引擎决定。没有 shell、JS、cookie、任意 header 或浏览器参数入口。

结果：

- `status` 为 `succeeded` / `failed` / `blocked`。
- `result` 可含 `sources`、`url`、`final_url`、`title`、`content`、`engine`、`egress`、`warnings`、`artifacts`。
- `sources` 为 `{title,url,snippet,provider,language}`；保留搜索引擎给出的链接，百度包装链接不冒称已解析的最终来源。
- `artifacts` 为 `{artifact_id,filename,media_type,size_bytes,url?}`，只上传选择的全文 / PNG，不上传缓存、profile、日志或配置。
- `error` 为 `{code,message}`，例如 `captcha`、`authentication_required`、`access_denied`、`rate_limited`、`empty_content`、`browser_error`、`private_network`、`timeout`、`tls_error`、`decode_error`、`search_parse_error`。

## 中断与未知回执不会重做网页任务

领取后先把身份写入私有 spool，再运行网页。执行完成后先持久化结果与附件，再上传并回报。断连、未知确认或进程重启时，优先交付原 `job_id + lease_token`，不会再次领取并执行同一个任务。

- 执行中崩溃、尚无已提交结果：回报 `failed/worker_interrupted`，不重新抓取。
- 已保存结果，结果 POST 确认未知：重发相同结果。服务端须对 `job_id + lease_token` 幂等；同 `job_id + filename` 的附件 PUT 也须幂等并拒绝不同内容覆盖。
- 已确认的附件标识会写回 spool，避免后续重复上传。
- 续租失败时继续遵守原期限；到期或 heartbeat 409 / 410 停止自有浏览器进程。未确认结果保留，阻止领取下一项。
- bridge 可将归属正确的撤销 / 过期租约迟到结果保存为 `applied:false` 审计并返回 2xx，不改变已取消、暂停或 unknown 的任务状态，也不释放依赖。worker 将这个 2xx 视为最终确认并清理本地 spool。
- 结果端仍拒绝身份或租约归属时，由部署所有者对照服务端账本确认该身份的最终状态；在确认前保留该 job 目录，不改身份、不重做任务、不直接删除 named volume。

Linux state 目录为 `0700`，文件为 `0600`；忽略目录不进入 Git。Windows 原生执行主要用于本地检查，正式轮询服务使用上述 Linux 容器，NTFS 私有 ACL 不由 POSIX `chmod` 建立。

## 网络与内容边界

只接受无凭据的公共 HTTP(S) URL 和 80 / 443 端口。先检查初始 URL 全部 DNS 地址，Moli 运行时再用 `--block-private-networks` 检查直连的重定向和子资源。Moli 的该策略不覆盖代理端 DNS，因此本 worker 固定 `--http-no-proxy '*'` 并剥离代理环境变量；如需地区出口，请由部署所有者部署到相应 VPS，而非设置未知代理。

浏览器子进程只取得临时 HOME / TMP 与 OS 必需变量，不继承 worker token、云凭据或 Capture 状态。DOM 最大 50,000 节点 / 128 层，单次输出最大 8 MiB、诊断最大 64 KiB。俄文原始文本响应按其声明的 charset 解码；正常 DOM 使用 Moli / Chromium 已解码的 Unicode。

可用性由页面实际内容决定：HTTP 200、验证码页面、登录墙、浏览器错误和空应用外壳都不会直接算成功。页面内容作为不可信来源数据返回；不会执行其中要求的 shell / JS 或增加控制请求。

## 当前验收证据

见 [reports/VALIDATION.md](reports/VALIDATION.md)。单元夹具、真实本机 Moli / Chromium、镜像构建、VPS 生效分别记录。远程部署和 bridge 服务端授权由主线程 / 所有者执行。
