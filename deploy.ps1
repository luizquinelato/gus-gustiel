# Forge Deploy Script with SSL Certificate Bypass
# This script sets the NODE_TLS_REJECT_UNAUTHORIZED environment variable
# to bypass SSL certificate validation issues on corporate networks

Write-Host "🚀 Starting Forge deployment..." -ForegroundColor Cyan
Write-Host "⚠️  Bypassing SSL certificate validation for this session" -ForegroundColor Yellow

# Set environment variable to bypass SSL certificate validation
$env:NODE_TLS_REJECT_UNAUTHORIZED = "0"

$SITE = "wexinc-sandbox-new.atlassian.net"
$ENV  = "development"

# Run forge deploy
forge deploy --environment $ENV --non-interactive

# Check if deployment was successful
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Deployment failed with exit code: $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "✅ Deployment completed successfully!" -ForegroundColor Green

# Upgrade all product installations so new scopes take effect
Write-Host "🔄 Upgrading Jira installation..." -ForegroundColor Cyan
forge install --upgrade --site $SITE --environment $ENV --product Jira --confirm-scopes --non-interactive

Write-Host "🔄 Upgrading Confluence installation..." -ForegroundColor Cyan
forge install --upgrade --site $SITE --environment $ENV --product Confluence --confirm-scopes --non-interactive

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ All installations upgraded!" -ForegroundColor Green
} else {
    Write-Host "⚠️  Upgrade step failed (exit code: $LASTEXITCODE). Run 'forge install --upgrade' manually if needed." -ForegroundColor Yellow
}

