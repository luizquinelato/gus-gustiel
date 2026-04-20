# Forge Deploy Script — Gustiel (Portfolio Sentinel)
#
# Usage:
#   .\deploy.ps1           → development  (agent name: [DEV] Gustiel)
#   .\deploy.ps1 --prod    → production   (agent name: Gustiel)
#   .\deploy.ps1 --all     → development + production (in that order)
#
# Both Jira and Confluence are upgraded on every run.
# manifest.yml is always restored after deploy (git checkout), even on failure.

$flagProd = $args -contains '--prod'
$flagAll  = $args -contains '--all'

$SITE = "wexinc-sandbox-new.atlassian.net"
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"

function Deploy-Forge {
    param([string]$ForgeEnv)

    $isProd = $ForgeEnv -eq "production"
    $label  = if ($isProd) { "PRODUCTION" } else { "DEVELOPMENT" }
    $bar    = [string]::new([char]0x2500, 48)

    Write-Host ""
    Write-Host $bar -ForegroundColor DarkGray
    Write-Host ">> Deploying: $label" -ForegroundColor Cyan

    # Patch agent name in manifest for non-production deployments
    if (-not $isProd) {
        Write-Host "   Agent name: [DEV] Gustiel (Portfolio Sentinel)" -ForegroundColor Yellow
        (Get-Content manifest.yml) `
            -replace 'name: Gustiel \(Portfolio Sentinel\)', 'name: "[DEV] Gustiel"' `
            | Set-Content manifest.yml
    }

    try {
        # Deploy
        forge deploy --environment $ForgeEnv --non-interactive
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAILED: Deploy exited with code $LASTEXITCODE" -ForegroundColor Red
            return
        }
        Write-Host "OK: Deploy complete" -ForegroundColor Green

        # Upgrade Jira
        Write-Host ">> Upgrading Jira..." -ForegroundColor Cyan
        forge install --upgrade --site $SITE --environment $ForgeEnv --product Jira --confirm-scopes --non-interactive
        if ($LASTEXITCODE -ne 0) {
            Write-Host "WARN: Jira upgrade exited $LASTEXITCODE -- run 'forge install --upgrade' manually if needed." -ForegroundColor Yellow
        }

        # Upgrade Confluence
        Write-Host ">> Upgrading Confluence..." -ForegroundColor Cyan
        forge install --upgrade --site $SITE --environment $ForgeEnv --product Confluence --confirm-scopes --non-interactive
        if ($LASTEXITCODE -ne 0) {
            Write-Host "WARN: Confluence upgrade exited $LASTEXITCODE -- run 'forge install --upgrade' manually if needed." -ForegroundColor Yellow
        }

        Write-Host "OK: $label fully deployed and upgraded!" -ForegroundColor Green
    }
    finally {
        # Always restore manifest.yml -- runs even if forge crashes mid-deploy
        git checkout manifest.yml 2>$null
        if (-not $isProd) {
            Write-Host "   manifest.yml restored" -ForegroundColor DarkGray
        }
    }
}

# Routing
if ($flagAll) {
    Deploy-Forge "development"
    Deploy-Forge "production"
} elseif ($flagProd) {
    Deploy-Forge "production"
} else {
    Deploy-Forge "development"
}

$bar = [string]::new([char]0x2500, 48)
Write-Host ""
Write-Host $bar -ForegroundColor DarkGray
Write-Host "Done." -ForegroundColor Cyan

