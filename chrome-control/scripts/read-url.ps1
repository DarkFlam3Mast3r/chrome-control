# One background navigation and the reads for that document. The caller handles sandbox approval.
$ErrorActionPreference = 'Stop'
$chromeScript = Join-Path $PSScriptRoot 'chrome.ps1'
if ($args.Count -ne 1 -and ($args.Count -ne 3 -or $args[1] -ine '-WaitText' -or
    [string]::IsNullOrWhiteSpace($args[2]) -or $args[2].Length -gt 16000)) {
    Write-Output '{"ok":false,"error":"USAGE","detail":"read-url.ps1 URL [-WaitText TEXT]"}'
    exit 2
}
$address = $null
if (-not [Uri]::TryCreate($args[0], [UriKind]::Absolute, [ref]$address) -or $address.UserInfo -or
    $address.Scheme -notin @('http', 'https', 'file', 'chrome', 'chrome-extension', 'chrome-untrusted', 'about', 'blob', 'devtools', 'view-source') -or
    ($address.Scheme -eq 'file' -and $args[0] -notmatch '^file://') -or
    ($address.Scheme -in @('http', 'https') -and -not $address.Host)) {
    Write-Output '{"ok":false,"error":"WEB_URL_REQUIRED"}'
    exit 2
}

$jsonOptions = @{}
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $jsonOptions['DateKind'] = 'String' }

function Invoke-ChromeStep {
    $reply = & $chromeScript @args | ConvertFrom-Json @jsonOptions
    if ($null -eq $reply.ok) { throw 'NO_BRIDGE_RESULT' }
    if (-not $reply.ok) {
        $failure = [InvalidOperationException]::new($reply.error)
        if ($reply.detail) { $failure.Data['detail'] = $reply.detail }
        if ($reply.guide) { $failure.Data['guide'] = $reply.guide }
        throw $failure
    }
    return $reply.data
}

$stage = 'open'
$chromeTabId = $null
try {
    $opened = Invoke-ChromeStep open $args[0]
    $chromeTabId = $opened.tabId
    if ($opened.route -eq 'browser-ui') { throw 'BROWSER_UI_REQUIRED' }
    if (-not $opened.siteShared) { throw 'SITE_NOT_SHARED' }
    if ($null -eq $chromeTabId) { throw 'INVALID_TAB' }

    $stage = 'wait'
    $first = if ($args.Count -eq 3) { Invoke-ChromeStep read-start $chromeTabId $args[2] }
             else { Invoke-ChromeStep read-start $chromeTabId }
    if (-not $first.matched -or -not $first.documentId -or -not $first.url) { throw 'NO_PAGE_RESULT' }

    $stage = 'read'
    $body = [Text.StringBuilder]::new()
    $part = $first
    while ($true) {
        if ($part.documentId -cne $first.documentId -or $part.url -cne $first.url -or
            $part.snapshotId -cne $first.snapshotId) { throw 'PAGE_CHANGED' }
        if ($part.title -cne $first.title -or $part.total -ne $first.total -or $part.source -cne $first.source) {
            throw 'PAGE_CHANGED'
        }
        if ($part.offset -ne $body.Length -or $part.text -isnot [string] -or $null -eq $part.total) {
            throw 'INVALID_PAGE_RESULT'
        }
        [void]$body.Append($part.text)
        if ($null -eq $part.nextOffset) { break }
        if (-not $first.snapshotId -or $part.nextOffset -ne $body.Length -or
            $part.nextOffset -le $part.offset -or $part.nextOffset -ge $first.total) { throw 'INVALID_PAGE_RESULT' }
        $part = Invoke-ChromeStep read $chromeTabId $body.Length $first.documentId $first.snapshotId
    }
    if ($body.Length -ne $first.total) { throw 'INVALID_PAGE_RESULT' }
    if ($body.Length -eq 0) { throw 'NO_PAGE_TEXT' }

    $first.text = $body.ToString()
    $first.nextOffset = $null
    $first.PSObject.Properties.Remove('matched')
    $first.PSObject.Properties.Remove('snapshotId')
    Add-Member -InputObject $first -NotePropertyName tabId -NotePropertyValue $chromeTabId
    ConvertTo-Json -Compress -Depth 4 -InputObject @{ ok = $true; data = $first }
} catch {
    $failure = [ordered]@{ ok = $false; error = $_.Exception.Message; stage = $stage }
    if ($null -ne $chromeTabId) { $failure.tabId = $chromeTabId }
    if ($_.Exception.Data['detail']) { $failure.detail = $_.Exception.Data['detail'] }
    if ($_.Exception.Data['guide']) { $failure.guide = $_.Exception.Data['guide'] }
    ConvertTo-Json -Compress -Depth 5 -InputObject $failure
    exit 1
}
exit 0
