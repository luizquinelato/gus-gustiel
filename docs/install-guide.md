# Install Guide — Gustiel (The Portfolio Sentinel)

## Prerequisites

- Node.js 22.x
- Forge CLI installed globally: `npm install -g @forge/cli`
- Logged in to Forge: `forge login`

---

## First-Time Setup

### 1. Install dependencies
```
npm install
```

### 2. Register the app with Atlassian
```
forge register
```
This replaces the placeholder app ID in `manifest.yml` with a real one.

### 3. Deploy to development
```
.\deploy.ps1
```
Or manually:
```
forge deploy --environment development
```

### 4. Install on your Jira site
```
forge install
```
Select your Jira site when prompted.

---

## Subsequent Deploys

After any code change, just run:
```
.\deploy.ps1
```

No need to re-register or re-install unless the app ID changes.

---

## Environments

Two environments exist: **development** and **production**. There is no staging environment.

| Environment | Agent name shown in Rovo | Manual command |
|---|---|---|
| Development | `[DEV] Gustiel` | `forge deploy --environment development` |
| Production | `Gustiel (Portfolio Sentinel)` | `forge deploy --environment production` |

---

## deploy.ps1 — Modes

`deploy.ps1` is the standard deployment script. It handles manifest patching, deployment, and install/upgrade automatically.

| Command | What it does |
|---|---|
| `.\deploy.ps1` | Deploy to **development only**. Patches manifest to rename agent to `[DEV] Gustiel` before deploy; restores `manifest.yml` via `git checkout` in a `finally` block (runs even if Forge crashes). |
| `.\deploy.ps1 --prod` | Deploy to **production only**. Manifest is untouched — agent deploys as `Gustiel (Portfolio Sentinel)`. |
| `.\deploy.ps1 --all` | Deploy to **development first, then production** in sequence. |

After each deploy, the script runs `forge install --upgrade` for both Jira and Confluence on the target site (`wexinc-sandbox-new.atlassian.net`). If no existing install is found, it falls back to a fresh install automatically.

