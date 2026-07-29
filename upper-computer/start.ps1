param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

$serverRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$listenAddress = [System.Net.IPAddress]::Parse("127.0.0.1")
$port = 8765
$listener = [System.Net.Sockets.TcpListener]::new($listenAddress, $port)
$contentTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "text/javascript; charset=utf-8"
    ".mjs"  = "text/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
}

function Send-Response {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$StatusCode,
        [string]$StatusText,
        [byte[]]$Body,
        [string]$ContentType = "text/plain; charset=utf-8"
    )
    $header = "HTTP/1.1 $StatusCode $StatusText`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
}

try {
    $listener.Start()
    $url = "http://127.0.0.1:$port/"
    Write-Host "MaixCAM Pro upper computer is running: $url"
    Write-Host "Press Ctrl+C to stop."
    if (-not $NoBrowser) {
        Start-Process $url
    }

    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            while (($line = $reader.ReadLine()) -ne $null -and $line.Length -gt 0) { }

            if (-not $requestLine -or $requestLine -notmatch "^GET\s+([^\s]+)\s+HTTP/") {
                Send-Response $stream 405 "Method Not Allowed" ([System.Text.Encoding]::UTF8.GetBytes("Only GET is supported."))
                continue
            }

            $requestPath = [System.Uri]::UnescapeDataString(($Matches[1] -split "\?", 2)[0])
            if ($requestPath -eq "/") { $requestPath = "/index.html" }
            $relativePath = $requestPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
            $filePath = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($serverRoot, $relativePath))
            $insideRoot = $filePath.StartsWith($serverRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)

            if (-not $insideRoot -or -not [System.IO.File]::Exists($filePath)) {
                Send-Response $stream 404 "Not Found" ([System.Text.Encoding]::UTF8.GetBytes("Not found."))
                continue
            }

            $extension = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
            $contentType = if ($contentTypes.ContainsKey($extension)) { $contentTypes[$extension] } else { "application/octet-stream" }
            Send-Response $stream 200 "OK" ([System.IO.File]::ReadAllBytes($filePath)) $contentType
        }
        catch {
            Write-Warning $_.Exception.Message
        }
        finally {
            $client.Dispose()
        }
    }
}
finally {
    $listener.Stop()
}
