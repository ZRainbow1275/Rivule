# 第三方来源

- Moli 1.1.18：独立 Rust 浏览器内核，采用 Apache-2.0 / MIT 双许可。本模块安装固定的官方发布件，不复制其源码、不内含 Chromium。上游 [README](https://github.com/lexmount/moli/blob/v1.1.18/README.md)、[Skill](https://github.com/lexmount/moli/blob/v1.1.18/skills/moli-webfetch/SKILL.md)、[发布件](https://github.com/lexmount/moli/releases/tag/v1.1.18)。发行二进制及附属组件的许可见上游 [licenses](https://github.com/lexmount/moli/tree/v1.1.18/licenses)。
- 可选 Playwright 1.61.0：Apache-2.0；只有显式 Chromium 兼容模式需要。其浏览器按 Playwright 安装器选定的版本安装，保留浏览器自带声明。`chromium-seccomp.json` 是 [固定上游文件](https://github.com/microsoft/playwright/blob/v1.61.0/utils/docker/seccomp_profile.json) 的派生修改：压缩 JSON 排版，并在既有 namespace allow 组增加 `chroot`，使 cap-drop-all 容器内的 Chromium namespace sandbox 可执行其文件系统隔离步骤；默认拒绝策略及其余上游规则保持。对应 Chromium 149 的 [credentials.cc](https://chromium.googlesource.com/chromium/src/+/149.0.7827.55/sandbox/linux/services/credentials.cc) 包含该 `ChrootToSafeEmptyDir()` 路径。完整许可保存在 `PLAYWRIGHT-LICENSE`。sandbox 部署依据 [官方 Docker 文档](https://playwright.dev/python/docs/docker)。
- `network_guard.py` 改编自本地 `capture-mcp/webshot_mcp_app/webshot_mcp/security.py` 的公共网页 SOCKS 策略代理；未引用 Capture 运行时、配置、凭据或截图服务。删除了私网测试开关和 DNS 缓存；每次连接重新验证并连接到批准的数字 IP。原声明如下。

```text
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
