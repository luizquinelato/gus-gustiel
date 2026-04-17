# Forge Storage Inspector
# Wraps 'forge storage list' and 'forge storage get' with SSL bypass and environment defaults.
#
# Usage:
#   .\storage.ps1 list
#   .\storage.ps1 get "export_session:accountId:WX-1145"
#   .\storage.ps1 get "gustiel_admin_registry"

param(
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet("list", "get")]
    [string]$Command,

    [Parameter(Position = 1)]
    [string]$Key = ""
)

$ENV_NAME = "development"

# Bypass SSL (same as deploy.ps1)
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"
Write-Host "⚠️  Bypassing SSL certificate validation for this session" -ForegroundColor Yellow

switch ($Command.ToLower()) {

    "list" {
        Write-Host ""
        Write-Host "📋 Listing all Forge storage keys (environment: $ENV_NAME)..." -ForegroundColor Cyan
        Write-Host ""
        forge storage list --environment $ENV_NAME
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "❌ 'forge storage list' failed (exit code $LASTEXITCODE)." -ForegroundColor Red
            exit $LASTEXITCODE
        }
    }

    "get" {
        if (-not $Key) {
            Write-Host ""
            Write-Host "❌ A key is required for the 'get' command." -ForegroundColor Red
            Write-Host "   Usage: .\storage.ps1 get `"<storageKey>`"" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "   Common keys:" -ForegroundColor DarkGray
            Write-Host "     gustiel_admin_registry" -ForegroundColor DarkGray
            Write-Host "     export_session:<accountId>:<portfolioKey>" -ForegroundColor DarkGray
            exit 1
        }

        Write-Host ""
        Write-Host "🔍 Reading key: $Key" -ForegroundColor Cyan
        Write-Host ""
        forge storage get $Key --environment $ENV_NAME
        if ($LASTEXITCODE -ne 0) {
            Write-Host ""
            Write-Host "❌ 'forge storage get' failed (exit code $LASTEXITCODE)." -ForegroundColor Red
            Write-Host "   The key may not exist. Run '.\storage.ps1 list' to see all keys." -ForegroundColor Yellow
            exit $LASTEXITCODE
        }
    }
}

Write-Host ""
Write-Host "✅ Done." -ForegroundColor Green
