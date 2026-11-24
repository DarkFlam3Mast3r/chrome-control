# One background navigation and the reads for that document. The caller handles sandbox approval.
$ErrorActionPreference = 'Stop'
$chromeScript = Join-Path $PSScriptRoot 'chrome.ps1'
if ($args.Count -ne 1) {
    Write-Output '{"ok":false,"error":"USAGE","detail":"read-url.ps1 URL"}'
    exit 2
}
$address = $null
if (-not [Uri]::TryCreate($args[0], [UriKind]::Absolute, [ref]$address) -or
    $address.Scheme -notin @('http', 'https') -or -not $address.Host -or $address.UserInfo) {
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
        throw $failure
    }
    return $reply.data
}

$stage = 'open'
$chromeTabId = $null
try {
    $opened = Invoke-ChromeStep open $args[0]
    $chromeTabId = $opened.tabId
    if (-not $opened.siteShared) { throw 'SITE_NOT_SHARED' }
    if ($null -eq $chromeTabId) { throw 'INVALID_TAB' }

    $stage = 'wait'
    $ready = Invoke-ChromeStep wait $chromeTabId ready
    if (-not $ready.matched -or -not $ready.documentId -or -not $ready.url) { throw 'NO_PAGE_RESULT' }

    $stage = 'read'
    $first = $null
    $body = [Text.StringBuilder]::new()
    do {
        $part = Invoke-ChromeStep read $chromeTabId $body.Length $ready.documentId
        if ($part.documentId -cne $ready.documentId -or $part.url -cne $ready.url) { throw 'PAGE_CHANGED' }
        if ($null -eq $first) { $first = $part }
        if ($part.title -cne $first.title -or $part.total -ne $first.total -or $part.source -cne $first.source) {
            throw 'PAGE_CHANGED'
        }
        if ($part.offset -ne $body.Length -or $part.text -isnot [string] -or $null -eq $part.total) {
            throw 'INVALID_PAGE_RESULT'
        }
        [void]$body.Append($part.text)
        if ($null -ne $part.nextOffset -and ($part.nextOffset -ne $body.Length -or
            $part.nextOffset -le $part.offset -or $part.nextOffset -ge $first.total)) { throw 'INVALID_PAGE_RESULT' }
    } while ($null -ne $part.nextOffset)
    if ($body.Length -ne $first.total) { throw 'INVALID_PAGE_RESULT' }
    if ($body.Length -eq 0) { throw 'NO_PAGE_TEXT' }

    $first.text = $body.ToString()
    $first.nextOffset = $null
    Add-Member -InputObject $first -NotePropertyName tabId -NotePropertyValue $chromeTabId
    ConvertTo-Json -Compress -Depth 4 -InputObject @{ ok = $true; data = $first }
} catch {
    $failure = [ordered]@{ ok = $false; error = $_.Exception.Message; stage = $stage }
    if ($null -ne $chromeTabId) { $failure.tabId = $chromeTabId }
    if ($_.Exception.Data['detail']) { $failure.detail = $_.Exception.Data['detail'] }
    ConvertTo-Json -Compress -InputObject $failure
    exit 1
}
exit 0
