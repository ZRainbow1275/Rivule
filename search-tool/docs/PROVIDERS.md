# Provider 使用指南

## 先用已配置入口

日常搜索不需要启动注册器，也不需要重新部署 `MySearch Proxy` 或 `grok2api`。先调用已有 MCP；出现故障时用 Grok Search `doctor` 定位到具体 Provider，再检查真实搜索或正文提取结果。

本指南中的 JSON 是调用参数，不是已执行的新请求。当前实测快照见 [verification.json](../verification.json)。

## Grok Search：规划、搜索、读来源

本机入口为 `C:/Users/HP/.codex/tools/grok-search-rs/grok-search-rs.exe`，源码位于 [D:/GrokSearch-rs](file:///D:/GrokSearch-rs/README.md)，源码清单版本 `0.1.22`。当前为本地 stdio → OpenAI-compatible 链路，主别名 `grok-4.20-0309-non-reasoning`，后端地址 `http://127.0.0.1:8100/v1`。

1. 按当前工具契约先完成 `plan_intent` → `plan_complexity` → `plan_sub_query`；复杂度 2 另做搜索词和工具映射，复杂度 3 再做执行安排。
2. 调用 `web_search`。普通检索用 `extra_sources=3`；重要研究可用 `6`。`model` 只在用户明确指定时传入。
3. 保存返回的 `session_id`，用 `get_sources` 找到支持结论的原文；分页时按 `next_offset` 继续。
4. 已知 URL 用 `web_fetch`。若结果有截断标记，继续取完整正文，不能把摘要当成全文。

```json
{
  "query": "Gemini Apps custom connected apps MCP personal Google Account official documentation",
  "extra_sources": 3,
  "response_format": "concise"
}
```

```json
{
  "session_id": "<web_search 返回的 session_id>",
  "offset": 0,
  "limit": 5
}
```

`concise` 适合先定位来源；`detailed` 可携带正文，但仍受响应预算约束。应一起查看 `fallback_used`、`fallback_reason`、`search_provider`、来源列表和实际正文。一次成功调用的模型别名只按路由名记录，不据此推定底层模型身份。

当前具体答案错误及官方更正集中记录在 [README](../README.md#把运行健康与答案质量分开看) 和 `GROK-QUALITY-01`，不把该错误归入连接故障。

### 共享配置

现有私密配置位于 `C:/Users/HP/.config/grok-search-rs/config.toml`，优先级为进程环境变量 → 共享 TOML → 内置默认值。当前非敏感设置为：

- `tavily_api_url = "http://127.0.0.1:9874/api"`
- `firecrawl_api_url = "http://127.0.0.1:9874/firecrawl/v2"`
- `exa_api_url = "http://127.0.0.1:9874/exa"`
- 三个 Provider 的 `enabled = true`
- `default_extra_sources = 3`、`fallback_sources = 5`、`timeout_seconds = 180`

字段形状见 [脱敏 TOML](../examples/grok-search-rs.config.example.toml)。当前 OpenAI-compatible 使用方式属于 stdio；上游文档中的远程 HTTP/Responses 模式是另一种接入，不能原样替换本机链路。`switch_model` 会持久化改动，诊断时不要把它当成只读操作。

## Tavily：补充检索、正文和网站地图

现有 Tavily 路由由 `MySearch Proxy` 提供：

| 本地接口 | 用途 | 本轮证据 |
| --- | --- | --- |
| `POST http://127.0.0.1:9874/api/search` | 补充来源、降级检索 | Grok 搜索的 Tavily 补充来源取得结果 |
| `POST http://127.0.0.1:9874/api/extract` | 正文提取 | doctor 样例 extract 通过 |
| `POST http://127.0.0.1:9874/api/map` | 发现站内 URL | 实际 `web_map` 返回 3 个 URL |

优先从 Grok Search 调用 `web_map`，先小范围探索：

```json
{
  "url": "https://api-docs.deepseek.com",
  "max_depth": 1,
  "max_breadth": 3,
  "limit": 3,
  "max_results": 3,
  "timeout": 30
}
```

Proxy 接受下游 `Authorization: Bearer <LOCAL_PROXY_TOKEN>`，再从原有池里选择上游 key。Tavily 转发会移除请求体的本地 `api_key`，以 Bearer 头向上游鉴权。不要把 Proxy token 和 Tavily 官方 key 混用。

## Firecrawl：当前确认抓取，搜索另列

本地路由：

- `POST http://127.0.0.1:9874/firecrawl/v2/scrape`
- `POST http://127.0.0.1:9874/firecrawl/v2/search`

Grok Search 的配置会使用这一 Firecrawl 前缀做补充或 fallback。doctor 的样例抓取通过；独立 search 尚未实测。使用时看具体返回正文和错误，而不是把 scrape 的通过状态扩展到 search。

## Exa：两条入口分别记录

- Grok Search 的 `exa_search` 通过本地 `http://127.0.0.1:9874/exa/search`，本轮真实搜索成功。
- MetaMCP 的 `web_search_exa` 是另一条客户端入口。本轮首次 30 秒超时，后一次约 7 秒返回实际结果。首次超时保留为失败事件，不覆盖后一次成功。

Grok Search 入口的参数：

```json
{
  "query": "Gemini Apps custom MCP official documentation",
  "num_results": 3
}
```

第二来源应核对来源内容和结论。只换客户端入口，未必改变底层 Provider；需要独立 Provider 时选 You.com 或直接打开权威原文。

## You.com：使用现有 Node bridge

已安装 `@youdotcom-oss/mcp` **4.0.3**，入口：

`C:/Users/HP/.codex/tools/mcp-consolidated-20261005/you-mcp/node_modules/@youdotcom-oss/mcp/bin/stdio.js`

该 bridge 连接 `https://api.you.com/mcp`，凭据环境字段为 `YDC_API_KEY`。示例见 [MCP 配置](../examples/mcp-servers.example.json)，实际凭据继续留在原有客户端配置中。

本轮 `you_search` 返回了官方 MCP 结果。普通定位来源可使用：

```json
{
  "query": "Gemini Apps custom MCP site:support.google.com",
  "count": 3,
  "extraction": "highlights"
}
```

检索片段用于选来源。需要全文时再使用服务当前暴露的内容提取工具；`full_page` 的 live fetch 有单独计费选项，本轮未调用。其他研究或内容工具未在本轮实测。

## Crawl4AI：页面转 Markdown

本机服务地址 `http://127.0.0.1:18235`。当前 `md` 对 `https://example.com` 返回 `success=true` 且 Markdown 非空，适合已知 URL 的另一路正文提取。此记录覆盖该静态样例；动态页面、登录态、PDF 和截图能力未在本轮测试。

## DeepSeek：官方 API 已确认，鉴权待有授权的接入

2026-10-21 已读取 [官方 Search & Fetch 指南](https://api-docs.deepseek.com/guides/search)：

| API | 接口 | 最小请求体 |
| --- | --- | --- |
| Search | `POST https://api.deepseek.com/v1/tools/search` | `{"query":"MCP documentation","count":3}` |
| Fetch | `POST https://api.deepseek.com/v1/tools/fetch` | `{"url":"https://example.com"}` |

二者使用 `Authorization: Bearer <DEEPSEEK_API_KEY>` 与 `Content-Type: application/json`。Search 返回结构化 `results`；Fetch 返回 Markdown `content`。Search 的 `query` 长度为 1–128 个 Unicode 字符，`count` 为 1–50，可用 `need_content` 请求正文。

当前会话没有注册 DeepSeek 搜索工具，也没有发现 `DEEPSEEK` 环境项；本轮只读取了公开文档，没有发出鉴权 API 请求。后续接入应先取得调用授权，通过受支持的客户端凭据机制配置已有 key，再分别验收 search 和 fetch；本目录没有内置适配器或自动扣费请求。

## 按实际故障分流

| 现象 | 下一步 |
| --- | --- |
| MCP 无法启动 | 核对已记录的可执行文件/Node 路径与运行时，不重部署全部服务 |
| doctor 可达，但搜索空或有 `error` | 检查真实请求的错误、fallback 与结果内容，连接探测单列 |
| 401 / 403 | 分清客户端 token、Provider key、上游账号权限；不要在报告里贴凭据 |
| 超时 / 429 / 5xx | 记录具体入口、耗时和响应；有依据地有界重试，保留失败事件 |
| 来源支持相反结论 | 回到官方原文，修正综合答案；不要用更多同源摘要压过反证 |
| Map 有 URL、正文却缺失 | 分别检查地图与提取路径，不把链接发现视为全文获取 |
