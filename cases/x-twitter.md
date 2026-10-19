# X (Twitter)：搜索动态 / 发帖

- 入口 URL：https://x.com/search?q=...&f=live ，https://x.com/compose/post
- 前置条件：Chrome 已登录 X
- 不可逆动作：点击 Post

## 配方
1. 看动态：`goto` 到 search?q=关键词&f=live，然后用 `read_text` 读正文（比 snapshot 省 token）
2. 发帖：`goto` 到 /compose/post → `snapshot` 找到 textbox "Post text" → `type`（Draft.js 编辑器，用 insertText 写入可以正常生效）
3. 用 `locate "button Post"` 确认按钮不再是 disabled → 用户确认后再 `click`
4. 用 `wait_for` 等推文里的一段文字出现在主页时间线上，以此确认发送成功

## 运行记录
| 日期 | 结果 | 耗时 | 卡点 / 修复 |
| - | - | - | - |
| 2026-10-15 | ✅ 搜索 + 发帖成功 | 发帖约 20s | 发帖页一直判定“忙”，原因是长连接；已在 v0.2 修复判定逻辑 |
