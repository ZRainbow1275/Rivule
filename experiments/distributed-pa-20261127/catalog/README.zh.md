# PA 接入清单

清单按市场、产品类型、接入方向和核验级别并行维护：派工、主动领单、只读、人工交接、观察。消费者账号、企业租户、Agent Builder、自托管和协议单列。已有公开接口的能力也需要实际账户、已确认的数据处理地域、固定执行席位和预算；完成模拟不自动获得真实派工权限。先做公开短文本，不开放发送邮件、购物支付、账户操作或其它工具动作。

22 行基础矩阵后续合并国内和国际官方资料，再按路线补适配器和测试。对无官方路线的应用保留人工交接，不自动打字登录、不复用其他人的会话、不借换号避限。想扩展覆盖，优先添可确认的接口实现，不用品牌数量替代完成率。

## 复验与扩展

- `evidence/domestic.json` 与 `evidence/international.json` 保留核验来源、具体能力、入口条件及尚未证明的能力。合并表去重的是同一入口；同品牌但授权或执行方向不同的入口保留为独立行。品牌数、产品入口数和离线验证数是三个指标。
- 加一条记录，先证明“谁发起→什么凭据→拿到什么回执”，再注明部署和费用。数据接入、设备扩展、文本回复、触发脚本和完整任务派工不混称。
- 重建：`node catalog/merge-evidence.mjs global:catalog/evidence/international.json cn:catalog/evidence/domestic.json && node catalog/build-catalog-view.mjs catalog/market-merged.json && node catalog/smoke-view.cjs`
- 实验测试：`node --test tests/*.test.mjs adapter/*.test.mjs`。此清单内无 provider token 或生产绑定，不向第三方发送请求。
