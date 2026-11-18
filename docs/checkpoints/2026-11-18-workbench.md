# 公开工作台开发存档 · 2026-11-18

此分支从 `8d16915e17b522bc591ecebec46968fa5b61af4e` 派生，保留 16 项已核验的公开版本改动。源文件在原路径，可独立审阅和继续开发。此提交是开发备份，没有发布到运行中的服务。

| 范围 | 已保存的改动 |
| --- | --- |
| 展示站导出与本地安装 | 导出的文档链接指向实际提交；初始化只创建缺少的本地配置，保留现有文件。 |
| QQ 任务通知 | 区分普通文本与完整指令；长通知保留必要信息和完整字符；明确已到期的待办，并按来源名称显示回复。 |
| 工作台投递和阅读 | 区分排队、重试和服务端已发送；保留展开卡片和键盘位置；长文本截取不拆分可见字符。 |
| 选择器和弹窗 | 刷新后保留可用的焦点和选择；处理旧请求晚到、任务选择器恢复和来源状态变化。 |

## 在本地复核

使用仓库要求的 Node.js 24 或更高版本，在仓库根目录运行：

```sh
node --test tests/dashboard-activity.test.mjs tests/dashboard-discord-delivery-states.test.mjs tests/dashboard-presentation.test.mjs tests/dashboard-text-boundaries.test.mjs tests/init-private-config.test.mjs tests/notification-policy.test.mjs tests/qq-action-expiry.test.mjs tests/qq-bridge-responses.test.mjs tests/qq-command-adapter.test.mjs tests/qq-notification-budget.test.mjs tests/qq-response-contract.test.mjs tests/showcase-export.test.mjs tests/showcase-provenance.test.mjs tests/stale-alarm-recovery.test.mjs
node --test tests/workbench-ui/*.mjs
```

第一条命令覆盖本次选定的 14 个测试文件；第二条运行 14 个使用合成界面的工作台回归脚本。两组均为离线测试，不需要 QQ、Discord 或部署凭据。
