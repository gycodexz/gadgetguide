# Merge notes (read this first)

This folder merges both of your branches into one runnable app:

- **Base:** your build — auth (signup/login/sessions), `db.json` persistence,
  saved conversations, order history, real Prava SDK wiring, themes/UI.
- **Swapped in from Parth's build:** `lib/agent.js` + `lib/llm.js` (the real
  scoring engine + Claude-based understanding layer, with automatic rule-based
  fallback if there's no API key) now power `/api/chat` and `/api/recommend`,
  replacing the old one-tag budget filter.
- **Dataset:** switched to Parth's richer `data/laptops.json` schema
  (`price_inr`, `tags`, `ram_gb`, `weight_kg`, `battery_hrs`, `why`) — this is
  the file Parth should keep expanding with real data.
- **Dropped:** the OpenAI (`gpt-4o`) chat path. There's now one LLM call in
  the whole app (Claude Haiku, in `lib/llm.js`), not two different providers
  for two different features. Update `.env` accordingly — `ANTHROPIC_API_KEY`
  replaces `OPENAI_API_KEY`.

## What to check first when you run it

1. `npm install`, `cp .env.example .env`, `npm start` — should run with **zero
   keys** (rule-based understanding + mock Prava), same as before.
2. Have a full conversation (e.g. "laptop for college, mostly coding, ~65k")
   and confirm it recommends a laptop from the new dataset and shows a
   "why" line under the specs.
3. Run Parth's regression suite after any data/rule change:
   ```
   node test/eval.js
   node test/eval-llm.js   # needs ANTHROPIC_API_KEY
   ```
4. Once you've got real Prava keys, test one live checkout end-to-end.

## Known rough edges (worth a look before the demo)

- "Show a cheaper option" re-runs the scorer with `budgetOverride` but doesn't
  re-run the Claude/rule extraction — it's a lightweight re-rank, not a new
  understanding step. Fine for a demo, worth knowing.
- Reopening an old saved conversation still replays as plain text only (the
  interactive recommendation card doesn't re-render) — this was already a
  documented scope cut in your original README, unchanged here.
- `db.json`/`.env` are still gitignored on purpose — don't commit them.
