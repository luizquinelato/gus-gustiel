# Skill 02 — Agent Version

> **Access:** Everyone · **Action:** `get-agent-version` · **Resolver:** `system-resolver.js`

---

## What It Does

Returns the current deployed version of the Gustiel app (e.g. `4.47.3`). Use this to confirm which version is running in a given environment (development vs production).

---

## Trigger Phrases

- *"What is your version?"*, *"Which version are you?"*, *"What version is deployed?"*

---

## Technical Notes

- Version is defined as `export const VERSION = "X.Y.Z"` in `src/config/constants.js`.
- Follows **Semantic Versioning (MAJOR.MINOR.PATCH)**:
  - `PATCH` — bug fixes, minor prompt tweaks
  - `MINOR` — new features, new skills, new actions (resets PATCH to 0)
  - `MAJOR` — architectural overhauls, breaking refactors (resets MINOR + PATCH to 0)
- The version **must be bumped** on every code change before deploying. See the Versioning Rule in `.augment/rules/initial_instructions.md`.

---

## See Also

- `.augment/rules/initial_instructions.md` → Versioning Rule
- `src/config/constants.js` → `VERSION` constant
