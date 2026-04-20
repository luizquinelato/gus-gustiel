# Skill 03 — System Info

> **Access:** Everyone · **Action:** `get-system-info` · **Resolver:** `system-resolver.js`

---

## What It Does

Detects and reports which Jira environment Gustiel is connected to — **Sandbox** or **Production** — along with the site URL and the set of custom field IDs active for that environment.

This matters because Jira custom field IDs (Agile Team, QP Planning Sessions, Planned Start Date, End Date) differ between sandbox and production instances. Gustiel auto-detects the environment on every invocation.

---

## Trigger Phrases

- *"What instance am I on?"*, *"Show system info"*, *"What environment is this?"*
- *"Which Jira is connected?"*, *"Are we on sandbox or production?"*

---

## Technical Notes

- Detection uses `getEnvFromJira()` from `src/services/jira-api-service.js`.
- Logic: checks the connected site URL against known patterns to select the correct `ENV_CONFIG` entry from `src/config/constants.js`.
- `ENV_CONFIG` maps each environment to its field ID set:

| Field | Sandbox ID | Production ID |
|---|---|---|
| Agile Team | `customfield_10700` | `customfield_10128` |
| QP Planning Sessions | `customfield_10613` | `customfield_10501` |
| Planned Start Date | `customfield_11321` | `customfield_12525` |
| End Date (Epic) | `customfield_10700`* | `customfield_10700`* |

- `getEnvFromJira()` is called independently in every resolver — it cannot be globally memoized in Forge's stateless model. Each full ETL pipeline run therefore makes 1–4 separate environment detection calls (one per step). This is a known cost. Future optimization: cache result in Forge Storage with a short TTL.

---

## See Also

- `src/config/constants.js` → `ENV_CONFIG`
- `src/services/jira-api-service.js` → `getEnvFromJira()`
