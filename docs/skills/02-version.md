# Skill 02 — Agent Version

## 📋 User Guide

### What It Does

Returns the current deployed version of Gustiel (e.g. `4.52.2`). Use this to confirm which version is running, or to share the version when reporting an issue.

### How to Trigger It

- *"What is your version?"*, *"Which version are you?"*, *"What version is deployed?"*

## 🔧 Technical Reference

> **Action:** `get-agent-version` · **Resolver:** `system-resolver.js`

### Technical Notes

- Version is defined as `export const VERSION = "X.Y.Z"` in `src/config/constants.js`.
- Follows **Semantic Versioning (MAJOR.MINOR.PATCH)**:
  - `PATCH` — bug fixes, minor prompt tweaks
  - `MINOR` — new features, new skills, new actions (resets PATCH to 0)
  - `MAJOR` — architectural overhauls, breaking refactors (resets MINOR + PATCH to 0)
- The version must be bumped on every code change before deploying.

### See Also

- `.augment/rules/initial_instructions.md` → Versioning Rule
- `src/config/constants.js` → `VERSION` constant
