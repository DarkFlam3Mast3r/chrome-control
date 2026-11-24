# UTF-8 JSON preserves empty fields, embedded quotes and multiline text in
# both Windows PowerShell and PowerShell 7.
$ErrorActionPreference = 'Stop'

function Get-SetupGuide([string] $reason) {
    $extension = Join-Path (Split-Path -Parent $PSScriptRoot) 'extension'
    $bundled = [IO.File]::Exists((Join-Path $extension 'manifest.json'))
    $setup = Join-Path $PSScriptRoot 'setup.ps1'
    $steps = @()
    if (-not $bundled) {
        $steps += '请从仓库复制整个 chrome-control 文件夹。扩展的 extension 文件夹应与 scripts 同级。'
    } elseif ($reason -eq 'EXTENSION_RELOAD_REQUIRED') {
        $steps += '在 chrome://extensions 找到「Chrome 网页控制」，点扩展卡片上的刷新按钮。'
    } else {
        if ($reason -eq 'BRIDGE_OFFLINE') {
            $steps += '打开要使用的 Chrome 配置。如果已经装有「Chrome 网页控制」，在扩展弹窗点「重新连接」。若列表里没有它，按下面的步骤加载。'
        } else {
            $steps += "首次安装时，用 PowerShell 运行当前用户的本机安装脚本 $setup"
        }
        $steps += '在要使用的 Chrome 配置中打开 chrome://extensions，开启右上角的「开发者模式」。'
        $steps += "点「加载已解压的扩展程序」，在文件夹选择框中粘贴这个完整路径并确认：$extension"
        $steps += '首次加载后即可定位标签、读取普通网页。要排除个别网站，在该网站打开扩展弹窗。'
    }
    if ($bundled) { $steps += '回到本地助手说「装好了」，让它检查连接并继续刚才的任务。手工验证可运行状态脚本并传入 status。' }
    return [ordered]@{ extensionDir = $extension; bundled = $bundled; extensionsPage = 'chrome://extensions'
        setupScript = $setup; statusScript = (Join-Path $PSScriptRoot 'chrome.ps1'); steps = $steps }
}

if ($args.Count -eq 1 -and $args[0] -eq 'guide') {
    ConvertTo-Json -Compress -Depth 4 -InputObject @{ ok = $true; data = (Get-SetupGuide 'guide') }
    exit 0
}

$regPath = 'HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\local.codex.chrome_control'
try {
    $manifest = [Microsoft.Win32.Registry]::GetValue($regPath, '', $null)
} catch {
    $cause = $_.Exception.GetBaseException()
    if ($cause -isnot [System.Security.SecurityException] -and $cause -isnot [System.UnauthorizedAccessException]) { throw }
    Write-Output '{"ok":false,"error":"REGISTRY_ACCESS_DENIED"}'
    exit 1
}
if (-not $manifest -or -not [IO.File]::Exists($manifest)) {
    ConvertTo-Json -Compress -Depth 4 -InputObject @{
        ok = $false; error = 'HOST_NOT_INSTALLED'; guide = (Get-SetupGuide 'HOST_NOT_INSTALLED') }
    exit 1
}
$config = [IO.File]::ReadAllText($manifest) | ConvertFrom-Json
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $config.path
$start.WorkingDirectory = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.Path
$start.Arguments = '--args-json'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.StandardOutputEncoding = [Text.Encoding]::UTF8
$process = [Diagnostics.Process]::Start($start)
try {
    $payload = ConvertTo-Json -Compress -InputObject ([string[]]$args)
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.Close()
    $output = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    $code = $process.ExitCode
    if ($code -ne 0 -and $output.TrimStart().StartsWith('{')) {
        $reply = $output | ConvertFrom-Json
        if ($reply.error -in @('BRIDGE_OFFLINE', 'EXTENSION_RELOAD_REQUIRED')) {
            Add-Member -InputObject $reply -NotePropertyName guide -NotePropertyValue (Get-SetupGuide $reply.error)
            $output = ConvertTo-Json -Compress -Depth 4 -InputObject $reply
        }
    }
    Write-Output $output.TrimEnd()
} finally { $process.Dispose() }
exit $code
