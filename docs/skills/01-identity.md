# Skill 01 — Identity & Creator Card

## 📋 User Guide

### What It Does

Gustiel introduces itself when you ask. Say "Who are you?" to see Gustiel's full identity card — name, role, a summary of its capabilities, and a photo. Say "Who created you?" or "Who built you?" to see the creator's profile.

Both questions trigger the same response.

### How to Trigger It

| Intent | Example phrases |
|---|---|
| Identity | *"Who are you?"*, *"What are you?"*, *"Tell me about yourself"*, *"Introduce yourself"* |
| Creator | *"Who created you?"*, *"Who built you?"*, *"Show creator info"* |

### What You'll See

An identity card with Gustiel's avatar, its role description, a list of what it can do, and the creator's name, email, and photo — all in a single response.

## 🔧 Technical Reference

> **Action:** `get-agent-info` · **Resolver:** `creator-resolver.js`

### How It Works

No ETL pipeline. This resolver returns static data from the `GUSTIEL_CARD` constant in `src/resolvers/creator-resolver.js`.

The card includes two image URL fields:
- `avatarImageUrl` — Gustiel's avatar, rendered at the top of the identity card
- `builtByImageUrl` — creator's photo, rendered on the Built by line

Both images are rendered via the prompt template (`prompts/main_prompt.md`) using `![alt](url)` syntax — not returned from action data. Rovo's CSP blocks images returned in action payloads but renders images the LLM outputs as conversational text. See the **Image Rendering in Rovo Chat** section in `docs/architecture.md`.

### Technical Notes

- Image URLs must be updated in `GUSTIEL_CARD` only — never hardcoded in the prompt template.
- The agent avatar in the Rovo UI bubble is configured separately via `manifest.yml` (`icon: resource:agent-assets;icons/avatar.png`).

### See Also

- `docs/architecture.md` → Image Rendering in Rovo Chat section
- `src/resolvers/creator-resolver.js` → `GUSTIEL_CARD` constant
