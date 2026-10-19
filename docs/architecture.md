# TabPilot 架构说明（v0.4）

## 1. 目标

在**用户自己的、已登录的浏览器**里，让 Agent 稳定地完成真实业务流程，尤其是表单类流程，比如 App Store Connect 提审、后台配置、报名、报销这类。体验目标：

- 开一个专用的标签组（「MCode」），放在单独的窗口里。用户可以在旁边看，也可以随时自己接手操作。
- 用户真实的 cookie 和登录态都能直接用，不需要 Agent 去登录。
- **不白屏、不莫名中断**。这是最高优先级。

## 2. 组件

```
MiniMax Code ──stdio MCP──▶ server.js ──unix socket──▶ relay.js ──native messaging──▶ 扩展 (MV3 SW) ──chrome.debugger/CDP──▶ 标签页
 (每个会话一个)              (~/.local/share/tabpilot)      (Chrome 按需拉起，单例)                  (常驻)
```

| 组件 | 职责 |
| - | - |
| `extension/` | MV3 扩展。负责标签组管理、CDP 附着、真实键鼠输入、注入页面助手 |
| `extension/page-helper.js` | 注入页面。负责快照与 ref、遮挡检测、表单读写、白屏判定 |
| `bridge/relay.js` | 由 Chrome 拉起，监听用户私有的 unix socket，在多个 Agent 会话和扩展之间路由请求 |
| `bridge/server.js` | Agent 侧的 MCP 服务。桥断开时会自动重连，必要时自动拉起 Chrome |

## 3. 关键设计决策

1. **用 Native Messaging，不用 localhost WebSocket**
   - Chrome 会按需拉起 host 进程，不需要常驻守护进程。
   - 只要 native 端口开着，MV3 的 Service Worker 就不会被浏览器回收，这是“中途断开”的主要来源之一。另外有 alarm 兜底重连。
   - socket 只有当前用户可访问（目录权限 0700），网页无法连进来；localhost 端口就做不到这一点。
2. **host 装在 `~/.local/share/tabpilot/`**：macOS 不允许浏览器执行 `~/Desktop`、`~/Documents` 下的程序（TCC 隐私保护），装在那里会静默失败。node 用绝对路径固定下来，因为 fnm/nvm 的 shim 路径是临时的。
3. **扩展 ID 固定**：manifest 里写了公钥 `key`，扩展 ID 恒为 `ppdfpijfpfcjnaimfhhdkpdpjbjmlohl`，从哪个路径加载都一样。
4. **专用窗口 + 标签组**：Agent 当前操作的标签页在自己的窗口里保持前台，不会被后台节流；同时开启 `Emulation.setFocusEmulationEnabled`，让页面始终以为自己有焦点。后台节流是 SPA 白屏的常见原因。
5. **真实输入**：点击和按键都通过 CDP `Input.*` 发出，事件的 `isTrusted=true`，和真人操作一样。对 React/Vue 这类受控组件，打字用 `Input.insertText`。
6. **页面就绪判定（settle）**：同时满足 `readyState=complete`、网络安静 500ms、DOM 安静 500ms，才算就绪；超过时限会如实报告“仍在忙”，不会假装成功。每次动作之后都会自动执行。
7. **白屏自愈**：`goto` 之后如果判定页面为空白（没有文字，也没有任何媒体或控件），会自动重载一次，并在结果里注明。`page_health` 用来诊断，会汇总加载状态、进行中的请求、控制台错误和失败的请求。
8. **表单填写必须回读校验**：`fill_form` 每个字段都会把值读回来比对。如果真实打字没生效，就回退到框架安全的写值方式；某个字段失败时，会说明是哪个、为什么。
9. **遮挡检测**：点击前先在元素中心做命中测试。如果被弹层挡住，会报告是什么挡住了，而不是盲目点下去。
10. **同一标签页串行执行**：避免并发的动作互相打架。

## 3.1 v0.3：按对话分组 + 自动收尾

v0.2 的问题：所有会话共用一个写死名为「MCode」的组；标签页只开不关；组名看不出是哪个任务。

| 机制 | 做法 |
| - | - |
| 会话身份 | MiniMax Code 的所有会话共用一个 MCP 进程，进程本身分不清会话。插件的 `PreToolUse` Hook 把 `session_id` 和会话标题注入每次调用（`session` / `sessionTitle` 参数）。 |
| 一会话一组 | 扩展里维护 `groupId → {title, session, color, lastUsed, kept}`（`chrome.storage.local`）。同一窗口里多组并存，颜色错开。 |
| 命名优先级 | Agent 传的 `task` › 会话标题 › 首个页面的 `🌐 域名` › `MCode`，强的来源可以覆盖弱的。 |
| 防堆积 | `tab_open` 优先复用组内空白页；每组最多 6 个标签页，超出关闭最久未用的；点击链接新开的标签页留在同一组。 |
| 收尾 | `group_done` 关整组（`keep=true` 折叠并标 ✓）；`SessionEnd` Hook → `session_end` 关该会话的组；每分钟巡检，闲置 30 分钟的组自动关闭（用户正在看的组跳过）。 |
| 用户接管 | 标签页被拖出组、或组被用户改名，即不再受管，TabPilot 不会关闭它。 |
| 浏览器重启 | 组 ID 会变；按标题 + 颜色重新匹配恢复的组，匹配不上就丢弃记录，绝不误关用户自己的组。 |

## 4. 已知限制（路线图）

| 限制 | 计划 |
| - | - |
| 跨域 iframe 里的元素不在快照中（比如 Apple ID 登录框），只能截图后按坐标点 | 用 `Target.setAutoAttach(flatten)` 接入子 session，让快照能穿透 OOPIF |
| 页面助手运行在主世界（main world），页面脚本理论上可以干扰它 | 改用 `Page.createIsolatedWorld` |
| 顶部会出现“正在调试此浏览器”的提示条，点“取消”会断开连接 | 这是 Chrome 的固有行为。下次调用时会自动重新附着 |
| 同时开多个 Chromium 浏览器时，后启动的那个会接管 socket | 需要的话，改成多浏览器路由 |
| 没有“提交前确认”的硬闸门，目前靠 Agent 自觉 | 增加危险动作白名单和确认机制，比如识别 submit/publish/pay 一类按钮 |
| 案例经验还没有沉淀 | 建 `cases/` 案例库，把每个站点的操作要点提炼成配方，执行任务时注入 prompt |

## 5. 工具一览

`group_status` `tab_open` `tab_close` `group_done` `tab_adopt` `goto` `snapshot` `locate` `click` `hover` `type` `fill_form` `press_key` `scroll` `read_text` `screenshot` `evaluate` `wait_for` `page_health` `console_logs` `network_log` `attach_files`
