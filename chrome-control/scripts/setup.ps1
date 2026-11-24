[CmdletBinding()]
param(
    [string] $OutputDirectory = (Join-Path $env:LOCALAPPDATA 'CodexChromeControl'),
    [switch] $BuildOnly,
    [switch] $UpdateOnly
)
$ErrorActionPreference = 'Stop'
$sources = @((Join-Path $PSScriptRoot 'ChromeControl.cs'), (Join-Path $PSScriptRoot 'PngFiles.cs'))
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashes = foreach ($source in $sources) { [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($source))) }
    $digest = $sha.ComputeHash([Text.Encoding]::ASCII.GetBytes(($hashes -join '|')))
    $hash = [BitConverter]::ToString($digest, 0, 8).Replace('-', '').ToLowerInvariant()
} finally { $sha.Dispose() }
$target = [IO.Path]::GetFullPath($OutputDirectory)
$name = 'local.codex.chrome_control'
$manifest = Join-Path $target "$name.json"
$registryPath = "HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\$name"
$registered = [Microsoft.Win32.Registry]::GetValue($registryPath, '', $null)
if ($UpdateOnly -and $registered -ne $manifest) { throw 'No matching native host registration to update.' }
[IO.Directory]::CreateDirectory($target) | Out-Null
$mode = if ($BuildOnly) { 'test-' } else { '' }
$binary = Join-Path $target ("chrome-control-$mode$hash.exe")
if (-not [IO.File]::Exists($binary)) {
    $framework = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
    $compiler = @((Join-Path $framework 'csc.exe'),
        "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
        "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe") |
        Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1
    if (-not $compiler) { throw 'Microsoft .NET Framework C# compiler was not found.' }
    $temporary = Join-Path $target ([guid]::NewGuid().ToString('N') + '.exe')
    try {
        $flags = @('/nologo', '/optimize+', '/target:exe', '/reference:System.Web.Extensions.dll', '/reference:System.Drawing.dll', "/out:$temporary")
        if ($BuildOnly) { $flags += '/define:TEST_BRIDGE' }
        & $compiler @flags @sources
        if ($LASTEXITCODE -ne 0) { throw 'Native host compilation failed.' }
        [IO.File]::Move($temporary, $binary)
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}
if ($BuildOnly) { Write-Output $binary; return }

$config = [ordered]@{
    name = $name
    description = 'Codex Chrome Control for the current Windows user'
    path = $binary
    type = 'stdio'
    allowed_origins = @('chrome-extension://bijbehalbilfcmgoedjidbgmjjanokah/')
}
$stage = Join-Path $target ([guid]::NewGuid().ToString('N') + '.json')
try {
    [IO.File]::WriteAllText($stage, ($config | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($manifest)) {
        [IO.File]::Replace($stage, $manifest, [NullString]::Value)
    } else {
        [IO.File]::Move($stage, $manifest)
    }
} finally {
    if ([IO.File]::Exists($stage)) { [IO.File]::Delete($stage) }
}
if ($registered -ne $manifest) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Google\Chrome\NativeMessagingHosts\$name")
    try { $key.SetValue('', $manifest, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Close() }
}
Write-Output ("Native host ready: " + $manifest)
