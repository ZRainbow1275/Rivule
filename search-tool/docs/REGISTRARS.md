# 注册与账号辅助工具指南

注册会创建外部账号，可能写入本地账号文件、上传 key 或更新 token 池。执行前应明确本轮服务、数量、并发、是否上传和目标池。本轮只核对源码与既有单元测试证据，没有提交注册表单。

## Tavily / Firecrawl / Exa 注册器

源码入口：[D:/tavily-key-generator/README.md](file:///D:/tavily-key-generator/README.md)。这是多服务注册器；实际搜索继续使用现有 MCP/Proxy。

### 使用本项目的 Python

已验证的运行时为：

`D:/tavily-key-generator/venv/Scripts/python.exe`

不要用宿主 Anaconda 代替它判断项目能否运行：主线程在宿主解释器运行启动测试时有 5 项失败，报缺少 `cloakbrowser` / `quart`；同一组测试在项目 venv 下通过。

以下为 **PowerShell** 命令。它们是已执行检查的复现入口，本目录没有重复执行：

```powershell
Set-Location 'D:\tavily-key-generator'
& '.\venv\Scripts\python.exe' -B -m unittest discover -s tests -p 'test_run_bootstrap.py'
& '.\venv\Scripts\python.exe' -B -m unittest discover -s tests -p 'test_config_placeholders.py'
```

结果分别为 **5 项通过**、**2 项通过**。启动测试使用 mock 控制浏览器安装和进程行为，覆盖 bootstrap 分支；它们不执行真实注册。

### 本机实际默认值与源码回退值不同

| 设置 | 本机 `.env` 生效值 | `config.py` 回退值 |
| --- | --- | --- |
| `DEFAULT_COUNT` | `1` | `5` |
| `DEFAULT_CONCURRENCY` | `1` | `2` |
| `DEFAULT_UPLOAD` | `true` | `true` |
| `EXA_DEFAULT_CONCURRENCY` | `1` | `1` |
| `EXA_MAX_CONCURRENCY` | `1` | `1` |

本机串行行为来自 `.env` 覆盖，不是源码的通用默认。迁移配置时可对照 [非敏感覆盖示例](../examples/registrar.env.example)，不要复制私密 `.env`。`run.py` 还会按本轮数量约束并发。

**默认上传已开启。** 若只获准创建单个账号、未获准写入远端池，在“是否自动上传”提示处明确选 `n`；不要直接接受该提示的默认值。

### 获准实际注册后再启动

```powershell
Set-Location 'D:\tavily-key-generator'
& '.\venv\Scripts\python.exe' '.\run.py'
```

这是交互式注册入口，不是只读健康检查；启动可能检查并补装缺少的依赖。不要用 `run.py --help` 代替无副作用探测。

启动台按源码显示 Tavily / Firecrawl / Exa 三个选项，再选择邮箱域名、数量、并发和上传。首次获准运行时应使用数量 `1`、并发 `1`，明确上传选择，然后分别看注册结果、key 的实际调用验证与落池结果。上游 README 对 Tavily 邮件注册关闭的描述属于历史测试结果，官网当前政策未在本轮复核。

账号和 key 输出留在原项目的受保护运行目录。例如 Exa 的 `exa_accounts.txt` 包含邮箱和 key，不应附到工单或提交 Git。各 Provider 的真实注册成功率本轮均未测量。

## Grok Register：创建账号并落池

源码文档：[D:/Desktop/grok-register/readme.md](file:///D:/Desktop/grok-register/readme.md)。它将注册执行器、Web 控制台、WARP 出口和 `grok2api` sink 组合在一起。运行依赖可用出口、可被 x.ai 接受的邮箱和明确的 token sink。

- 上游 README 的单轮入口是 `python DrissionPage_example.py --count 1`。
- 上游配置示例 `run.count=50`；本目录的 [脱敏示例](../examples/grok-register.config.example.json) 改为单次 `1`，sink 用占位地址。
- 上游一体化部署说明使用控制台 `18600` 与内置 `grok2api` 的 `8000`。现有搜索链路使用 `8100/v1`；不要为查看文档另启一套服务或把新 sink 自动指向现有池。
- 真正运行前，按上游文档配置邮箱与 sink，并先确认对应版本的管理接口、凭据和写入目标。本轮没有验证该项目的控制台、网络出口、注册或落池。

本目录不执行 Docker 部署、不启动批处理，也不迁移其邮箱或 token 配置。

## EasyGrok：登录已有账号后提取 SSO

只读核对了 [D:/Desktop/easygrok/get_sso.py](file:///D:/Desktop/easygrok/get_sso.py)。这是已有账号的登录与 SSO 提取脚本，不是创建账号的注册器。

源码行为：

- 从原项目的 `accounts.json` 读取账号；本轮未打开该文件。
- 优先使用 Edge，其次 Chrome，DrissionPage 固定本地端口 `9988`，加载 `turnstilePatch`，并创建一次性的临时 profile。
- 登录后在终端打印部分 SSO，并写入 `sso_results.json` 与 `sso_tokens.txt`。这些输出均是敏感运行数据，本轮未读取。

如果以后获准执行，应先确认其独立浏览器、扩展和端口的授权及占用情况，并保护终端和输出文件；不要把它当成当前受管 ShardBrowser 会话的健康检查。本轮没有启动该脚本或改动浏览器扩展。

## 注册与搜索分开验收

账号创建成功、key 调用通过、上传成功、搜索客户端实际使用是四个结果，各自保留证据。本轮已完成的只有原生 venv 单元测试与既有搜索调用；注册、SSO 登录和新 key 落池仍未执行。
