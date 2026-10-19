# 部署与维护

先完成[本地构建](../README.md#build)。需要自己的 Cloudflare 账户、Discord 应用与 bot；新安装须自行验证完整的认证和实收流程。

<a id="owner-setup"></a>
## 1. 建立私人配置

```sh
cp config/wrangler.owner.example.json config/wrangler.owner.private.json
cp config/wrangler.qq.example.json config/wrangler.qq.private.json
```

填写自己的 Worker 名称、实际 HTTPS 服务域名、KV 命名空间、Discord 应用公钥、所有者和目标 DM。`PUBLIC_ORIGIN` 不带尾部 `/` 或子路径。配置 `SOURCES_JSON` 和 `ALLOWED_PROJECT_IDS_JSON`，先允许一个来源与一个项目；按[接入方式](INTEGRATIONS.md#connect)准备 OAuth、Muse API 或 HMAC。

私人配置不得提交；凭据通过平台的 secret 设置配置，不写入模板或聊天。公开模板的发送与可选功能开关默认关闭，空允许名单和身份占位值不可直接使用。

## 2. 检查模块与绑定

- owner 入口：`dist/owner/worker.js`
- QQ gateway 入口：`dist/gateway/worker.mjs`
- 保留模板的 `no_bundle`、`base_dir` 和资源规则，部署整个对应模块目录
- gateway 使用 `QQGatewayObject`；owner 使用 `OwnerTerminal`
- owner 的 `QQ_GATEWAY` 指向实际 gateway Worker，`OAUTH_KV` 指向自己的 KV
- 新安装使用模板中的迁移；已有安装保留原命名空间、身份与迁移历史

先只使用 Discord 也要准备当前模块依赖的绑定。不要把单个入口文件脱离相邻模块与资源上传。

使用 lockfile 安装的 Wrangler 做本地配置检查：

```sh
./node_modules/.bin/wrangler deploy --dry-run --config config/wrangler.qq.private.json
./node_modules/.bin/wrangler deploy --dry-run --config config/wrangler.owner.private.json
```

检查目标、模块、资源、绑定和迁移。dry-run 不验证远端账户权限、OAuth、Discord 握手或消息实收。

<a id="release-check"></a>
## 3. 发布与确认

通过 Wrangler 官方认证流程登录。确认账户、Worker 名称、目标及授权后，新安装依次部署：

```sh
./node_modules/.bin/wrangler deploy --config config/wrangler.qq.private.json
./node_modules/.bin/wrangler deploy --config config/wrangler.owner.private.json
```

这些命令会改变远端服务。让 AI 操作时应遵守平台的确认要求。已有安装应先保存当前配置与可回滚版本，核对迁移、绑定及数据兼容性，再按该安装的更新流程发布。回滚代码不会回滚 Durable Object 中的数据。

发布后检查服务配置与绑定，将 Discord 应用交互地址设置为 `PUBLIC_ORIGIN/discord/interactions`，确认签名握手和 bot / 所有者 / DM 绑定。由所有者启用需要的发送渠道，然后完成[一条通知的实收确认](GETTING_STARTED.zh.md#first-message)。健康探针有响应不等于通知已送达。

网络部署应提供与运行版本对应的 AGPL 源码入口，并保留第三方许可与源码来源说明。

<a id="qq-session"></a>
## QQ 会话内通知

先完成连接、接收账户绑定和固定回复检查，再由所有者点击一次性主动验证。部署方配置所需开关、来源和项目允许名单及 bridge secret，所有者在设置中确认当前账户、权限并开启本轮持续通知。

- 公开模板默认关闭发送；已有安装的实际状态以设置页为准
- 每日连接运行预算为 120 分钟（`QQ_DAILY_ACTIVE_BUDGET_MS=7200000`）
- 当前主动通知上限为每日 100 次，最小发送间隔为 3 秒；配额按 UTC 日期重置
- 持续发送需要当前来源、绑定、权限和会话证明，并受去重与容量规则约束
- 暂停结束本轮授权；绑定或权限变化后需重新确认
- 未知发送结果先核对接收聊天和原回执，不自动重发
- 容量不足时，通知可能跳过，项目记录仍保留

这是一项会话内能力，尚不提供全天候 QQ 通知，也未覆盖 Discord 的全部功能。在 QQ 主面板点击“刷新”可原地更新状态，使用“返回总览”入口回到任务总览。设置提示与处理步骤见[QQ 状态指南](QQ_STATE_MATRIX.md)。
