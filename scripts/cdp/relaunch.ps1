# Build Swarmplay and start it from source with the DevTools Protocol on port 9333,
# for the checks in this folder. Stops any running Swarmplay first, the installed
# app included, since both use the same database. App output goes to logs\.
$repo = Resolve-Path "$PSScriptRoot\..\.."
$logs = New-Item -ItemType Directory -Force "$PSScriptRoot\logs"
Set-Location $repo
Get-Process Swarmplay, electron, mpv -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
$build = cmd /c "npm run build 2>&1"
if ($LASTEXITCODE -ne 0) { "BUILD FAILED"; $build | Select-Object -Last 20; exit 1 }
Start-Process -FilePath "node_modules\electron\dist\electron.exe" -ArgumentList ".", "--remote-debugging-port=9333" `
  -RedirectStandardOutput "$logs\app.log" -RedirectStandardError "$logs\app.err.log" -WindowStyle Normal
for ($i = 0; $i -lt 40; $i++) {
  try {
    $j = Invoke-RestMethod http://127.0.0.1:9333/json -TimeoutSec 2
    if ($j | Where-Object { $_.type -eq 'page' }) { Start-Sleep 2; "READY"; exit 0 }
  } catch {}
  Start-Sleep -Milliseconds 500
}
"NO CDP"; exit 1
