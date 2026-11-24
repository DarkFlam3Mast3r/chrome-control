# Windows 首次设置

1. 运行本技能的 `scripts/setup.ps1`。它使用 Windows 自带的 .NET Framework 编译本机程序，写入当前用户的 `%LOCALAPPDATA%\CodexChromeControl\`，并注册 `HKCU\Software\Google\Chrome\NativeMessagingHosts\local.codex.chrome_control`。无须管理员权限。如果已经安装，直接进行下一步。
2. 在要使用的 Chrome 配置中打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择本技能的 **extension** 文件夹（里面有 manifest.json）。这个目录需要保留在原位。扩展名为「Chrome 网页控制」。
3. 从 Chrome 工具栏打开「Chrome 网页控制」。勾选 **默认允许所有网站**，并按 Chrome 的提示确认。之后切换到任意普通 HTTP 或 HTTPS 网页即可读取和操作，包括该配置中已登录的网站。个别网站可点「排除此网站」或「恢复此网站」。关闭总开关会恢复按网站授权。若只需授权一个网站，在该网页点「允许此网站」即可，范围是相同协议、主机和端口。
4. 用 `scripts/chrome.ps1 status` 检查本机连接，用 `scripts/chrome.ps1 tabs` 核对已允许的标签。日常使用可以直接用自然语言调用 `$chrome-control`。

本机命令和扩展通过 Chrome Native Messaging 以及仅限当前 Windows 用户的本地命名管道交换消息。一个 Windows 用户同时连接一个 Chrome 配置。Chrome 启动时扩展重新建立本机连接。调试端口 9222 的设置与本连接独立。扩展只操作授权网站的顶层文档，普通文字输入和 DOM 点击适用于支持这类事件的控件。

从旧版升级时，将新版技能文件复制到原安装目录，用 `scripts/setup.ps1 -UpdateOnly` 更新已注册的本机程序。在 `chrome://extensions` 找到「Chrome 网页控制」，点一次刷新。`status` 返回 `version: "1.3.0"` 表示新版已连接。网站选择保存在原扩展配置中。

`open URL` 默认后台打开。已有同一网址且可读取时，直接复用；技能刚创建且仍在加载的标签也可复用。若同一网址只在一个未共享的后台标签中打开，技能会另开后台标签，保留原页状态。全站模式下，技能为链接新建的后台标签可在相同来源等待、读取和选句。用户选中过该标签、离开该来源、关闭标签或重启 Chrome 后，该后台访问资格结束。单独授权的网站沿用原授权。

## 连接诊断

