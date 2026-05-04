# Forge Deploy Script — Gustiel (Portfolio Sentinel)
#
# Usage:
#   .\deploy.ps1           → development  (agent name: [DEV] Gustiel)
#   .\deploy.ps1 --prod    → production   (agent name: Gustiel)
#   .\deploy.ps1 --all     → development + production (in that order)
#   .\deploy.ps1 --docs    → regenerate src/docs/index.js from docs/*.md, then deploy to dev
#   .\deploy.ps1 --docs --prod  → regenerate docs, then deploy to production
#   .\deploy.ps1 --docs --all   → regenerate docs, then deploy to dev + prod
#
# Confluence is upgraded BEFORE Jira (avoids the multi-product 'unexpected error'
# when a Confluence-only scope is added). Jira upgrade retries once on failure.
# manifest.yml dev-name patch is reverted after deploy by restoring the saved
# original bytes -- preserves any other uncommitted edits in the file.

$flagProd = $args -contains '--prod'
$flagAll  = $args -contains '--all'
$flagDocs = $args -contains '--docs'

# Reject unrecognised flags
$unknown = $args | Where-Object { $_ -notin '--prod', '--all', '--docs' }
if ($unknown) {
    Write-Host "ERROR: Unknown parameter(s): $($unknown -join ', ')" -ForegroundColor Red
    Write-Host "Usage: .\deploy.ps1 [--prod] [--all] [--docs]" -ForegroundColor Yellow
    Write-Host "  (no flag)  Deploy to development" -ForegroundColor DarkGray
    Write-Host "  --prod     Deploy to production" -ForegroundColor DarkGray
    Write-Host "  --all      Deploy to development then production" -ForegroundColor DarkGray
    Write-Host "  --docs     Regenerate src/docs/index.js from docs/*.md before deploying" -ForegroundColor DarkGray
    exit 1
}

# ── Docs bundling (--docs flag) ───────────────────────────────────────────────
if ($flagDocs) {
    Write-Host ""
    Write-Host ">> Bundling docs: node scripts/bundle-docs.mjs" -ForegroundColor Cyan
    node scripts/bundle-docs.mjs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAILED: docs bundle exited with code $LASTEXITCODE" -ForegroundColor Red
        exit 1
    }
}

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

    # Snapshot manifest.yml before any in-place edits so we can restore the
    # exact bytes in `finally` -- avoids `git checkout` wiping uncommitted edits.
    $manifestOriginal = Get-Content manifest.yml -Raw

    # Patch agent name in manifest for non-production deployments
    if (-not $isProd) {
        Write-Host "   Agent name: [DEV] Gustiel (Portfolio Sentinel)" -ForegroundColor Yellow
        ($manifestOriginal -replace 'name: Gustiel \(Portfolio Sentinel\)', 'name: "[DEV] Gustiel"') `
            | Set-Content manifest.yml -NoNewline
    }

    try {
        # Deploy
        forge deploy --environment $ForgeEnv --non-interactive
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAILED: Deploy exited with code $LASTEXITCODE" -ForegroundColor Red
            return
        }
        Write-Host "OK: Deploy complete" -ForegroundColor Green

        # Install or upgrade Confluence FIRST.
        # When a Confluence-only scope is added, upgrading Jira first triggers a
        # generic 'An unexpected error occurred' until Confluence has accepted
        # the new scope state. Confluence-first avoids that.
        Write-Host ">> Installing/upgrading Confluence..." -ForegroundColor Cyan
        forge install --upgrade --site $SITE --environment $ForgeEnv --product Confluence --confirm-scopes --non-interactive
        if ($LASTEXITCODE -ne 0) {
            Write-Host "   No existing install found -- running fresh install for Confluence..." -ForegroundColor Yellow
            forge install --site $SITE --environment $ForgeEnv --product Confluence --confirm-scopes --non-interactive
            if ($LASTEXITCODE -ne 0) {
                Write-Host "WARN: Confluence install exited $LASTEXITCODE -- run 'forge install' manually if needed." -ForegroundColor Yellow
            }
        }

        # Install or upgrade Jira (retry once: scope state may still be syncing).
        Write-Host ">> Installing/upgrading Jira..." -ForegroundColor Cyan
        forge install --upgrade --site $SITE --environment $ForgeEnv --product Jira --confirm-scopes --non-interactive
        if ($LASTEXITCODE -ne 0) {
            Write-Host "   Jira upgrade failed -- retrying once after Confluence sync..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
            forge install --upgrade --site $SITE --environment $ForgeEnv --product Jira --confirm-scopes --non-interactive
            if ($LASTEXITCODE -ne 0) {
                Write-Host "WARN: Jira upgrade still failing -- run 'forge install --upgrade -p Jira' manually." -ForegroundColor Yellow
            }
        }

        Write-Host "OK: $label fully deployed and upgraded!" -ForegroundColor Green
    }
    finally {
        # Restore the exact manifest bytes captured at the start of this deploy.
        # Preserves any uncommitted edits that were on disk before we patched
        # the agent name. Runs even if forge crashes mid-deploy.
        Set-Content -Path manifest.yml -Value $manifestOriginal -NoNewline
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

