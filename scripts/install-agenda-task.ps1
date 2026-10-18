param([Parameter(Mandatory=$true)][string]$CredentialFile)
$ErrorActionPreference = 'Stop'
$CredentialFile = (Resolve-Path -LiteralPath $CredentialFile).Path
$config = Get-Content -LiteralPath $CredentialFile -Raw | ConvertFrom-Json
if ($CredentialFile -notlike 'D:\*' -or $config.dataDir -notlike 'D:\*') { throw 'Agenda storage must stay on D:' }
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$directory = Join-Path (Split-Path -Parent $config.dataDir) 'launcher'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$source = Join-Path $PSScriptRoot 'AgendaBackgroundTask.cs'
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.Substring(0,16)
$executable = Join-Path $directory "AgendaBackgroundTask-$hash.exe"
if (-not (Test-Path -LiteralPath $executable)) { Add-Type -Path $source -OutputAssembly $executable -OutputType WindowsApplication }
$logs = Join-Path (Split-Path -Parent $config.dataDir) 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$arguments = '"{0}" "{1}" "{2}"' -f (Join-Path $PSScriptRoot 'run-agenda.ps1'), $CredentialFile, $logs
$action = New-ScheduledTaskAction -Execute $executable -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'NEU-Schedule-Agenda-Runner' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
'Agenda image worker installed; polls once a minute while this user is logged in, stays quiet when idle.'
