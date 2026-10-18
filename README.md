<p align="center"><img src="docs/showcase/assets/rivule-banner.svg" alt="Rivule — Many streams. One clear view." width="100%"></p>

# Rivule

**让进展汇到一起。**

Rivule 是一个面向个人 AI 助手的统一通知入口。支持的助手通过 MCP 或 HTTP 明确上报任务变化，Rivule 将消息汇到一个 Discord bot，让你在同一处看见进展、阻塞，以及需要你决定的事。

```text
已接入的助手 → MCP / HTTP → Rivule → 一个 Discord bot
```

## 为什么是 Rivule

当几个助手同时推进不同项目，重要的更新容易散在不同对话里。Rivule 把消息带回来，并保留来源与「助手 → 项目 → 任务 → 分支」的上下文。

- 看见变化：任务完成、进展更新、遇到阻塞
- 知道下一步：明确哪些事情需要你决定
- 保留来处：理解更新属于哪个助手、项目和任务
- 统一入口：通过同一个 Discord bot 接收通知

## 接入进展

| 来源 / 渠道 | 当前状态 |
| --- | --- |
| Zot、Gemini Spark、Muse | 明确调用后的通知链路已验证 |
| Manus | 连接器可达；实际通知送达仍待验证 |
| Discord | 主要通知入口 |
| QQ | 固定回复与一次性主动测试均已实收验证；持续主动通知正在开发 |

通知由助手调用 MCP / HTTP 上报。QQ 已通过固定回复和一次性主动发送测试，持续推送正在开发。

## 接下来

接下来将 QQ 与 Discord 的功能对齐，让所有已验证 PA 的进展主动汇入同一入口，并逐步加入任务详情、进度图和交互。

## 从一条真实通知开始

1. 按部署文档配置 Rivule 服务与 Discord bot
2. 在支持的助手中配置 MCP 或 HTTP 接入
3. 明确调用一次通知，并在 Discord 确认实际送达
4. 再将同一入口用于更多项目和任务

具体配置、环境变量和部署命令以仓库的实施文档为准。本段是产品介绍，不替代可执行的部署指南。

## 项目展示

`docs/showcase/index.html` 是不依赖构建工具的静态产品展示，包含可筛选的虚构任务示例。它不会连接你的服务，也不会展示实时数据。另附[中性标识的合成通知预览](docs/screenshots/neutral-multi-source-demo.png)。



## 公开源码版本与重建

此包是 **生产衍生、可重建的公开中性标识版本**，采用 AGPL-3.0。JavaScript 基线来自已回读验证的 Worker 模块；显示层使用随包 TypeScript 输入，后续修改由有校验的补丁重建。它不是完整原始 TypeScript 工程的恢复。

公开版本使用原创蓝色 M/S 字母徽章和 Muse / Gemini Spark 产品名称，不包含它们的官方 PNG/SVG 图标。公开 owner 模块与对应的私人可读性版本字节不同；只将两个图像常量归一化后，整个模块的其余字节完全一致。PUBLIC_ASSET_TRANSFORM.json 记录转换、原始来源哈希和公开输出哈希，不保存已移除的图像。QQ gateway 保持原模块字节不变。

## 当前范围

- Discord 来源选择、任务总览、详情与状态通知，使用新版可读性显示层
- 依据当前连接与绑定证据验证来源，不按 PA 品牌固定放行
- 每个来源只读查询自己的精确任务状态与序号，不替它批准任务
- QQ 绑定、固定回复、失败原因分类与由所有者点击的一次性主动测试

新增来源会逐个验证通知链路；持续推送将在绑定、权限与频控检查完成后开放。

## 构建与验证

Node.js 24 或更高，依赖由 package-lock.json 固定。

```sh
cd local-candidate/cloudflare
npm ci
cd ../..
node scripts/install-font.mjs
node scripts/rebuild.mjs
node scripts/verify-package.mjs
```

重建顺序：原始已审计基线 → 中性显示层 → 只读任务快照 → 最新可读性显示层；QQ 独立重建错误分类和一次性主动测试。

字体安装器从官方 Sans2.004 固定版本下载，校验输入 SHA，按记录的表重排与50字节元数据变换重建，再校验输出 SHA；生成字体与已验证资源逐字节一致。网络不可用或校验失败会清楚报错并停止，不安装半成品。字体和 WASM 二进制均不随仓库分发；WASM 从固定 npm 依赖读取、校验 SHA 后复制。依赖缺失或校验失败会停止构建。构建不会临时下载替代品、自制 WASM 或连接生产服务。各阶段哈希和最终产物由 PROVENANCE.json 与 PUBLIC_ASSET_TRANSFORM.json 校验。

最终 owner 在 production-readable-ui-candidate-20261018/modules；最终 QQ gateway 在 production-qq-active-probe-candidate-20261018/modules。目录中的 production 是来源历史，不表示公开变体已部署。local-candidate/cloudflare/src 仅作显示编译输入与历史架构参考，不能整包直接部署替代生产衍生模块。

本次验证：39 项中间层快照测试；最终 owner 的 39 项快照与 20 项可读性测试；20 项 QQ 错误分类测试；129 项主动测试回归；实际 workerd 持久化 seed/restart。测试均使用合成数据，没有真实 provider 请求。独立解包后的全新 npm ci --ignore-scripts、完整重建与文件校验已通过；空账号端到端安装仍待验收。

## 图标与项目素材

默认 M/S/Z 字母徽章是原创项目素材。只使用产品名称识别来源，不暗示产品方背书。若部署者拥有合法授权，可在自己的副本中进行构建期本地图标替换，见 docs/DISPLAY_ASSETS.md；不会开放事件传入 SVG、远程图标抓取或运行时品牌上传。

## 发布前尚需完成

1. 上线时提供与实际部署版本对应的 AGPL 源码入口
2. 对新安装的空账号完成端到端部署与接入验收
3. 确认目标 GitHub 仓库、可见性和发布授权
4. 按 third-party-licenses/COMPILED_SOURCE_AVAILABILITY.md 保留第三方声明并复核其列明的来源完整性限制

参阅 docs/OPERATIONS.md、docs/INTEGRATIONS.md、docs/THIRD_PARTY.md 和 docs/SECURITY.md。配置模板只有虚构占位值，不能直接上线。
