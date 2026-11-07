# Build Swarmplay and start it from source with the DevTools Protocol on port 9333,
# for the checks in this folder. It runs on its own test profile (database, settings
# and library folder in $env:SWARMPLAY_PROFILE, by default "ZZ Swarmplay test" in
# %LOCALAPPDATA%), so the installed app and its library are never touched and can
# stay open. Stops only an earlier run from this repo and its mpv. App output goes to logs\.
$repo = Resolve-Path "$PSScriptRoot\..\.."
$logs = New-Item -ItemType Directory -Force "$PSScriptRoot\logs"
Set-Location $repo
if (-not $env:SWARMPLAY_PROFILE) { $env:SWARMPLAY_PROFILE = Join-Path $env:LOCALAPPDATA 'ZZ Swarmplay test' }
$electron = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$dev = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -eq $electron })
$ids = @($dev | ForEach-Object { $_.ProcessId })
Get-CimInstance Win32_Process -Filter "Name='mpv.exe'" | Where-Object { $ids -contains $_.ParentProcessId } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
$build = cmd /c "npm run build 2>&1"
if ($LASTEXITCODE -ne 0) { "BUILD FAILED"; $build | Select-Object -Last 20; exit 1 }
Start-Process -FilePath $electron -ArgumentList ".", "--remote-debugging-port=9333" `
  -RedirectStandardOutput "$logs\app.log" -RedirectStandardError "$logs\app.err.log" -WindowStyle Normal
for ($i = 0; $i -lt 40; $i++) {
  try {
    $j = Invoke-RestMethod http://127.0.0.1:9333/json -TimeoutSec 2
    if ($j | Where-Object { $_.type -eq 'page' }) { Start-Sleep 2; "READY on profile $env:SWARMPLAY_PROFILE"; exit 0 }
  } catch {}
  Start-Sleep -Milliseconds 500
}
"NO CDP"; exit 1
