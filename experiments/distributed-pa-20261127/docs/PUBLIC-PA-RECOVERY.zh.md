# PA 断线时如何接回原任务

| 路线 | 丢回执后的下一步 | 何时停下 |
| --- | --- | --- |
| OpenAssistant REST | 官方提供按同一用户、同一键及同一请求内容复用原回执的机制。先核对本地原任务账本，再看服务端是否已知在有效窗口内。 | 文档没有说明保留期限，默认不重放。键撞而内容不同、账户不符、期限未知均交人复核。 |
| OpenAssistant MCP | 只验证实际授权会话的 `tools/list`，分别核对工具、身份和 schema。 | REST 的重放机制不会自动继承到 MCP。 |
| MuleRun 官方 CLI | 有原会话已保存的确切 ID，只读同会话详情及事件；确认接收与确认完成分开。 | 无 ID、不明中断、读取权限错误均不重发。不要把 CLI 中断当成只停止本地观察：官方说明会发送取消。 |

OpenAssistant 试验将创建回执、运行回执、工件与 Rivule 主 Agent 验收分开。收到任务 ID 不等于执行；已完成的状态也不替代读取并核验具体工件。只有取得原任务“未运行”的独立证据，加上对第二操作的明确授权，才能评估单独的 process 调用。两步各自保留不同键；如果创建已经触发执行，不再调用 process。外部交付不在当前试验许可内。

两个适配文件只描述或分类，不开启连接、启动子进程、接凭据或发请求。用于专用用户级账号，助手不接入私人邮箱、日历、联系人或网盘。第一次真实验证仍需确认用户、费用、数据区与留存；仅发送公开文本。读回活动/工件必须另做授权与真实回执审查，模拟返回只验证分类和去重行为。

一手参考：[OpenAssistant Tasks](https://docs.openassistant.us/reference/tasks) · [API Authentication](https://docs.openassistant.us/guides/api-authentication) · [MCP](https://docs.openassistant.us/guides/mcp) · [MuleRun CLI Sessions](https://mulerun.com/docs/cli/commands/session)。
