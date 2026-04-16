---
type: "manual"
---

# Agent Rules — Gustiel (The Portfolio Sentinel)

Rules the agent must follow in every session for this project.

---

## Versioning Rule

The app version is defined in `src/config/constants.js` as `export const VERSION = "X.Y.Z"`.

Use **Semantic Versioning (MAJOR.MINOR.PATCH)**:

| Part | When to increment | Examples |
|------|------------------|---------|
| `PATCH` (last) | Bug fixes, typo corrections, minor prompt tweaks | `1.0.0` → `1.0.1` |
| `MINOR` (middle) | New features of small or medium size (new action, new skill, new field) | `1.0.1` → `1.1.0` |
| `MAJOR` (first) | Big architectural changes, major new capability, breaking refactor | `1.1.0` → `2.0.0` |

**Rules:**
- Always update the version in `src/config/constants.js` when delivering a code change.
- When incrementing `MINOR`, reset `PATCH` to `0`.
- When incrementing `MAJOR`, reset `MINOR` and `PATCH` to `0`.
- Never update the version without also deploying or explicitly noting the bump in the response.

---

## ETL Architecture Rule

The codebase follows a strict **ETL (Extract → Transform → Load)** pattern.
Full details are in `doc/architecture.md`. This rule summarises what the agent must enforce.

### Layer ownership — never cross these boundaries

| Layer | Folder | Rule |
|---|---|---|
| **Extract** | `src/extractors/` | Maps raw Jira JSON → domain objects. No I/O beyond receiving raw data. |
| **Transform** | `src/transformers/` | Pure calculations and data shaping only. No I/O, no Markdown, no rendering. |
| **Load** | `src/formatters/` | Converts domain data → Markdown output. No I/O, no calculation. |
| **Orchestrate** | `src/resolvers/` | Entry/exit only. Calls Extract → Transform → Load. Contains **no business logic**. |
| **I/O** | `src/services/` | The only layer allowed to call the Jira API. |
| **Config** | `src/config/constants.js` | Workflow dicts, field IDs, version. No logic. |

### Rules for every new feature

1. **New data from Jira** → add a function to `src/extractors/`.
2. **New calculation or grouping** → add a function to `src/transformers/`.
3. **New output section or table** → add a function to `src/formatters/`.
4. **New Rovo action** → add a thin resolver in `src/resolvers/` that calls the three layers. No logic inside the resolver.
5. **New workflow status** → edit `src/config/constants.js` only. No resolver changes needed.
6. **Never duplicate logic** — if a second resolver needs the same extraction, transformation, or formatting function, it imports from the existing layer file. Do not copy-paste.
7. **All extractor, transformer, and formatter functions must be pure** (stateless, no side effects) so they are safe under any concurrency level and fully testable in isolation.

