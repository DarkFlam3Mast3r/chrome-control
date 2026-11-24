# UTF-8 JSON preserves empty fields, embedded quotes and multiline text in
# both Windows PowerShell and PowerShell 7.
$ErrorActionPreference = 'Stop'
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
    Write-Output '{"ok":false,"error":"HOST_NOT_INSTALLED"}'
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
    Write-Output $output.TrimEnd()
    $code = $process.ExitCode
} finally { $process.Dispose() }
exit $code
