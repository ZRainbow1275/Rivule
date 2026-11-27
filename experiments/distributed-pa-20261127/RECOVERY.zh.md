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
