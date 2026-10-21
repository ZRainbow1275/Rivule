# 搜索工具清单与运行指南

这里记录现有 Windows 搜索栈的入口、调用方法和核验证据。实际检索继续使用已配置的 MCP 和本地服务；本目录不运行搜索网关，也不搬迁凭据、账号池或服务。

**快照日期：2026-10-21，Asia/Shanghai。** 运行结果来自主线程在 2026-10-20 至 2026-10-21 的实测；本目录另行核对了本地源码、非敏感配置字段和官方文档。逐项来源见 [证据记录](evidence/2026-10-21.md)。

## 按任务选择入口

| 任务 | 首选入口 | 本轮结果 |
| --- | --- | --- |
| 综合检索，随后核对原文 | Grok Search `web_search` → `get_sources` / `web_fetch` | 实际搜索成功，`fallback_used=false`；有一条综合答案错误，见下文 |
| 独立第二来源 | Exa `exa_search` / MetaMCP `web_search_exa`，或 You.com `you_search` | 三条搜索入口均取得实际结果 |
| 已知 URL 提取正文 | Grok Search `web_fetch`；需要另一路页面提取时用 Crawl4AI `md` | Tavily、Firecrawl 的 doctor 样例提取通过；Crawl4AI 返回非空 Markdown |
| 发现网站内部 URL | Grok Search `web_map`，由 Tavily Map 执行 | DeepSeek 文档站实际返回 3 个 URL |
| DeepSeek 官方搜索与抓取 | 官方 Search / Fetch JSON API | 已核对官方接口；当前会话未注册工具、未发现 `DEEPSEEK` 环境项，鉴权未实测 |

调用参数和故障判断见 [Provider 使用指南](docs/PROVIDERS.md)。注册器、默认上传行为和本机测试命令见 [注册与账号辅助工具指南](docs/REGISTRARS.md)。

## 当前接线

```text
MCP 客户端
├─ grok_search → grok-search-rs.exe（stdio）
│  ├─ Grok / OpenAI-compatible → grok2api → http://127.0.0.1:8100/v1
│  ├─ Tavily                  → MySearch Proxy → http://127.0.0.1:9874/api
│  ├─ Firecrawl               → MySearch Proxy → http://127.0.0.1:9874/firecrawl/v2
│  └─ Exa                     → MySearch Proxy → http://127.0.0.1:9874/exa
├─ MetaMCP Exa（另一条已实测的 Exa MCP 入口）
├─ you_search → Node stdio bridge → https://api.you.com/mcp
└─ Crawl4AI → http://127.0.0.1:18235
```

`MySearch Proxy` 已有控制台和 key/token 池；本目录只记录其现状。注册器是上游账号或 key 的辅助工具，不是每次搜索的前置步骤。

## 把运行健康与答案质量分开看

Grok 当前主别名为 `grok-4.20-0309-non-reasoning`。主线程实际搜索取得了来源且未走 fallback，但其中一次回答断言“消费者 Gemini 没有 MCP / 仅 Enterprise 支持”。同次检索返回的 [Google 官方帮助页](https://support.google.com/gemini/answer/17209137?co=GENIE.Platform%3DDesktop&hl=en) 明确介绍 Gemini Apps 自定义 MCP：当前要求美国、18 岁以上、个人 Google 账号、英文以及 Keep Activity 开启；工作或学校账号当前不可用。本目录于 2026-10-21 重新读取了该官方页面。

这条记录归入 **答案综合错误**。使用 Grok 做调查时，应打开关键原文，再形成结论；连接成功、来源非空和摘要正确是不同的检查项。

其他验收边界：

- Firecrawl 的样例抓取已通过，独立 `/firecrawl/v2/search` 尚未实测。
- MetaMCP Exa 首次请求曾超时 30 秒，后一次约 7 秒返回真实结果；两次记录均保留。
- 注册器的本机启动单元测试通过 5 项，配置占位符测试通过 2 项；没有创建账号、提交注册表单或上传新 key。
- Tavily 上游 README 中“邮件注册入口关闭”的说法是历史记录，本轮没有重新核实官网注册政策。

## 文件入口

| 文件 | 用途 |
| --- | --- |
| [inventory.csv](inventory.csv) | Provider、运行组件和注册辅助工具的可导入清单 |
| [verification.json](verification.json) | 分能力记录结果、证据来源、失败和未测试项 |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | 日常调用、配置位置和故障分流 |
| [docs/REGISTRARS.md](docs/REGISTRARS.md) | 注册器的运行方式、默认值与敏感输出位置 |
| [examples/mcp-servers.example.json](examples/mcp-servers.example.json) | Grok 与 You.com 的脱敏 MCP 配置形状 |
| [examples/grok-search-rs.config.example.toml](examples/grok-search-rs.config.example.toml) | 本机接线形状；所有 key 均为占位符 |
| [examples/registrar.env.example](examples/registrar.env.example) | 本机生效的非敏感注册器默认覆盖 |
| [examples/grok-register.config.example.json](examples/grok-register.config.example.json) | 单次注册数量的脱敏示例，sink 为占位地址 |
| [evidence/2026-10-21.md](evidence/2026-10-21.md) | 主线程实测与本目录源码/文档核对的来源分界 |

配置示例用于对照，不会自动加载。现有客户端继续使用原有私密配置；不要把示例覆盖到正在运行的配置上。清单里的绝对路径属于本机索引，在其他机器上须换成自己的路径。

## 凭据与相邻目录

- Grok 共享配置在 `C:/Users/HP/.config/grok-search-rs/config.toml`。本次只读取了 URL、别名、开关、数量和超时的白名单字段。
- 上游 `.env`、数据库、账号文件、Cookie、token、浏览器 profile 和日志不收录到本目录；示例里 `<...>` 的值需要由操作者通过原有凭据机制配置。
- 现有 `Capture_MCP_0.9.1_D1` 和 `capture-mcp` 保持原样。前者的 `pyproject.toml` 是 `0.10.6` candidate，README 的 online `0.10.5` 是历史描述；后者 `webshot_mcp_app` 的源码清单版本为 `0.4.0`。本轮没有实时截图测试，详见 [机器记录](verification.json) 的 `adjacent_capture_notes`。