| 现象 | 下一步 |
| --- | --- |
| `REGISTRY_ACCESS_DENIED` 或旧脚本的 `Requested registry access is not allowed` | 终端读取本机程序注册项时被拒。读取链接时按下方的一次命令审批流程继续。 |
| `HOST_NOT_INSTALLED` | 核对当前 Windows 用户和已有安装。确认缺少本机程序后执行首次设置。 |
| `BRIDGE_BUSY` | 本机程序正在处理另一条命令。只读请求在发送前会再等一段时间。仍返回忙时，等前一条完成后再查询。 |
| `BRIDGE_OFFLINE` | 打开目标 Chrome 配置，在扩展弹窗检查连接，必要时点「重新连接」。旧版的 `BRIDGE_OFFLINE_OR_BUSY` 同时可能表示上一条命令仍在执行。 |
| `BRIDGE_CONNECTION_ERROR` | 连接命名管道时发生其他错误。查看回执中的 `detail`，并核对扩展弹窗状态。 |
| `BRIDGE_ACCESS_DENIED` | 终端打开当前用户的命名管道时被拒。沙箱内可走同一次命令审批，在用户会话内仍被拒时核对 Chrome 和终端所属的 Windows 用户。 |
| `PROFILE_BUSY` | 已有另一个 Chrome 配置连接。仅在要使用的配置启用此扩展，再点「重新连接」。 |
| `SITE_NOT_SHARED` 或 `open` 返回 `siteShared: false` | 检查弹窗显示的实际网站及排除状态。全站模式可用 `status` 核对；逐站模式以落地页的授权为准。Chrome 设置页和应用商店等受保护页面不支持扩展注入。 |
| `TAB_NOT_CURRENT` | 当前命令需要选中目标标签。用户只要读链接时可用 `open URL` 获取可后台读取的目标；需要操作原标签时以用户指定的前台或网站授权为准。 |
| `EXTENSION_RELOAD_REQUIRED` | 在扩展管理页刷新「Chrome 网页控制」，再看 `status` 中的版本。旧扩展收到新版静默打开命令时会停止。 |
| `NO_BACKGROUND_WINDOW` | 当前没有可容纳后台标签的普通 Chrome 窗口。下次已有普通窗口时继续。 |
| `WAIT_TIMEOUT` | 指定时间内未满足条件。读取目标标签的实际内容，检查是否跳转、文字有无变化或内容尚在加载。 |
| `NO_PAGE_TEXT` / `CONTENT_NOT_READY` / `EXPECTED_TEXT_MISSING` | 等待结束时，正文仍为空、仍在加载，或尚未出现指定文字。用回执的 `tabId` 和 `detail` 中的实际网址核对页面，可在原标签再运行 `read-start`。 |
| `SNAPSHOT_EXPIRED` / `SNAPSHOT_REQUIRED` / `SNAPSHOT_LIMIT` | 读取长文时传回同一份 `snapshotId`。读完或两分钟未续读后快照释放；失效时从头读取。单个文档最多保留八份未完成的快照。 |
| `TEXT_NOT_UNIQUE` / `TEXT_NOT_FOUND` | 读取正文，使用原句。重复出现时在 `select-text` 最后提供从 1 开始的序号。它建立原生 DOM 选区，依赖真实鼠标拖动的阅读器须另行核实。 |
| `SCREENSHOT_TAB_NOT_VISIBLE` / `SCREENSHOT_TARGET_CHANGED` | Chrome 只能截取窗口中所选标签的可见区域。静默任务保持原标签，在相同目标可见时再截图。 |
| `SCREENSHOT_PERMISSION_REQUIRED` | Chrome 要求截图授权时，在目标网页点一次扩展图标，关闭弹窗后再截图。`activeTab` 授权可在该标签的同来源页面复用。 |
| `OUTPUT_EXISTS` / `IMAGE_SIZE_MISMATCH` | 换一个新的 PNG 输出名；对比截图需使用相同视口尺寸。 |
| `PAGE_LOADING`、`PAGE_CHANGED`、`STALE_REF` | 核对标签 ID、实际网址和标题，再取一份正文或控件列表。 |
| `OUTCOME_UNKNOWN`、`PIPE_ERROR` 或脚本注入在导航中断开 | 用 `tabs`、`read` 或 `controls` 核实页面是否已执行动作，尤其是会提交数据的按钮。 |
| `CONTROL_COVERED` | 页面有其他元素遮住目标。检查弹窗或当前布局，再选择用户实际可操作的控件。 |

**Codex 沙箱中的链接读取。** 使用已安装技能中的固定脚本，将示例中的路径和网址替换为实际值。网址作为单独的字面参数传入。

```powershell
powershell.exe -NoProfile -File '本技能目录\scripts\read-url.ps1' 'https://example.com/article'
```

注册表、脚本或管道访问在沙箱里明确被拒时，为这条读取命令申请一次 `require_escalated`。审批通过后直接读取目标链接，`status` 留给只查连接的任务。若宿主或用户拒绝这次审批，报告该结果。`SITE_NOT_SHARED` 是 Chrome 的网站授权结果，应尊重弹窗中已有的选择。

失败回执的 `stage` 表示停在 `open`、`wait` 还是 `read`。已取得的标签 ID 会随错误返回。已打开的页面可以用这个 ID 继续等待或读取。若返回 `OUTCOME_UNKNOWN`，先按目标网址检查已有标签，核实上一步是否完成。

如需停用，在 Chrome 的扩展管理页停用或移除「Chrome 网页控制」即可断开。彻底卸载时，可一并移除上述名称的当前用户注册项和本机程序目录。

Chrome 的自动调试连接会在请求新的调试会话时询问用户。本扩展通过 Chrome 的可选网站权限保存选择。[DevTools 自动连接](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session) · [可选权限](https://developer.chrome.com/docs/extensions/reference/api/permissions) · [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
