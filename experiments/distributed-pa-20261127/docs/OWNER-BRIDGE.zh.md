# 接回 Rivule Owner：底座与首测

对比公开 main 8d16915e17b522bc591ecebec46968fa5b61af4e 与当时发给用户的 V388 备份提交 4408b28f62441502e6c77808fa528ffaa6a81187：package.json、Owner Worker、dashboard、dashboard-read-model、dashboard-task-picker、source-bridge SDK、source-bridge-hook 指南与 INTEGRATIONS 都是相同 blob。此处可以共用接缝，但两套快照仍不当作相同，也不切换线上现有 V388。

1. 把 task 拆分标识独立绑定现有 source/project/task/run/branch。旧 split-child 仍限原来源及项目，跨 PA 协作只做新关系，不会改旧任务作者或归属。
2. 一个调度域持有权威版本与共享席位锁；多个看板共享席位时不能各自在单表内部判空。先只在一个隔离协调域验证。
3. SQL 实验把事件和投影 outbox 同事务持久化。消费者凭版本追平；outbox 条目无外发许可证。写成功后超时进待核，从原请求查证；旧事件重放不生成新的发送资格。明确限制：当前是小型全量重放实验、无快照升级；测试用 Node SQLite 与模拟 resolver，未部署 Cloudflare 数据库或迁移。
4. Muse 现有 muse-main 继续只上报。新 OAuth 每席位从服务端解析权威身份；调用方不能自报自己是谁。实验桥现支持分别授权只读、领取和交稿。上线前补由同一事务持有的领取→返回工作包 ACK、续租、撤权后的拿回权限、真实匿名化工件与回执；先验证 API/Connector 支持再启用。
5. Cue 在有明确同意的专用 Agent 首测，仅公开文本；选择跑真实调用之前确认路由、服务端凭据去向、保留区和权限范围。不要把 API key、真人账号、整段聊天写进看板或 GitHub。

验证命令：在 experiments/distributed-pa-20261127 根目录用 Node 24 运行 `node --test adapter/*.test.mjs tests/*.test.mjs`。实验模块全部默认未接生产。无真实账户运行，详见各测试的注入 transport。
