# 4. 压缩行适配 regular 模式：TuiMainScreen 发现 + 全部展开快捷键

Date: 2026-09-08

## Status

Accepted

## Context

压缩渲染补丁（ADR 0003）只通过 `TuiAltScreen` 的布局盒树发现 chat 容器——从 regular 模式（`TuiMainScreen`）启动的会话完全不压缩，README 里「其他功能在普通模式下均可用」名不副实；全屏切回 regular 的会话压缩行还在，但唯一展开途径是鼠标点击，regular 模式没有鼠标捕获。需要给 regular 模式补上（a）压缩生效、（b）展开途径，并在压缩行上标注该途径。

键位侧的硬约束：pi 的 `keybindings.json` 只接受内置动作名，扩展无法注册可重绑的命名键位；扩展唯一入口 `pi.registerShortcut(keyId)` 收原始键串。26 个 ctrl 字母全部有内置绑定——保留键（ctrl+o/ctrl+t 等 17 个动作）注册即被跳过，编辑键（ctrl+e/ctrl+y 等）会带警告覆盖并破坏编辑。

## Decision

1. **发现**：`installTurnCollapse` 在 wrap `TuiAltScreen.prototype` 之外同样 wrap `TuiMainScreen.prototype.requestRender`——regular 渲染器直接挂 document/chat 容器、没有布局盒，用现成的 `findMessageHolder` 沿 children 树找 chat 容器。两个 wrap 每帧都（i）更新 `rendererMode`（regular/fullscreen）、（ii）把 `requestRenderRef` 重绑到当前活着的渲染器（顺带修掉全屏切回 regular 后指向已死 alt 实例的悬空引用）。照旧版本守护，形状不匹配即静默失效。
2. **快捷键通道**：`pi.registerShortcut`，默认 **`ctrl+\`**——排查后它是唯一「无内置绑定 + 传统终端编码（\x1c）可靠送达」的 ctrl 键（已验证 `matchesKey` 可匹配；alt 组合在 macOS 默认终端不可靠，ctrl+shift 区分依赖 kitty 协议）。键值可经 `turnCollapse.expandAllKey` 配置（空串 = 禁用），**重启/重载后生效**（快捷键每进程只注册一次）。
3. **单一事实源**：行尾标注从**注册时**的键渲染（`registeredExpandAllKey`），不从会话中途的配置值渲染——杜绝「标注写着 A、实际派发 B」的漂移；配置改动在重启前不影响两者。
4. **语义**：`toggleExpandAll` 仅在 `rendererMode === "regular"` 时生效，翻转 `expandAllActive`；渲染时 `runExpanded(head) = (regular && expandAllActive) || expandedRuns`。展开 = 所有压缩行（✻ 行/同类归纳行/工具单行/归纳 Thought 行，含其内思考）整段展开，与点击展开同一条渲染路径；再按收起。全屏模式不参与——点击逐行展开是既有契约，避免全局态与逐行态打架。
5. **行尾标注**：`pushCompressed` 是所有压缩行的统一出口，在这里给**每条**压缩行追加暗色 `(ctrl+\ 展开)` / `(ctrl+\ to expand)`（文案随 `settingsLanguage`），仅 regular 模式且未处于展开态时显示。
6. **状态反馈**：切换时 `ctx.ui.setStatus` 在底栏显示 2 秒确认信息（如 `✻ 已全部展开`）。

## Considered Options

- **复用 ctrl+o（app.tools.expand）** — 否：保留键，`registerShortcut` 注册同键直接被跳过；用 `onTerminalInput` 拦截抢走原生行为则违背「扩展不遮蔽原生交互」的既有哲学。
- **alt+o / 其他 alt 组合** — 否：macOS 默认终端把 Option 用作特殊字符输入，alt 键不可靠送达。
- **ctrl+shift+o 等双修饰** — 否：传统终端编码下与 ctrl+o 同字节，区分依赖 kitty 协议，不可靠。
- **快捷键在两种模式下都生效** — 否：全屏下「全局展开态」与逐行点击态（`expandedRuns`）互相覆盖，点击看似失灵；快捷键定位为「无鼠标环境的全局替代」。
- **标注只在最后一条压缩行** — 否（用户裁决）：每条都带，任何滚动位置都可发现。
- **行尾标注读会话中途的配置值** — 否：注册不可逆（每进程一次），中途改配置会造成标注与派发漂移；改为随注册值渲染。
- **`onTerminalInput` 全局拦截自实现** — 否：绕过官方通道的冲突仲裁与快捷键帮助集成（注册成功后 pi 的 shortcuts 面板会列出该键）。

## Consequences

- 正面：regular 会话从第一条消息起就有压缩体验；快捷键走官方通道（冲突仲裁 + shortcuts 帮助面板集成）；标注与派发永不错位；模式切换时 `requestRenderRef` 始终指向活渲染器。
- 成本：`expandAllKey` 改动需重启/`/reload`；保留键配入会被 pi 静默跳过（快捷键失效，标注仍显示该键——README 已注明）。
- 已知限制：`thought=single` 的逐消息 ✻ 标签不属于压缩行，不在「全部展开」范围（regular 下暂无单条展开途径，可用 thought 设置整体切换）；regular 模式终端回滚区不可回写，settle 时收缩触发 pi 的 clearOnShrink 清回滚 + 整帧重绘（pi 原生行为）；rendererMode 依赖渲染请求更新，模式切换后 ≤1 帧的标注状态滞后（250ms 渲染缓存自愈窗内）。
- 关联：CONTEXT.md「全部展开 / 转录折叠」词条；README「普通模式支持」「环境要求」段；ADR 0003（压缩契约本体）。
