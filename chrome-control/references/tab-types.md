# 特殊标签与远程调试

安装后可直接按完整标题或网址定位已打开的标签。同名目标按网址或窗口区分。静默定位保留当前标签。Chrome 扩展返回的标签 ID 只用于本机脚本。

| 目标或回执 | 操作 |
| --- | --- |
| `page` | 使用该 ID 调用 `read-start`、`controls` 和其他网页操作。 |
| `file-permission` | Chrome 限制了本地文件的正文访问。在目标文件标签的弹窗点「扩展详情」，或从 Chrome 管理扩展进入「Chrome 网页控制」，开启「允许访问文件网址」一次，再按原标签 ID 操作。[Chrome 文件访问权限](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#allow-access) |
| `pdf-candidate` | 网址以 .pdf 结尾。先核实内容；HTML 阅读器可以沿用网页操作。收到 `PDF_VIEWER_REQUIRED` 时使用下面的 PDF 流程。 |
| `browser-ui` | 常见于 Chrome 设置、扩展管理页、应用商店、其他扩展阅读器和内置新标签页。检查已获授权的 DevTools 会话能否看到指定目标；也可使用已连接的桌面界面。 |
| `select-or-share` / `site-permission` / `excluded` | 依现有网站选择操作。仅当前标签可用时，保持用户指定的前后台位置。尊重网站排除、文件访问关闭、隐身和浏览器权限对话框。 |

## 阅读 PDF 或操作阅读器

用户要文档正文时，可用能访问该指定文件的 PDF 工具提取文字并核对页码。远程 PDF 需要登录时优先使用已登录标签里的阅读器。用户要翻页、查找、朗读或暂停时，检查目标阅读器实际提供的控件，通过页码、选区或播放状态核对结果。若只读到可见页，说明已读的页码范围。

## 复用 Chrome DevTools 会话

普通网页和已授权的本地 HTML 走扩展与本机程序，远程调试可以关闭。需要 DevTools 时，优先使用助手**已配置、已获用户授权**的 Chrome DevTools MCP 会话。开启 `chrome://inspect/#remote-debugging` 只开启 Chrome 这一端，助手还需要相应的客户端。用户明确选择连接到现有 Chrome 时，官方客户端支持 `--autoConnect`，新会话由 Chrome 请求确认。[Chrome 官方连接说明](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)

1. 用 `list_pages` 与目标网址、标题匹配，记录该会话返回的 `pageId`。以实际列出的目标为准。
2. 需要选择目标时用 `select_page` 并指定 `bringToFront: false`。在同一会话对该页获取快照、操作控件、再核实结果。工具支持直接传 `pageId` 时可直接指定。静默新开普通网页可用 `new_page` 的 `background: true`。具体参数以已安装工具为准。[官方工具参考](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
3. PDF 查看器、其他扩展或 Chrome 内置页的目标可见性取决于客户端和浏览器。只有工具实际返回的正文、控件和状态能作为操作依据。需要前台才能继续时，用户已指定前台操作即可选中该标签；静默任务先说明需要切换，再由用户决定。对话框、地址栏等浏览器界面使用助手提供的桌面操作工具。缺少相应工具时，报告能定位到哪个标签、哪一步需要用户在 Chrome 完成。
