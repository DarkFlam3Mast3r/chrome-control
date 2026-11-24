# Chrome Control

让本地 Agent 在 Windows 上操作已登录的 Chrome。给它一个链接，它会在后台打开并读取正文，保留你正在使用的标签页。它也能在已授权的网页上选句、点击按钮、填写表单或截图。普通读写使用随包扩展和本机程序，Chrome 远程调试和 9222 端口可以关闭。

## 选择安装位置

下载本仓库并解压，复制与 `tests` 同级的整个 `chrome-control` 文件夹。

| 使用环境 | 放置位置与要求 |
| --- | --- |
| Codex | 个人目录 `%USERPROFILE%\.codex\skills\chrome-control`。设置了 `CODEX_HOME` 时使用该目录下的 `skills\chrome-control`。 |
| DeepSeek Harness（DSH） | 个人目录 `%USERPROFILE%\.dsh\skills\chrome-control`，或 `%DSH_HOME%\skills\chrome-control`。项目内可放在 `.dsh\skills\chrome-control`。Windows 会话需提供本机 `pwsh` 执行工具。[DSH 技能目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md) · [DSH PowerShell 工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/tool-pwsh/README.md) |
| 其他本地助手或命令行 | 放在固定目录，用同一 Windows 用户的 PowerShell 执行脚本，按 JSON 回执继续操作。支持 `SKILL.md` 的客户端还可加载技能说明。 |

当前本机程序面向 Windows 桌面版 Chrome。纯云端聊天或另一台机器上的 shell 需要能在这台 Windows 电脑执行命令的连接。组织策略也可能限制加载已解压扩展、运行 PowerShell 或 Native Messaging。

## 首次安装

如果已经把技能装进 Codex，直接说「用 $chrome-control 带我安装 Chrome 扩展」。它会给出本机扩展的完整路径，带你在 Chrome 中加载，并检查连接。也可以在技能目录运行 `scripts\chrome.ps1 guide` 查看同一份引导。

1. 用 PowerShell 进入刚复制的 `chrome-control` 文件夹，确认当前目录能看到 `SKILL.md`、`scripts` 和 `extension`。
2. 运行下面的命令，注册当前 Windows 用户的本机程序。首次安装使用 Windows 自带的 .NET Framework。

   ```powershell
   $skill = (Get-Location).Path
   & (Join-Path $skill 'scripts\setup.ps1')
   ```

3. 在要使用的 Chrome 配置中打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择刚复制的 **`chrome-control\extension`** 文件夹。如果 Chrome 显示权限确认，按提示完成。新安装默认允许普通网站并支持按标题或网址定位标签。想排除某个网站时，在该网站打开弹窗，关闭「当前网站」。

## 验证第一次后台阅读

在同一个 PowerShell 窗口运行以下两条命令。若选择了逐站授权，使用刚才已允许的网站地址。

```powershell
& (Join-Path $skill 'scripts\chrome.ps1') status
& (Join-Path $skill 'scripts\read-url.ps1') 'https://example.com/'
```

第一条应返回 `connected: true` 和扩展版本。第二条返回的 `data.text` 是正文，`data.url` 是实际网址。在 Codex 里也可以直接说「用 $chrome-control 后台读这个链接，告诉我最后一段讲了什么」。

在 DSH 中可以说「使用 chrome-control 技能，检查 Chrome 连接，然后后台读这个链接」。每次 PowerShell 调用可用技能目录的绝对路径。同一台机器已注册且使用同一 Chrome 配置时，多个助手可以复用这套安装。

## 本地文件、PDF 和内置页面

本地 HTML 在 Chrome 中打开后，即可按标题或网址定位。如果第一次读文件时 Chrome 限制访问，在该文件标签的弹窗点「扩展详情」，开启「允许访问文件网址」一次。PDF、其他扩展阅读器和 Chrome 设置页也可直接定位。读取 PDF 正文或操作特殊界面时，取决于助手已接入的 PDF、DevTools 或桌面工具。[特殊标签与远程调试](chrome-control/references/tab-types.md)

## 从旧版更新

用新版 `chrome-control` 文件夹中的内容覆盖原安装目录，运行 `scripts\setup.ps1 -UpdateOnly`，然后在 `chrome://extensions` 刷新「Chrome 网页控制」。若 Chrome 提示权限有变化，确认后启用扩展。原有的网站模式和排除项会保留。安装位置、逐站授权、错误码和卸载步骤见[安装与连接](chrome-control/references/setup.md)。
