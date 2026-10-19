# 让 AI 帮你接入 Rivule

将下面的任务说明交给协助配置的助手，并补充自己处于哪一步。不要提供密码、令牌或密钥。

```text
请协助我接入 Rivule，目标是一个来源的一条通知实际送达。
先阅读 README.md、docs/GETTING_STARTED.zh.md、docs/OPERATIONS.md
和 docs/INTEGRATIONS.md。确认我是新安装、更新服务，还是只连接一个助手。

检查 Node.js 24+，在源码根目录执行：
npm ci --ignore-scripts
node scripts/install-font.mjs
node scripts/build.mjs

使用 config 中的模板，部署 dist/owner 和 dist/gateway 的完整模块与资源。
owner 源码在 src/owner，gateway 源码在 src/gateway。
请列出缺少的非敏感配置及由谁完成；账户登录、授权与密钥使用平台的安全入口。
在部署、创建持久访问或发送通知前，按已有授权及平台确认要求执行。

已有服务时，完成当前来源认证、精确任务读取、一次已获准的更新、
同来源回执查询及接收方实收确认。MCP 参数以当前 tools/list 为准。
不要把认证成功或事件已接受当作已送达；遇到未知结果先查原回执与聊天。
最后分别说明已完成、尚未完成、需要我决定的事项及下一步。
```

可补充操作系统、Node 版本、服务地址、来源 ID 和获准的项目 ID。第一次只接通一个来源；QQ 另外完成绑定、所有者点击验证和本轮通知开启。

## 文件导航

- 安装与构建：`scripts/install-font.mjs`、`scripts/build.mjs`
- owner：`src/owner/worker.js`、`src/owner/qq-integration.mjs`
- gateway：`src/gateway/worker.mjs`
- 模板：`config/wrangler.owner.example.json`、`config/wrangler.qq.example.json`
- 接口与回执：[助手接入](INTEGRATIONS.md)
- 错误处理：[排查指南](TROUBLESHOOTING.zh.md)

如需浏览静态展示，可从根目录运行 `python3 -m http.server 8080 --bind 127.0.0.1`，在自己的浏览器打开 `http://127.0.0.1:8080/docs/showcase/`；查看结束按 Ctrl+C 关闭。展示页不连接服务，也不证明真实通知已送达。
