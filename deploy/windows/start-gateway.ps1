# Starts the OpenGrokBot gateway on Windows. install-task.ps1 registers a task that runs this when you
# sign in; you can also run it by hand from PowerShell.
#
# Put your model key in a user environment variable once (only your account can read it):
#   setx OPENGROKBOT_API_KEY "sk-..."
# and build first:  pnpm install; pnpm build
$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repo

if (-not $env:OPENGROKBOT_MODEL) { $env:OPENGROKBOT_MODEL = 'grok-4.7' }
# The log is a file: keep the gateway token out of it. Sign in with the token in gateway\data\auth-token.
$env:OPENGROKBOT_QUIET_TOKEN = '1'

$logDir = Join-Path $env:LOCALAPPDATA 'OpenGrokBot'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'gateway.log'

$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path 'gateway\dist\main.js')) { throw "gateway\dist\main.js is missing: run 'pnpm install' and 'pnpm build' in $repo first." }

"[$(Get-Date -Format s)] starting the gateway from $repo" | Add-Content -Path $log
& $node 'gateway\dist\main.js' *>> $log
exit $LASTEXITCODE
