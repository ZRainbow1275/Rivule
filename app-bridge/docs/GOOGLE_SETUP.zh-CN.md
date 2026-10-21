# 配置受邀 Google 登录

首次使用时，先创建自己的 Google Web OAuth 客户端，再通过隐藏输入提示写入 Cloudflare Secrets。当前代码不含 Google 凭据；`/auth/status` 在凭据缺失时返回 `googleConfigured: false`。

## 1. 创建 Web OAuth 客户端

1. 登录 [Google Cloud Console](https://console.cloud.google.com/)，选择你自己的项目。
2. 在 **Google Auth Platform → Branding** 填写应用名称、支持邮箱和开发者联系邮箱。
3. 在 **Audience** 选择适用的受众。个人 Google 账户通常使用 **External**；若 Console 要求测试用户名单，将首批使用者加入 **Test users**。Rivule 的受邀名单在后续步骤单独配置。
4. 在 **Data Access** 仅使用身份登录所需的 `openid` 和 `email`。Rivule 不请求 Gmail、Drive 或其他业务 API 权限。
5. 在 **Clients → Create client** 选择 **Web application**，登记以下 **Authorized redirect URI**，逐字一致：

   ```text
   https://rivule-bridge.hybridrevis.workers.dev/auth/google/callback
   ```

   本实现由服务端兑换授权码，无需添加 JavaScript origins。不要把 `/mcp` 或第三方 MCP 客户端的回调登记为 Google 回调。
6. 创建后保存 **Client ID** 和 **Client secret** 到你自己的密码管理器。接下来直接输入安全提示；不要粘贴到聊天、命令参数、源文件或截图中。

Google 要求 Web 应用登记精确的回调地址；客户端创建步骤见 [Google 官方 Web OAuth 指引](https://developers.google.com/identity/protocols/oauth2/web-server#creatingcred)。

## 2. 隐藏录入并上传 Secrets

在 Windows PowerShell 5.1 或 PowerShell 7 中进入 `app-bridge`：

```powershell
npm ci
npx wrangler whoami
.\scripts\configure-auth.ps1
```

先核对 `whoami` 显示的是目标 Worker 所在的 Cloudflare 账户，再运行脚本。脚本会更新 `rivule-bridge` 的三个 Secrets，并立即使其生效；首次运行前，Worker、KV 和 Durable Object 应已部署。

若 `whoami` 提示本机登录过期，先运行 `npx wrangler login`，由你在浏览器中核对账户并完成授权，再运行配置脚本；无需把 Cloudflare Token 交给聊天。

脚本按顺序隐藏输入：

- Google Client ID。
- Google Client Secret。
- 首批受邀邮箱，英文逗号分隔，务必包含你的 Google 邮箱。

三个值通过子进程标准输入交给本项目安装的 `wrangler secret bulk`，不创建明文凭据文件，也不把值放进进程参数或环境变量。输入名单会替换整个 bootstrap 受邀名单；通过工作台单独添加的邀请记录仍保留。

Secrets 名称为 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`INVITED_EMAILS`。最后一个在 Worker 中是 JSON 字符串数组；未配置时默认为 `[]`，新登录一律需要已有邀请。Cloudflare Secrets 的管理方式见[官方文档](https://developers.cloudflare.com/workers/configuration/secrets/)。

### 本机 CLI 不可用时，在 Cloudflare 控制台录入

打开目标账户的 **Workers & Pages → rivule-bridge → Settings → Variables and Secrets**，分别新增以上三个 **Secret**，不要使用普通明文变量。`INVITED_EMAILS` 填写 JSON 数组，例如 `["you@example.com","member@example.com"]`。保存并部署后，在浏览器打开 `/auth/status` 核对配置，再进行下一节真实登录。

本轮本机 Node 直连 `workers.dev` 曾遇到证书域名不匹配，既有 ShardBrowser 与 Fetch 通路可以正常访问。若脚本在 Secrets 上传后仅状态探测失败，先在浏览器核对状态；若 `wrangler secret bulk` 本身失败，则使用控制台录入，或先恢复本机已信任的网络/CLI 登录配置。

## 3. 完成一次真实登录

1. 打开 [Rivule 工作台](https://rivule-bridge.hybridrevis.workers.dev/)，选择 Google 登录。
2. 使用同时满足 Google 测试用户要求和 Rivule 受邀要求的邮箱。
3. 登录后确认工作台显示自己的身份，并创建或选择自己的工作区、来源。
4. 退出后重新登录一次，确认旧会话已退出、新会话可用。

可直接查看安全状态：

```powershell
Invoke-RestMethod https://rivule-bridge.hybridrevis.workers.dev/auth/status
```

预期 `googleConfigured: true`、`setupRequired: false`。这个接口只检查配置存在和认证状态存储接入；真实登录以第 1–3 步为准。

若 Google 返回 `redirect_uri_mismatch`，检查 Client 类型是 Web application、回调路径和域名完全一致。若 Rivule 提示邮箱未受邀，检查 bootstrap 名单或由有权限的工作台管理员添加邀请。测试阶段的 Google `access_denied` 应先检查 Audience 的 Test users。

## 4. 连接 MCP 客户端

在支持远程 MCP OAuth 的客户端中添加：

```text
https://rivule-bridge.hybridrevis.workers.dev/mcp
```

MCP 客户端通过标准 OAuth 发现接口取得授权入口。服务端提供：

| 路径 | 用途 |
| --- | --- |
| `/.well-known/oauth-authorization-server` | 授权服务器元数据 |
| `/.well-known/oauth-protected-resource/mcp` | MCP 资源元数据 |
| `/oauth/authorize` | 中文人工授权页 |
| `/oauth/register` | OAuth 动态客户端登记 |
| `/oauth/token` | 授权码兑换、refresh 和撤销 |

授权页显示客户端名称、回调主机和请求的 scopes。名称由动态登记客户端自行提供；请核对你正在使用的应用。授权需要人工提交，并填写从工作台复制的工作区和来源编号。服务端会验证成员身份与来源所有权，随后将两者固定在 MCP grant 内。未登录时先人工选择 Google 登录，再返回最终授权页确认绑定；登录不会自动批准客户端。

- `bridge:read`：读取任务和结果，基础必选权限。
- `bridge:write`：提交任务及连接器结果。
- `bridge:control`：取消任务等控制操作。

MCP access token 有效期 15 分钟；refresh token 采用官方 OAuth Provider 的轮换机制，有效期 7 天。Google 登录只证明身份，不把 Google access token 或 refresh token 转交给 MCP 客户端。OAuth 端点与绑定行为依据 [workers-oauth-provider 1.2.3](https://github.com/cloudflare/workers-oauth-provider/tree/v1.2.3)；PKCE、动态登记、token 和 refresh 协议由该库处理。

工作台、Cookie 会话和 OAuth/MCP 入口的请求若携带 `Origin`，只接受 `PUBLIC_ORIGIN`。远程 MCP 客户端应由其服务端或本地后台发起 Bearer 请求，浏览器顶层 OAuth 重定向照常使用。浏览器扩展的专用连接器例外见下节。

## 5. 绑定自己的浏览器连接器

在已登录工作台中为自己的工作区、来源创建连接器凭据，复制到你本人运行的连接器。凭据只显示在签发响应中，服务端仅保存其摘要；固定 7 天过期，每周从工作台重新绑定。

凭据仅有 `bridge:read` 和 `bridge:write`，且固定 `workspaceId`、`sourceId`。连接器不能邀请用户、签发其他凭据或更换绑定。只运行用户明确选择的任务会话；过期或撤销后停止协调，不自动重新发送任务。泄露时从工作台撤销对应 `tokenId`，再重新绑定。

Manifest V3 扩展必须从 background/service worker 发起请求，在 `host_permissions` 中声明 Bridge 的 HTTPS 域名，并使用 `credentials: 'omit'`。服务端只对 `POST /api/connector/claim`、`POST /api/connector/heartbeat`、`POST /api/connector/result` 接受标准 `chrome-extension://<扩展 ID>` 来源，且每次均须验证真正有效的 Connector Bearer、固定的工作区/来源绑定，并完全不携带 `Cookie`。扩展 ID 可以随 unpacked 安装变化，无需配置 `CONNECTOR_ORIGINS`；授权依据是用户签发的绑定凭据。该例外不适用于普通网页来源、Cookie 登录、MCP Bearer 或其他路径。

内容脚本直接 fetch 仍使用所在网页的来源，应将协调请求交给扩展后台；后台跨域请求需要 host permissions，见 [Chrome 官方网络请求说明](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)。

会话和连接器凭据存储在 Workers KV，退出或撤销的跨区域传播可能需要 **60 秒或更久**。需要马上停止某个任务时，请使用工作台的暂停或取消：工作区 Durable Object 会即时撤销租约并拒绝后续 heartbeat。KV 的传播说明见 [Cloudflare 官方文档](https://developers.cloudflare.com/kv/concepts/how-kv-works/)。

## 开发接入约定

`src/auth.ts` 导出 `Principal`、`AuthEnv`、`AuthBinding`、`AuthOptions`，以及：

```ts
createAuthenticatedWorker(appHandler, { authorizeBinding, consumeOnce })
getPrincipal(request, env, ctx?)
validateCsrf(request, env, ctx?)
allowInvitedEmail(email, env)
issueConnector(principal, env, { workspaceId, sourceId })
revokeConnector(principal, env, tokenId)
```

- `AuthEnv` 要求 `AUTH_KV`、`PUBLIC_ORIGIN`。wrapper 内部为官方 Provider 映射 `OAUTH_KV`，不要求额外 namespace。`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`INVITED_EMAILS` 均通过 Secrets 注入。
- `authorizeBinding(principal, binding, env, ctx)` 必须以当前身份在应用存储中核对工作区成员和来源所有权，返回 boolean。未提供时拒绝 MCP 授权。
- `consumeOnce(key, expiresAt, env, ctx)` 必须通过 Durable Object 原子登记并返回“此前未使用”。`expiresAt` 为 Unix **毫秒**；key 为 `google:<SHA256(state)>` 或 `consent:<SHA256(handle)>`。保存到到期再清理，过期输入拒绝。缺失时拒绝 Google 登录和 OAuth consent。KV 单独的 get/delete 无法提供原子消费；[Cloudflare 一致性文档](https://developers.cloudflare.com/kv/concepts/how-kv-works/)说明了这个限制。
- 应用处理器收到官方 Provider 调用时，必须把原始 `request` 和 `ctx` 传给 `getPrincipal`。wrapper 在真正的 `apiHandler` 内标记已验证上下文，并使用 `ctx.props` 中的固定绑定和 `ctx.auth.scope` 中的实际 token scopes；请求头、JSON、外部构造的 `ctx.props` 均不构成身份凭据。
- 每个受保护任务操作仍须由应用核对当前成员关系、来源所有权和 scope；不要把登录成功当作任务访问授权。
- `GET /auth/session` 为当前 Cookie 会话返回 `{ principal, csrfToken }`。session 写请求使用同源 `Origin` 和 `X-CSRF-Token`，并调用 `validateCsrf`；授权 HTML 表单使用隐藏 CSRF 字段和 Provider 的浏览器绑定 cookie。Bearer 凭据不借用 Cookie 权限。
- Cookie 为 `__Host-rivule_session`，带 `HttpOnly; Secure; SameSite=Lax; Path=/`，有效期 8 小时；每次 Google 登录新建会话并删除此前会话。用户编号稳定映射为 `google_<SHA256(sub)>`，只保留邮箱、编号和授权所需字段，不保存 Google ID token、access token、refresh token 或个人资料。
- `allowInvitedEmail` 必须由调用方先完成管理员权限和 CSRF 校验。`issueConnector` 必须由调用方先核对 binding；仅 session + `bridge:control` 可签发或撤销，签发响应为 `{ token, tokenId, expires_at }`。
- 应用路由调用上述 helper 时，可捕获导出的 `AuthError`，用其 `status` 和 `message` 返回拒绝原因；其余异常按应用的内部错误处理，避免输出凭据。

单元测试使用本地签名的 RSA JWT 和内存存储夹具，运行真实签名验证和已安装的 OAuth Provider。Google 账户登录、测试用户名单与 Google Console 配置由上面的真实登录步骤验收。
