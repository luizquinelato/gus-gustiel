# Skill 03 — System Info

## 📋 User Guide

### What It Does

Reports which Jira environment Gustiel is connected to — **Sandbox** or **Production** — along with the site URL. Use this to confirm you are talking to the right instance before running reports.

### How to Trigger It

- *"What instance am I on?"*, *"Show system info"*, *"What environment is this?"*
- *"Which Jira is connected?"*, *"Are we on sandbox or production?"*

## 🔧 Technical Reference

> **Action:** `get-system-info` · **Resolver:** `system-resolver.js`

### How It Works

Gustiel calls `getEnvFromJira()` from `src/services/jira-api-service.js`. This checks the connected site URL against known patterns and selects the correct `ENV_CONFIG` entry from `src/config/constants.js`.

Because Forge is stateless, `getEnvFromJira()` is called independently in every resolver — it cannot be globally memoized. Each full ETL pipeline run makes 1–4 environment detection calls (one per step). Future optimization: cache result in Forge Storage with a short TTL.

### Custom Field IDs by Environment

Jira custom field IDs differ between sandbox and production. `ENV_CONFIG` maps each environment:

| Field | Sandbox ID | Production ID |
|---|---|---|
| Agile Team | `customfield_10700` | `customfield_10128` |
| QP Planning Sessions | `customfield_10613` | `customfield_10501` |
| Planned Start Date | `customfield_11321` | `customfield_12525` |

### See Also

- `src/config/constants.js` → `ENV_CONFIG`
- `src/services/jira-api-service.js` → `getEnvFromJira()`
