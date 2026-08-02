# GadgetGuide (prototype)

AI agent that consults on a laptop purchase, recommends a model, checks it against a spend limit, and completes the purchase via Prava.

## Run it

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:3000

## Modes

- **Mock mode (default, no keys needed):** if `OPENAI_API_KEY` is empty, the chat uses a small scripted flow (2 turns, then a recommendation) so you can test and demo the full UI/flow without any API keys. Checkout also mocks a successful Prava payment.
- **Live mode:** add your `OPENAI_API_KEY` in `.env` to get real LLM-driven conversation. Add `PRAVA_API_KEY` and wire the real request/response shape from https://docs.prava.space/ into the `/api/checkout` route in `server.js` (currently has a placeholder call you'll need to adjust to match Prava's actual API).

## Real Prava integration (not mocked anymore)

This now uses **Prava's actual SDK flow**, not a guessed API shape:

1. Sign up at **dashboard.prava.space** to get your `sk_test_...` (secret) and `pk_test_...` (publishable) keys
2. Add them to `.env`:
   ```
   MERCHANT_SECRET_KEY=sk_test_...
   PRAVA_PUBLISHABLE_KEY=pk_test_...
   ```
3. Restart the server — it auto-detects real keys and switches out of mock mode for checkout (chat can stay in mock mode independently if you haven't added an OpenAI key)

**How the real flow works:** when you click "Yes, buy this," the server creates a Prava session, the frontend mounts Prava's secure card-entry iframe (real card number, expiry, CVV — use Prava's sandbox test card, ask their team for one), you approve with a passkey (Face ID/Touch ID — needs HTTPS or `localhost`), and the server then polls Prava for a one-time payment credential (a Visa network token + dynamic CVV) which gets saved to your order history. This credential is what a real merchant integration would charge against — this prototype stops at "credential obtained," since wiring an actual merchant's checkout API is a separate integration per merchant.

**Note:** passkeys require either `https://` or `localhost` — won't work if you access the app via a plain IP address or non-secure custom domain.

## Full-screen layout + chat history

The app is now full-screen with a sidebar, like Claude/ChatGPT:
- **Sidebar** — lists all your past conversations, click to reopen any of them, "+ New chat" starts a fresh one, ✕ deletes one
- **Persisted per user** — conversations save to your account (in `db.json`, same as orders) after every message exchange, so they survive refreshes and logins
- **Note on scope:** reopening an old conversation replays it as plain text — the interactive "buy this" cards only render live in the conversation you're actively chatting in. This keeps things simple and is a normal, expected scope cut for a hackathon demo.

## Spend limit (editable) + other polish

- **Click the "limit ₹..." pill** in the top bar to open a small modal and change your spend limit anytime — it's stored per-user and takes effect immediately on your next recommendation/checkout.
- **Typing indicator** — animated dots show while the agent is "thinking," instead of the chat looking frozen.
- **Input locks while waiting** — can't double-send a message while a response is in flight.
- **Cmd/Ctrl+K** — keyboard shortcut for starting a new chat.
- **Order history now shows a total** — order count + total spent at the top, not just a bare list.
- **Auto-focus** — the message box focuses automatically after login, sending a message, or switching chats, so you can just keep typing.
- **Responsive sidebar** — collapses automatically on narrow/mobile screens instead of eating the whole view.
- Fixed a background-image bug where custom backgrounds tiled into a grid instead of covering the screen, and fixed the sidebar picking up a grey tint when a background was active.

## What's real vs. mocked in this prototype

- **Real:** chat UI, conversation flow, spend-limit check logic, checkout flow structure, passkey-approval UX simulation, **user signup/login (email or phone + password, hashed with bcrypt), sessions, and order history saved per-user**
- **Mocked for demo reliability:** laptop pricing data (`data/laptops.json` — real prices as of when this was written, not live), Prava payment call (until real credentials are wired in)

## New features

- **Login/signup** at `/login.html` — supports email or phone number + password. You must be logged in to check out (`/api/checkout` is auth-gated), and each purchase is saved to that user's order history.
- **Order history** — click "Orders" in the top bar to see everything you've bought, tied to your account.
- **Themes** — pick from Developer, 90s, or Bright, each with a light and dark mode (6 combinations total). Saved in your browser via localStorage, so it persists between visits.
- **Custom background** — upload any image from your device as the app's background via the "Custom background" button. Also saved locally in your browser.

## Forgot password

Click "Forgot password?" on the login page and enter your email/phone. **In this prototype, the reset link is printed to your server's terminal window** instead of actually being emailed/texted — look for a block that says `=== PASSWORD RESET LINK ===` right after you submit. Copy that link into your browser to set a new password. In a real product, this would go through an email provider (like SendGrid) or SMS provider (like Twilio) instead.

## Data storage

Everything is stored in a simple `db.json` file (created automatically on first run) — no external database setup needed. This is fine for a hackathon/demo scale. Note: `db.json` and `.env` are excluded from the zip/repo on purpose since they'd contain real user data and secrets — they get created/filled in fresh when you run it.

## Project structure

```
gadgetguide/
├── server.js          # API routes: /api/chat, /api/recommend, /api/checkout
├── data/laptops.json  # mock catalog used for recommendations
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js          # chat UI + recommendation card + checkout flow
├── .env.example
└── package.json
```

## Next steps to make this "real"

1. Wire real Prava credentials + correct API call shape in `server.js` `/api/checkout`
2. Replace the mock laptop catalog with a live price-lookup (API or scraper) for at least one merchant
3. Add proper structured extraction of budget/priority from the LLM response instead of the simple regex heuristic in `app.js`
4. Add a second gadget category to show extensibility
