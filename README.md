# Gustiel — The Portfolio Sentinel

> A Rovo AI Agent for Jira Portfolio Analysis, built on Atlassian Forge.

Gustiel crawls your Jira portfolio hierarchy (Objective → Initiative → Epic → Story) and delivers comprehensive reports either as a paginated chat conversation or as a fully formatted Confluence page — all through natural language in Rovo.

---

## Features

| Capability | Description |
|---|---|
| **Portfolio Report** | Full breakdown: summary, initiative table, epic status by team, story-level rollup |
| **Scope-Aware Export** | Confluence export works for Objective, Initiative, and Epic keys — each scope renders the relevant sections only |
| **Session-Based ETL** | Heavy Lead and Cycle Time data runs in two async steps (`prepare-portfolio-export` → `calculate-lead-time-data`) to avoid Forge timeout limits |
| **Innovation Velocity** | Average Epic lead time per team (first In Progress → Done); excludes KTLO epics and zero-duration epics |
| **Lead / Cycle Time** | Story-level LCT by issue type per team; cached in Forge Storage and reused across exports |
| **Confluence Export** | Single-call export to any space, folder, or page hierarchy; missing parent pages are auto-created |
| **Upsert Logic** | 3-tier logic: update in-place → move → create. A page with the same title is never duplicated |
| **Combined Export** | Pass multiple Jira keys; all reports are merged into one Confluence page with a divider between each |
| **Table of Contents** | Every exported page automatically gets a clickable TOC macro (H2 for single; H1+H2 for combined) |
| **Export Groups** | Agent groups objectives into export calls — combined = one call, split = one call per key — preventing duplicate-folder errors |
| **Multi-Objective** | Report on multiple Jira objectives in one request; each can target a different Confluence destination |
| **Portfolio Analysis** | Q&A / analytical questions about your portfolio data |
| **Dual-Environment** | Auto-detects Sandbox vs Production at runtime; separate custom field IDs per environment |

---

## Quick Start

### Prerequisites

- Node.js 22.x
- Forge CLI: `npm install -g @forge/cli`
- Logged in: `forge login`

### First-Time Setup

```powershell
npm install
forge register        # binds a new app ID in manifest.yml
.\deploy.ps1          # deploy + install on both Jira and Confluence
```

### Every Subsequent Deploy

```powershell
.\deploy.ps1
```

`deploy.ps1` handles the full pipeline: `forge deploy` → `forge install --upgrade` for Jira → `forge install --upgrade` for Confluence.

> **Note:** The script sets `NODE_TLS_REJECT_UNAUTHORIZED=0` to work around corporate SSL inspection. Remove that line if your network doesn't require it.

---

## Using Gustiel in Rovo

Start a conversation with Gustiel in Rovo and provide a Jira portfolio key (e.g. `WX-1145`).

### Chat mode (paginated)

```
You: Full report for WX-1145
Gustiel: How would you like this report? 1️⃣ Chat  2️⃣ Confluence
You: 1
Gustiel: [Summary + initiatives]
You: next
Gustiel: [Teams 1–4]  …  type "next" for more
```

### Confluence mode — split (one page per objective)

```
You: Full report for WX-1145 and WX-1770 in Confluence
Gustiel: Where should each report go?
         WX-1145: SPACE_KEY / optional/folder/path
         WX-1770: SPACE_KEY / optional/folder/path
You: WX-1145: GUSTIEL / Reports/2026
     WX-1770: GUSTIEL / Archive/2026
Gustiel: ⚠️ Ready to export 2 page(s)… [creates/updates pages]
Gustiel: ✅ Core Platform exported → https://…
         ✅ Consumer Portal exported → https://…
```

### Confluence mode — combined (all objectives in one page)

```
You: Combine WX-1145 and WX-1770 into one page under the Reports folder
Gustiel: ⚠️ Ready to export 1 page(s)… [creates combined page]
Gustiel: ✅ WX-1145 · WX-1770 exported → https://…
```

