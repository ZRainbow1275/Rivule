# 本 VPS 的独立出口与恢复

适用于 `160.236.111.203` 的 Ubuntu / Docker 主机。原 `secure-remote-firewall.service` 管理 `inet secure_remote_v1`，forward 默认 drop。此扩展只把来自 `rv-search` bridge 的流量送入独立链：拒绝非公网 IPv4，允许到指定 DNS 的 UDP/TCP 53，以及经 `ens3` 的公网 TCP 80/443，其余丢弃。没有新入站规则。

先通过已授权的 `secure-remote-admin` 和本机解锁的 SSH agent 连接。保留既有 NetBird 配置，源码部署目录为 `/opt/rivule-cn-search`，真实 `.env` 保持 0600。安装以下两个新文件到 root 所有的位置：

- `deploy/vps-egress.py` → `/usr/local/libexec/rivule-cn-search-egress`，0644。
- `deploy/rivule-cn-search.service` → `/etc/systemd/system/rivule-cn-search.service`，0644。

新建仅供本项目使用的外部 Docker 网络；已有同名网络时先检查 owner label、bridge 名称与子网，不覆盖：

```sh
sudo docker network create --driver bridge \
  --label com.rivule.scope=cn-search \
  --opt com.docker.network.bridge.name=rv-search \
  --opt com.docker.network.bridge.enable_icc=false \
  rivule-search-egress
sudo python3 /usr/local/libexec/rivule-cn-search-egress apply --check
sudo python3 /usr/local/libexec/rivule-cn-search-egress apply
```

在私网拒绝、公网出口与规则持久化检查后构建。构建与运行均使用同一个专用网络；不要改成 host 网络或放开 docker0。

```sh
cd /opt/rivule-cn-search
# shortcut: this Docker 29 host has no buildx; use its legacy builder for the
# dedicated network, and select a network-scoped BuildKit builder before upgrading away from legacy support.
sudo env DOCKER_BUILDKIT=0 docker compose -p rivule-cn-search \
  -f compose.yaml -f compose.vps.yaml config --quiet
sudo env DOCKER_BUILDKIT=0 docker compose -p rivule-cn-search \
  -f compose.yaml -f compose.vps.yaml build
sudo systemd-analyze verify /etc/systemd/system/rivule-cn-search.service
sudo systemctl daemon-reload
sudo systemctl enable --now rivule-cn-search.service
```

`rivule-cn-search.service` 在原防火墙与 Docker 后启动，先装载限域规则，再启动容器。VPS overlay 使用 `restart: on-failure`，避免 dockerd 重启时在防火墙 gate 之前自行恢复 worker；本项目 unit 随 Docker / 原防火墙的正常 stop/restart 协同停止和恢复，进程失败仍由 Docker 重启。原防火墙正常 reload 会传播限域规则重载。脚本以一次 nftables 事务重建自己的链，不 flush 原表或改变其默认策略。

该 unit 是 oneshot 管理入口，健康状态显示 `active (exited)`；执行进程在 Docker 中，应同时查看容器：

```sh
sudo systemctl status --no-pager rivule-cn-search.service
cd /opt/rivule-cn-search
sudo docker compose -p rivule-cn-search -f compose.yaml -f compose.vps.yaml ps
sudo docker compose -p rivule-cn-search -f compose.yaml -f compose.vps.yaml logs --tail 30 regional-worker
```

2026-10-21 实测 start / reload / stop / start 和自有执行进程崩溃恢复均通过，spool 附件保留；最终 Moli 镜像为 `c3d29466ee19`。完整站点与有效限制见 [验收记录](../reports/VALIDATION.md)。未为验收重启 Docker、原防火墙或 NetBird。

## 故障时先停自己的服务

```sh
sudo systemctl disable --now rivule-cn-search.service
sudo python3 /usr/local/libexec/rivule-cn-search-egress remove
```

这会停止 worker 并撤除自己的链 / jump；第二条命令也覆盖首次构建失败、unit 尚未启动时装载的规则，重复执行是空操作。保留 spool、镜像、网络和 `.env`。修复后 `enable --now` 恢复。不要删除原防火墙表、NetBird 网络或 worker spool 来清理故障。若直接维护原防火墙而未使用其 systemd reload，随后执行 `systemctl reload rivule-cn-search.service` 重装本项目规则。

规则规划检查：`python -m unittest discover -s tests -p test_vps_egress.py -v`。部署验收还须使用真实内核 `--check`、专用网络的 DNS/HTTPS、非公网和其他端口拒绝、最终容器限制、任务撤租 / 重启及原 NetBird 服务状态。

## 显式切换 Chromium，重启后保留选择

兼容模式单独使用 `chromium-1.61.0` image tag，不覆盖默认 Moli 镜像；本项目 service 的 Start/Stop 都读取同一 `COMPOSE_FILE`。先停止服务，构建并安装 drop-in 后再启动，始终只有一个执行者：

```sh
sudo systemctl stop rivule-cn-search.service
sudo python3 /usr/local/libexec/rivule-cn-search-egress apply
cd /opt/rivule-cn-search
sudo env DOCKER_BUILDKIT=0 docker compose -p rivule-cn-search \
  -f compose.yaml -f compose.vps.yaml -f compose.chromium.yaml config --quiet
sudo env DOCKER_BUILDKIT=0 docker compose -p rivule-cn-search \
  -f compose.yaml -f compose.vps.yaml -f compose.chromium.yaml build
sudo install -d -m 755 /etc/systemd/system/rivule-cn-search.service.d
sudo install -m 644 deploy/chromium.conf /etc/systemd/system/rivule-cn-search.service.d/chromium.conf
sudo systemctl daemon-reload
sudo systemctl start rivule-cn-search.service
```

切回时先 stop，再仅移除自己安装的 `chromium.conf`，执行 daemon-reload 和 start；默认 Moli 镜像须已构建。不要只用临时三文件 `compose up` 改变受 systemd 管理的服务，否则重启会回到 systemd 中持久选择的模式。Chromium sandbox / seccomp 的要求继续适用，不以 `--no-sandbox` 恢复失败。

2026-10-21，独立兼容镜像 `0688af9ee042` 已完成 Linux 构建与 sandbox / cgroup 验收，固定 Playwright 1.61.0 / Chromium 149.0.7827.55。`chromium-seccomp.json` 是固定官方 profile 的派生修改：只在原 namespace allow 组增加 `chroot`，供 Chromium 在自身 user namespace 内执行文件系统隔离，仍默认拒绝，保留 `cap_drop: ALL` / NNP / 非 root。来源与变更见 [THIRD_PARTY.md](../THIRD_PARTY.md)。

TASS / VK 的显式检查没有取得可用正文，正式服务已恢复默认 Moli，未安装 Chromium drop-in；该兼容镜像保留为明确选择的可用选项。真实页面、诊断 PNG 的目视结果及限制见 [验收记录](../reports/VALIDATION.md#linux-chromiumsandbox-已通过两个目标站点仍受限)。
