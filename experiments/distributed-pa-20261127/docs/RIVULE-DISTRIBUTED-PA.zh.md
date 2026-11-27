# Rivule：主 Agent 调度台 · 第一轮实验

公开仓基线：Rivule v0.4.4 / 8d16915e17b522bc591ecebec46968fa5b61af4e。这是可独立移植的实验模块，不改 V388，不接真实账号、不发送真实任务、不改 QQ、Discord 或现有数据。

## 今晚先跑通一条链

一项公开资料研究 → 主 Agent 拆两份可独立验收的工单 → Cue 走官方 API 接收一单，个人 Muse 从自己专属的连接器领取另一单 → 分别交证据与产物 → 主 Agent 验收后合并。Cue 发后掉线只挂起自己的卡，Muse 继续。外部动作结果不明时停在「待核回执」，不能靠换号重做。

## 三条必须落成的规则

**按产物拆，不按 Agent 数量拆。** 研究、备选方案、实现和审查可各自交稿；会改同一线上对象或共同写一个段落就只给一名写者。工单写清目标、前驱、固定输入版本、数据范围、技能版本、输出格式、验收样例和预算。靠封好的文件摘要和前驱引用交接，不抄全段会话。[Google Research 对 180 组配置的比较](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)显示协作增益取决于任务结构。

**看板从任务账本投影。** 卡片看目标、领取者、最近确认时间、工件和阻塞。执行、验收、通知是三个状态；「已收到」「已交稿」都不是「已采用」。原快照序号只是读提示；权威写入用版本检查，事件 ID 幂等，尝试号与租约挡迟到，事件与发件箱同事务。网页、QQ、Discord 同取投影，消息补发不重做任务。[A2A 任务生命周期](https://a2a-protocol.org/latest/topics/life-of-a-task/) · [事务发件箱](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)

**MCP 给工具，Skills 给作业规程。** 新连接先给四个最小工具：列自己的任务、领任务、报进度、交工件；领取与汇报是有作用域的写操作，授予权限与派工不是同一能力。按 [Agent Skills](https://agentskills.io/specification) 版本化：任务带技能 ID／版本／摘要，规程留在执行域，缺版本停到待核。[Muse 工具策略](https://platform.muse.ai/docs)不同权限要分清；安装技能不增加权限。

## 地区和 Muse 池

- 用独立授权身份池，不是共享登录池。现有 [Rivule Muse](https://github.com/ZRainbow1275/Rivule/blob/main/docs/INTEGRATIONS.md)固定 muse-main 上报；个人 Muse 有[自建连接器](https://www.meta.com/en-gb/help/superintelligence/1687253048996149/)，按绑定身份各领各的。首测两位各领一张，再测对于同一张只能有一个领取者。一个主体遇到 429，按原主体冷却，不切号续投绕过限额。[Meta 条款](https://platform.muse.ai/terms)
- 先分类，再看执行、模型、日志、附件、存储实际落点。国内品牌、中文输入和大陆驻留是独立判断。Cloudflare [Durable Objects 数据位置](https://developers.cloudflare.com/durable-objects/reference/data-location/)的 APAC 只是位置提示。只限指定地区的数据，没有已核执行与存储链路就不进入全球队列、日志和看板。
- 先验双领、重复回调、迟到、授权撤回、外部效果不明、跨区误投、兄弟任务独立继续。再逐一启用真实适配器；目录详见同批提供方证据。区分文档支持、模拟通过、已授权实接三个等级。
