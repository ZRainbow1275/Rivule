# 实验分支恢复

实验源保存在 Rivule 仓库 `lab/distributed-pa-20261127`，相对目录 `experiments/distributed-pa-20261127/`。新环境请先核实精确 Git 版本。只用已授权仓库与读取凭据，不从未验证的下载位置拉代码。若工具不能直接列子目录，可比较基础提交 `8d16915e17b522bc591ecebec46968fa5b61af4e` 和已核实的实验提交，收齐该前缀下文件；读取测试夹具、目录 JSON、示例与源码，每个文件校验原 Git blob。不要用未经对照的剪贴板副本覆盖恢复内容。

在实验目录下用 Node 24：
```sh
node --test --test-concurrency=4 $(find . -name '*.test.mjs' -print | sort)
node examples/rebuild-verified-replay.mjs --check
node examples/build-board.mjs | cmp - Rivule-调度看板演练.html
node examples/smoke-board.cjs
node catalog/smoke-view.cjs catalog/Rivule-PA-接入清单.html
```

测试只接触合成数据与临时 SQLite。浏览器交互文件是离线演练，不是 V388 或生产部署。生产与付费账户不在恢复范围。

看板新增「一个窗口撤权，另一项继续」：撤权立即清空该窗口缓存与游标；另一窗口可验收独立工作。新授权必须新读整板，旧回包不会还原卡片。回放不含实际回执或凭据。

看板新增「迟到的失败回包」：复用同一席位时，旧失败回包即使按最新修订提交，也不会覆盖原任务验收或中断独立任务；有效的先到失败仍保留。原任务及独立任务都获得验收后才可合稿。四帧来自两条独立 SQLite 连接的合成测试。
