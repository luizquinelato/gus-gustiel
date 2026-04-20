# Skill 01 — Identity & Creator Card

> **Access:** Everyone · **Action:** `get-agent-info` · **Resolver:** `creator-resolver.js`

---

## What It Does

Returns Gustiel's static identity card: name, title, description, top-level skill list, avatar image, and creator information. Both "who are you?" and "who built you?" trigger the same card.

---

## Trigger Phrases

| Intent | Example phrases |
|---|---|
| Identity | *"Who are you?"*, *"What are you?"*, *"Tell me about yourself"*, *"Introduce yourself"* |
| Creator | *"Who created you?"*, *"Who built you?"*, *"Show creator info"* |

---

## Response

The LLM renders the card using a fixed template from `prompts/main_prompt.md`:

```
![Gustiel]({agent.avatarImageUrl})
## 🤖 {agent.name} — {agent.title}
_{agent.description}_

**What I can do:**
- {agent.skills[0..3]}

**Built by:** {agent.builtBy} · {agent.builtByEmail} · ![creator]({agent.builtByImageUrl})
```

Both image URLs (`avatarImageUrl`, `builtByImageUrl`) are rendered inline because they are embedded in the prompt template — not returned from action data. See the **Image Rendering** section in `docs/architecture.md` for why this distinction matters.

---

## Technical Notes

- **No ETL pipeline.** This resolver is purely static data.
- All card content lives in `GUSTIEL_CARD` inside `src/resolvers/creator-resolver.js`.
- Image URLs must be updated there — never hardcoded in the prompt template.
- The agent avatar shown in the Rovo UI bubble is set separately via `manifest.yml` (`icon: resource:agent-assets;icons/avatar.png`).

---

## See Also

- `docs/architecture.md` → **Image Rendering in Rovo Chat** section
- `src/resolvers/creator-resolver.js` → `GUSTIEL_CARD` constant
