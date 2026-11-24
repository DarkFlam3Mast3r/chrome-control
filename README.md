# Chrome Control

让 Codex 在 Windows 上操作你已登录的 Chrome。给它一个链接，它会在后台打开，等正文出现后读完整篇文章，保留你正在使用的标签页。它也能在已授权的网页上选句、点击按钮、填写表单，以及截取当前标签的可见区域。

## 首次安装

如果已经把技能装进 Codex，直接说「用 $chrome-control 带我安装 Chrome 扩展」。它会给出本机扩展的完整路径，带你在 Chrome 中加载，并检查连接。也可以在技能目录运行 `scripts\chrome.ps1 guide` 查看同一份引导。

1. 从本仓库的 **Code → Download ZIP** 下载并解压，找到与 `tests` 同级的 `chrome-control` 文件夹。把整个文件夹复制到 `%USERPROFILE%\.codex\skills\`。如果设置了 `CODEX_HOME`，复制到该目录下的 `skills\`。
2. 在 PowerShell 中运行下面的命令，注册当前 Windows 用户的本机程序。首次安装需要 Windows 自带的 .NET Framework 和桌面版 Google Chrome。

   ```powershell
   $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
   $skill = Join-Path $codexDir 'skills\chrome-control'
   & (Join-Path $skill 'scripts\setup.ps1')
   ```

3. 在要使用的 Chrome 配置中打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择刚复制的 **`chrome-control\extension`** 文件夹。打开一个普通网页，在扩展弹窗点「允许此网站」，或勾选「默认允许所有网站」并确认。

## 验证第一次后台阅读

在同一个 PowerShell 窗口运行以下两条命令。若选择了逐站授权，使用刚才已允许的网站地址。

```powershell
& (Join-Path $skill 'scripts\chrome.ps1') status
& (Join-Path $skill 'scripts\read-url.ps1') 'https://example.com/'
```

第一条应返回 `connected: true` 和扩展版本。第二条返回的 `data.text` 是正文，`data.url` 是实际网址。在 Codex 里也可以直接说「用 $chrome-control 后台读这个链接，告诉我最后一段讲了什么」。

## 从旧版更新

用新版 `chrome-control` 文件夹中的内容覆盖原安装目录，运行 `scripts\setup.ps1 -UpdateOnly`，然后在 `chrome://extensions` 刷新一次「Chrome 网页控制」。原有网站选择会保留。安装位置、逐站授权、错误码和卸载步骤见[安装与连接](chrome-control/references/setup.md)。
