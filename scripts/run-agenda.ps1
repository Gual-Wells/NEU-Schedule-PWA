param([Parameter(Mandatory=$true)][string]$CredentialFile)
$ErrorActionPreference = 'Stop'
$mutex = New-Object System.Threading.Mutex($false, 'Local\NEU-Schedule-Agenda-Runner')
$owned = $false
try {
    $owned = $mutex.WaitOne(0)
    if (-not $owned) { exit 0 }
    $config = Get-Content -LiteralPath $CredentialFile -Raw | ConvertFrom-Json
    $env:TEMP = 'D:\CodexStorage\tmp'
    $env:TMP = $env:TEMP
    New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
    & $config.nodePath (Join-Path $PSScriptRoot 'agenda-runner.mjs') $CredentialFile
    if ($LASTEXITCODE -ne 0) { throw "Agenda runner exited $LASTEXITCODE" }
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