**Page title format:**
- Single (one key, one destination): `📊 [YYYY-MM-DD] Gustiel Portfolio Report by [user@email.com]`
- Individual reports sharing a folder: `📊 [YYYY-MM-DD] BEN-12399 by [user@email.com]` — the key (or objective name) is used as `titleSuffix` to prevent overwrites
- Combined (multiple keys merged): `📊 [YYYY-MM-DD] Gustiel Portfolio Report by [user@email.com]`

Date is formatted in the `REPORT_TIMEZONE` constant (`America/New_York` by default) to match the "Created at" timestamp.

Folder paths are created automatically if they don't exist. A page with the same title is updated in-place (never duplicated). Every page includes a clickable Table of Contents at the top.

---

## Architecture

Gustiel follows a strict **ETL (Extract → Transform → Load)** pattern. The resolver is only the entry/exit door — it never contains business logic.

```
src/
├── config/
│   └── constants.js                  # Versions, workflow dicts, field IDs
├── services/
│   ├── jira-api-service.js           # Raw Jira HTTP I/O only
│   └── confluence-api-service.js     # Confluence page CRUD + folder resolution
├── extractors/
│   └── jira-extractor.js             # Raw JSON → clean domain objects
├── transformers/
│   └── portfolio-transformer.js      # Pure calculations — no I/O, no rendering
├── formatters/
│   ├── markdown-formatter.js         # Domain data → Markdown (chat)
│   └── confluence-formatter.js       # Markdown → Confluence Storage Format (XHTML)
├── resolvers/
│   ├── portfolio-report-resolver.js  # Chat report (two-phase paginated)
│   ├── confluence-export-resolver.js # Confluence export (single or combined page)
│   ├── prepare-export-resolver.js    # ETL step 1: team discovery + layer extraction
│   ├── lead-time-resolver.js         # ETL step 2: LCT batched changelog query
│   ├── check-cache-resolver.js       # ETL cache state probe (scope-aware)
│   ├── portfolio-analysis-resolver.js
│   ├── system-resolver.js
│   └── creator-resolver.js
└── utils/
    └── token-estimator.js            # fitWithinBudget() — summary phase guard
```

See [`docs/architecture.md`](docs/architecture.md) for the full layer responsibility guide and data-flow diagrams.

---

## Pagination Model (Chat Mode)

Rovo's LLM output limit (~4K tokens per turn) makes it impossible to return all team data at once. Gustiel uses a **server-controlled two-phase model**:

- **Phase 1** (`teamPage = 0`): Summary + initiative table only.
- **Phase 2** (`teamPage ≥ 1`): One team per call. The server returns a `nextAction` field (`AUTO_CONTINUE` / `PAUSE` / `COMPLETE`) — the LLM never has to do pagination math.

`TEAMS_PER_BATCH = 4` — four teams auto-chain before a mandatory pause. Each team table is ~300–500 tokens; four teams stays safely under 4K.

---

## Confluence Scopes

The app requires these Confluence API scopes (declared in `manifest.yml`):

| Scope | Purpose |
|---|---|
| `write:page:confluence` | Create and update pages |
| `read:page:confluence` | Search for existing pages by title (upsert) |
| `read:space:confluence` | Look up space ID by key |

---

## Project Files

| File | Purpose |
|---|---|
| `manifest.yml` | App definition, actions, scopes |
| `deploy.ps1` | One-command deploy + upgrade for Jira and Confluence |
| `prompts/main_prompt.md` | Rovo Agent system prompt — all branching logic lives here |
| `docs/architecture.md` | ETL layer map, coding rules, pagination model |
| `docs/install-guide.md` | Step-by-step setup guide |
| `.gitignore` | Excludes `node_modules`, `.forge`, `.env`, logs |

---

## Version

Current version: **4.43.03** (defined in `src/config/constants.js`)

---

*Built by Gustavo Quinelato · Powered by Atlassian Forge + Rovo*

