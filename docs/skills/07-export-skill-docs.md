# Skill 07 — Export Skill Documentation

> **Access:** Everyone · **Action:** `export-skill-docs` · **Resolver:** `skill-docs-resolver.js`

---

## What It Does

Exports a comprehensive, formatted Confluence page documenting all Gustiel skills, trigger phrases, access levels, the ETL pipeline, supported Jira hierarchy levels, and the session cache model. Ideal for onboarding teammates or creating a formal reference.

---

## Trigger Phrases

- *"Export skill documentation"*, *"Create a Gustiel user guide in Confluence"*
- *"Document all Gustiel skills to Confluence"*, *"Export the help to Confluence"*
- *"Export Gustiel docs"*

---

## Delivery Path

Three-step interaction:

1. **Ask for Confluence space** — *"Which Confluence space should the skill guide go to?"*
2. **Ask for placement** — under a page hierarchy path, inside an existing folder (URL/ID), or at space root
3. **Call `export-skill-docs`** with `spaceKey` + one placement param (`parentPath`, `folderId`, or none)

---

## Response

On `SUCCESS`:
> *"✅ Gustiel Skill Reference [action] to Confluence.*
> *📄 [pageTitle] → [pageUrl]"*

Where `[action]` is `"moved and updated"`, `"updated"`, or `"exported"` depending on whether the page already existed.

---

## Technical Notes

- Uses `buildCustomTable(headers, rows, colspans)` from `src/formatters/confluence-formatter.js` for the ETL pipeline and hierarchy tables — required because those tables have unequal column widths not expressible in standard Markdown pipe tables.
- Same upsert/folder/path logic as `confluence-export-resolver.js` (find by title → update → move → create).
- No Jira ETL pipeline involved — this skill is documentation-only. No session, no cache.

---

## See Also

- `docs/architecture.md` → ETL layer map (what this skill documents)
- `src/resolvers/skill-docs-resolver.js`
- `src/formatters/confluence-formatter.js` → `buildCustomTable`
