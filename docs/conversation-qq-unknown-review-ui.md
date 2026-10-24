# QQ 普通对话未知回执：所有者核对界面

该面板只处理已有的普通对话未知回执，不是发送、重试、运行时恢复或新的授权通道。原投递结果始终为 unknown。完成核对不代表接收人已收到；不会重发原回执，既有积压跳过，后续新消息仍须通过原有所有者 QQ 通知开启流程。

## 明确、分开的步骤

1. 打开只读来源列表 `GET /dashboard/conversation`。此时不列出未知回执。
2. 明确选择 PA 并点击授权，`POST /qq-review/access {csrf,source_id,confirm:true}`。仅返回该来源绑定接收人的未知回执元数据，没有回复正文。管理权限具有服务端返回的短期 expires_at。
3. 选择精确 receipt_id 并请求 `/prepare`，带当前 access_token 和 confirm:true。这一步只准备预览，不确认核对。
4. 核对来源沿革、接收范围、精确回执和影响，点击“确认仅核对，不重发”。`/confirm` 带 review_id、完整 scope digest、管理 token 和 confirm:true。

预览 scope_summary 包含原/current source generation、operation grant revision、consent revision 和当前同意状态。界面明确说这是持久化的来源沿革，不冒充实时所有权验证。预览期限使用服务器返回 expires_at，可能只有约 30 秒，不擅自延长到管理权限期限。

## 未知结果与关闭

- 已提交 confirm 后发生网络错误或返回 readback_required，客户端不重试 confirm、不再 prepare 同一次核对。仅 `/readback {csrf,source_id,access_token,review_id}` 查询。
- 关闭、隐藏、切换来源、过期会清除可见私有元数据与预览，并对已收到的精确管理 token 尝试 `/cancel`。取消只关闭管理权限，不撤销已经明确确认的核对。
- 迟到的 access 返回不会重新打开 UI；客户端会尽力取消该精确 token。网络中断导致 token 未收到时不能声称服务器已撤销，它按短期规则自然过期。
- 当前页面内只保留未完成核对的 source_id/review_id 以供只读查询，不保存正文或私密 token 到 localStorage。关闭重开或管理权限过期后，先明确重新授权，再只读查询旧 review_id；不再次 confirm。
- blocked 且需要 manual_reconciliation_required 时，显示“状态已变化，仍暂停，需要人工核对；原消息仍未知且不会重发”。不显示只读查询能恢复的承诺，不自动开启或建立新发送路径。
- 浏览器整页重载后，必须重新明确授权。access 的 pending[].review 可返回 {review_id,state, next_step}，界面从此服务器持久摘要恢复 readback-only 或 terminal/manual 状态，不依赖浏览器存储、不重新 prepare 或 confirm 已记录的意图。
- readback 若明确返回 confirmation_required / new_owner_preview_required，表示尚未记录确认。旧 review 终止，不重新确认它；只有关闭后重新明确获取权限、查看新的预览才可继续。

## 离线验证

`tests/conversation-review-controls.test.mjs` 覆盖无隐式列表/确认、精确请求体、短预览过期、单飞、取消/迟到响应、401、隐藏清理、焦点、未知结果重新授权后的只读查询，以及 terminal/manual、整页重载后的服务器摘要恢复、未记录确认时新显式预览分支。该测试不发送任何来源消息，不产生真实所有者核对，也不证明 QQ 收件人实收。
