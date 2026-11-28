# 试稿换手后，恢复哪一份被验收

Rivule 的离线实验沿用原事件账本，把「提供方完成」和「主 Agent 验收」分开。一个可带走的示例记录包含：

```text
助手交稿        主 Agent 验收                 接手者复核
版本 5        → 版本 6                     → 原文件：摘要相符
还不能导出      绑定版本与文件的 SHA-256       同名文件改字：摘要不符
                                            要确认谁验收：回查可信账本
```

| 手上的材料 | 可当场核对的结果 |
|---|---|
| 原件和无签名记录 | 文件匹配记录里的 SHA-256，仍待核对签发来源 |
| 同名文件改一个地名 | 文件不符；名称不参与认定 |
| 只有已交稿或 provider 完成态 | 仍待验收，不生成验收记录 |
| 仍有读权限，且能访问可信原账本 | 可复核所写的验收版本、角色、时间、尝试别名和摘要 |

## 在离线环境复核

使用 Node 24；示例在 `examples/portable-acceptance/`。都是公开短句和合成任务，不依赖看板 UI、不调用助手。下面第一条成功只提示「与副本相符」，第二条退出 2；注意两个文件名是相同的。

```sh
node examples/build-acceptance-sample.mjs --check
d=examples/portable-acceptance
node examples/verify-acceptance-copy.mjs "$d/acceptance.json" "$d/original/验收试稿.txt"
node examples/verify-acceptance-copy.mjs "$d/acceptance.json" "$d/edited/验收试稿.txt"
node --test tests/portable-acceptance.test.mjs
```

导出与可信账本回查仅限实验宿主显式启用并提供示例别名；发起方必须是当前对任务有阅读权的主 Agent。可搬的记录不含用户、账号、供应方回执、原任务/输入或真实执行环境。已交稿历史、当前展示状态或可复制的哈希不授予验收权限。这里不做数字签名、身份背书、付款事实、学历／履历证明或外部公示；合成时间戳只是确定性试验时钟。原看板和生产保持原样。
