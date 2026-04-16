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

| Environment | Command |
|---|---|
| Development | `forge deploy --environment development` |
| Staging | `forge deploy --environment staging` |
| Production | `forge deploy --environment production` |

