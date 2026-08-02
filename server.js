// GadgetGuide backend
// Handles: auth (signup/login), consultation (LLM), recommendation matching,
// spend-limit check, order history, and the Prava checkout call.

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
require("dotenv").config();

const db = require("./db");
const { laptops, recommend, nextStepSmart, clarifyingQuestion, scoreLaptop } = require("./lib/agent");

const app = express();
app.set("trust proxy", true); // needed so req.protocol reports "https" correctly behind ngrok/reverse proxies
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    'publickey-credentials-get=(self "https://sandbox.collect.prava.space" "https://collect.prava.space"), publickey-credentials-create=(self "https://sandbox.collect.prava.space" "https://collect.prava.space")'
  );
  next();
});
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 days
  })
);
app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_SPEND_LIMIT = Number(process.env.SPEND_LIMIT || 60000);
const PRAVA_API_KEY = process.env.PRAVA_API_KEY;
const MOCK_MODE = !PRAVA_API_KEY || process.env.MOCK_MODE === "true"; // only affects the legacy /api/checkout fallback below

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "not_logged_in" });
  next();
}

// --- Signup ---
app.post("/api/signup", async (req, res) => {
  const { identifier, password, name } = req.body; // identifier = email or phone
  if (!identifier || !password) return res.status(400).json({ error: "missing_fields" });

  const existing = db.findUserByIdentifier(identifier);
  if (existing) return res.status(409).json({ error: "user_exists" });

  const isEmail = identifier.includes("@");
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    name: name || identifier.split("@")[0],
    email: isEmail ? identifier : null,
    phone: isEmail ? null : identifier,
    passwordHash: hash,
    spendLimit: DEFAULT_SPEND_LIMIT,
    orders: [],
    createdAt: new Date().toISOString(),
  };
  db.createUser(user);
  req.session.userId = user.id;
  res.json({ id: user.id, name: user.name, email: user.email, phone: user.phone });
});

// --- Login ---
app.post("/api/login", async (req, res) => {
  const { identifier, password } = req.body;
  const user = db.findUserByIdentifier(identifier);
  if (!user) return res.status(401).json({ error: "invalid_credentials" });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: "invalid_credentials" });

  req.session.userId = user.id;
  res.json({ id: user.id, name: user.name, email: user.email, phone: user.phone });
});

// --- Forgot password ---
// In a real product, this would email/SMS the reset link via a provider (SendGrid, Twilio, etc).
// For this prototype, the link is printed to the server's terminal instead of actually sent.
app.post("/api/forgot-password", (req, res) => {
  const { identifier } = req.body;
  const user = db.findUserByIdentifier(identifier);

  // Always respond the same way whether or not the user exists - avoids leaking which
  // emails/phones are registered (a real security consideration, not just decoration).
  if (!user) {
    return res.json({ message: "If an account exists for that email/phone, a reset link has been generated." });
  }

  const token = uuidv4();
  const expiresAt = Date.now() + 1000 * 60 * 30; // 30 min
  db.setResetToken(user.id, token, expiresAt);

  const resetLink = `http://localhost:${process.env.PORT || 3000}/reset-password.html?token=${token}`;
  console.log("\n=== PASSWORD RESET LINK (would normally be emailed/texted) ===");
  console.log(resetLink);
  console.log("================================================================\n");

  res.json({ message: "If an account exists for that email/phone, a reset link has been generated. (Check the server terminal for this demo.)" });
});

app.post("/api/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "missing_fields" });

  const user = db.findUserByResetToken(token);
  if (!user || !user.resetTokenExpiry || Date.now() > user.resetTokenExpiry) {
    return res.status(400).json({ error: "invalid_or_expired_token" });
  }

  const hash = await bcrypt.hash(password, 10);
  db.updatePassword(user.id, hash);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: "not_logged_in" });
  const user = db.findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: "not_logged_in" });
  res.json({ id: user.id, name: user.name, email: user.email, phone: user.phone, spendLimit: user.spendLimit ?? DEFAULT_SPEND_LIMIT });
});

// --- Profile: personal info edit ---
app.patch("/api/profile", requireAuth, (req, res) => {
  const { name, email, phone } = req.body;
  const updates = {};

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "invalid_name", message: "Name can't be empty." });
    updates.name = name.trim();
  }
  if (email !== undefined) {
    const trimmed = email.trim();
    if (trimmed) {
      const existing = db.findUserByIdentifier(trimmed);
      if (existing && existing.id !== req.session.userId) {
        return res.status(409).json({ error: "email_taken", message: "That email is already in use." });
      }
    }
    updates.email = trimmed || null;
  }
  if (phone !== undefined) {
    const trimmed = phone.trim();
    if (trimmed) {
      const existing = db.findUserByIdentifier(trimmed);
      if (existing && existing.id !== req.session.userId) {
        return res.status(409).json({ error: "phone_taken", message: "That phone number is already in use." });
      }
    }
    updates.phone = trimmed || null;
  }

  const user = db.updateUser(req.session.userId, updates);
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ id: user.id, name: user.name, email: user.email, phone: user.phone, spendLimit: user.spendLimit ?? DEFAULT_SPEND_LIMIT });
});

// --- Profile: everything the profile panel needs in one call ---
// (personal info, order summary + list, and a "recommended for you" pick
// based on the most recent conversation's prefs, if any exist)
app.get("/api/profile", requireAuth, (req, res) => {
  const user = db.findUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: "not_found" });

  const orders = db.getOrders(req.session.userId);
  const ordersTotal = orders.reduce((sum, o) => sum + (o.amount || 0), 0);

  const spendLimit = user.spendLimit ?? DEFAULT_SPEND_LIMIT;
  const latestPrefs = db.getLatestPrefs(req.session.userId);
  let recommendation = null;
  if (latestPrefs && (latestPrefs.budget || (latestPrefs.useCases || []).length > 0)) {
    const pick = recommend(latestPrefs);
    recommendation = { pick, overLimit: pick.price_inr > spendLimit, spendLimit };
  }

  res.json({
    user: { id: user.id, name: user.name, email: user.email, phone: user.phone, spendLimit, createdAt: user.createdAt },
    orders: { list: orders, count: orders.length, total: ordersTotal },
    recommendation,
  });
});

app.patch("/api/spend-limit", requireAuth, (req, res) => {
  const { spendLimit } = req.body;
  const parsed = Number(spendLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return res.status(400).json({ error: "invalid_amount", message: "Enter a spend limit greater than ₹0." });
  }
  db.updateUser(req.session.userId, { spendLimit: parsed });
  res.json({ spendLimit: parsed });
});

// --- Order history ---
app.get("/api/config", (req, res) => {
  const realPravaConfigured = !!(MERCHANT_SECRET_KEY && process.env.PRAVA_PUBLISHABLE_KEY);
  res.json({
    pravaConfigured: realPravaConfigured,
    publishableKey: realPravaConfigured ? process.env.PRAVA_PUBLISHABLE_KEY : null,
  });
});

// --- Conversations (chat history, shown in the sidebar) ---
app.get("/api/conversations", requireAuth, (req, res) => {
  res.json(db.getConversations(req.session.userId));
});

app.post("/api/conversations", requireAuth, (req, res) => {
  const convo = {
    id: uuidv4(),
    title: "New chat",
    messages: [],
    stage: "gathering",
    prefs: { useCases: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.createConversation(req.session.userId, convo);
  res.json(convo);
});

app.get("/api/conversations/:id", requireAuth, (req, res) => {
  const convo = db.getConversation(req.session.userId, req.params.id);
  if (!convo) return res.status(404).json({ error: "not_found" });
  res.json(convo);
});

app.patch("/api/conversations/:id", requireAuth, (req, res) => {
  const { messages, stage, prefs, title, titleLocked } = req.body;
  const updates = {};
  if (messages) updates.messages = messages;
  if (stage) updates.stage = stage;
  if (prefs) updates.prefs = prefs;
  if (title) updates.title = title;
  if (typeof titleLocked === "boolean") updates.titleLocked = titleLocked;
  const convo = db.updateConversation(req.session.userId, req.params.id, updates);
  if (!convo) return res.status(404).json({ error: "not_found" });
  res.json(convo);
});

app.delete("/api/conversations/:id", requireAuth, (req, res) => {
  db.deleteConversation(req.session.userId, req.params.id);
  res.json({ ok: true });
});

app.get("/api/saved-cards", requireAuth, (req, res) => {
  res.json(db.getSavedCards(req.session.userId));
});

app.delete("/api/saved-cards/:token", requireAuth, (req, res) => {
  db.removeSavedCard(req.session.userId, req.params.token);
  res.json({ ok: true });
});

app.get("/api/orders", requireAuth, (req, res) => {
  res.json(db.getOrders(req.session.userId));
});

// --- Consultation endpoint ---
// Uses Parth's understanding layer (Claude Haiku, falls back to rules with zero API
// key needed) + the real weighted scoring engine from lib/agent.js. `prefs` round-trips
// with the client/conversation the same way `stage` already did.
app.post("/api/chat", requireAuth, async (req, res) => {
  const { messages, prefs } = req.body;
  const latest = messages[messages.length - 1]?.content || "";

  const session = { prefs: prefs && prefs.useCases ? prefs : { useCases: [] } };
  const { prefs: updatedPrefs, missing } = await nextStepSmart(session, latest);

  if (missing.length > 0) {
    return res.json({
      role: "assistant",
      content: clarifyingQuestion(missing[0], updatedPrefs.unclearCount?.[missing[0]] || 0),
      stage: "gathering",
      prefs: updatedPrefs,
    });
  }

  const user = db.findUserById(req.session.userId);
  const spendLimit = user.spendLimit ?? DEFAULT_SPEND_LIMIT;
  const rec = recommend(updatedPrefs);
  const overLimit = rec.price_inr > spendLimit;

  res.json({
    role: "assistant",
    content: `RECOMMEND: ${rec.why}`,
    stage: "recommended",
    prefs: updatedPrefs,
    recommendation: rec,
    overLimit,
    spendLimit,
  });
});

// --- Recommendation matching (re-run for "show me something else / cheaper") ---
app.post("/api/recommend", requireAuth, (req, res) => {
  const { prefs, excludeId, budgetOverride } = req.body;
  const user = db.findUserById(req.session.userId);
  const spendLimit = user.spendLimit ?? DEFAULT_SPEND_LIMIT;

  const effectivePrefs = { ...(prefs || { useCases: [] }) };
  if (budgetOverride) effectivePrefs.budget = budgetOverride;

  const pool = excludeId ? laptops.filter((l) => l.id !== excludeId) : laptops;
  const ranked = pool
    .map((l) => ({ laptop: l, score: scoreLaptop(l, effectivePrefs) }))
    .sort((a, b) => b.score - a.score);
  const pick = ranked[0].laptop;

  res.json({ pick, overLimit: pick.price_inr > spendLimit, spendLimit });
});

// --- Checkout (requires login, so the order can be tied to a user's history) ---
app.post("/api/checkout", requireAuth, async (req, res) => {
  const { laptopId, approvedAmount } = req.body;
  const laptop = laptops.find((l) => l.id === laptopId);
  if (!laptop) return res.status(404).json({ error: "not_found" });

  const amount = approvedAmount || laptop.price_inr;
  const user = db.findUserById(req.session.userId);
  const spendLimit = user.spendLimit ?? DEFAULT_SPEND_LIMIT;

  if (amount > spendLimit && !approvedAmount) {
    return res.status(402).json({
      error: "over_limit",
      message: `This is ₹${amount - spendLimit} over your ₹${spendLimit} limit. Approve a higher one-time amount to continue.`,
      spendLimit,
      requested: amount,
    });
  }

  const orderBase = {
    id: uuidv4(),
    laptop: `${laptop.brand} ${laptop.model}`,
    merchant: laptop.merchant,
    amount,
    date: new Date().toISOString(),
  };

  if (!PRAVA_API_KEY || MOCK_MODE) {
    const order = { ...orderBase, status: "mock_success" };
    db.addOrder(req.session.userId, order);
    return res.json({
      status: "mock_success",
      message: `(Mock) Payment of ₹${amount} for ${laptop.brand} ${laptop.model} completed via Prava.`,
      merchant: laptop.merchant,
      laptop,
      order,
    });
  }

  try {
    // Replace with the real Prava request/response shape from https://docs.prava.space/
    const response = await fetch("https://api.prava.space/v1/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${PRAVA_API_KEY}` },
      body: JSON.stringify({ merchant: laptop.merchant, amount, currency: "INR", item: `${laptop.brand} ${laptop.model}` }),
    });
    const data = await response.json();
    const order = { ...orderBase, status: "success", pravaResponse: data };
    db.addOrder(req.session.userId, order);
    res.json({ status: "success", data, laptop, order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "checkout_failed" });
  }
});

// --- Prava: real session creation + payment-result polling ---
// Per Prava's SDK integration guide: session is created server-side (using the SECRET key),
// the frontend mounts a secure iframe for card entry + passkey approval, then the server
// polls for the resulting one-time payment credential (Visa network token + dynamic CVV).
const PRAVA_BACKEND_URL = process.env.PRAVA_BACKEND_URL || "https://api.prava.space";
const MERCHANT_SECRET_KEY = process.env.MERCHANT_SECRET_KEY;

app.post("/api/orders/record", requireAuth, (req, res) => {
  const { laptopId, amount, credential } = req.body;
  const laptop = laptops.find((l) => l.id === laptopId);
  if (!laptop) return res.status(404).json({ error: "not_found" });

  const order = {
    id: uuidv4(),
    laptop: `${laptop.brand} ${laptop.model}`,
    merchant: laptop.merchant,
    amount,
    date: new Date().toISOString(),
    status: "success",
    pravaCredential: credential ? { token: credential.token, expiryMonth: credential.expiry_month, expiryYear: credential.expiry_year } : null,
  };
  db.addOrder(req.session.userId, order);

  if (credential && credential.token) {
    db.upsertSavedCard(req.session.userId, {
      token: credential.token,
      last4: credential.token.slice(-4),
      expiryMonth: credential.expiry_month,
      expiryYear: credential.expiry_year,
      addedAt: new Date().toISOString(),
    });
  }

  res.json({ order });
});

app.post("/api/saved-cards/from-credential", requireAuth, (req, res) => {
  const { credential } = req.body;
  if (!credential || !credential.token) {
    return res.status(400).json({ error: "no_credential", message: "No card credential to save." });
  }
  db.upsertSavedCard(req.session.userId, {
    token: credential.token,
    last4: credential.token.slice(-4),
    expiryMonth: credential.expiry_month,
    expiryYear: credential.expiry_year,
    addedAt: new Date().toISOString(),
  });
  res.json({ ok: true });
});

app.post("/api/prava/create-session", requireAuth, async (req, res) => {
  if (!MERCHANT_SECRET_KEY || MERCHANT_SECRET_KEY.includes("YOUR_SECRET_KEY")) {
    return res.status(500).json({ error: "MERCHANT_SECRET_KEY not configured. Add it to .env." });
  }

  const { totalAmount, description, merchantName } = req.body;
  const user = db.findUserById(req.session.userId);
  const callbackUrl = `${req.protocol}://${req.get("host")}/checkout-callback.html`;

  try {
    const response = await fetch(`${PRAVA_BACKEND_URL}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MERCHANT_SECRET_KEY}` },
      body: JSON.stringify({
        user_id: user.id,
        user_email: user.email || `${user.phone}@gadgetguide.demo`,
        total_amount: String(totalAmount),
        currency: "INR",
        description: description || "GadgetGuide purchase",
        callback_url: callbackUrl,
        purchase_context: [
          {
            merchant_details: {
              name: "GadgetGuide",
              url: "https://gadgetguide.example.com",
              country_code_iso2: "IN",
              category_code: "5732",
              category: "Electronics",
            },
            product_details: [
              { description: description || "Laptop purchase", unit_price: String(totalAmount), quantity: 1 },
            ],
            effective_until_minutes: 15,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("[Prava] create-session rejected:", JSON.stringify(errorData, null, 2));
      return res.status(response.status).json({
        error: errorData.error?.message || `Prava API error (HTTP ${response.status})`,
        detail: errorData, // full raw response so we can see exactly which field is wrong
      });
    }
    res.json(await response.json());
  } catch (err) {
    console.error("[Prava] Failed to create session:", err);
    res.status(500).json({ error: "Failed to create Prava session" });
  }
});

app.get("/api/prava/payment-result/:sessionId", requireAuth, async (req, res) => {
  if (!MERCHANT_SECRET_KEY) return res.status(500).json({ error: "MERCHANT_SECRET_KEY not configured." });

  try {
    const response = await fetch(`${PRAVA_BACKEND_URL}/v1/sessions/${req.params.sessionId}/payment-result?_t=${Date.now()}`, {
      headers: { Authorization: `Bearer ${MERCHANT_SECRET_KEY}` },
    });

    if (!response.ok) {
      if (response.status === 404) return res.status(404).json({ error: "Session not found" });
      const errorData = await response.json().catch(() => ({}));
      console.error("[Prava] payment-result error:", JSON.stringify(errorData, null, 2));
      return res.status(response.status).json({ error: errorData.error?.message || `Prava API error (HTTP ${response.status})` });
    }
    const data = await response.json();
    console.log(`[Prava] payment-result for ${req.params.sessionId}:`, JSON.stringify(data, null, 2));
    res.json(data);
  } catch (err) {
    console.error("[Prava] Failed to get payment result:", err);
    res.status(500).json({ error: "Failed to get payment result" });
  }
});

app.get("/api/prava/health", async (_req, res) => {
  try {
    const response = await fetch(`${PRAVA_BACKEND_URL}/health`);
    res.json({ healthy: response.ok });
  } catch {
    res.json({ healthy: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GadgetGuide running on http://localhost:${PORT}`);
  console.log(
    process.env.ANTHROPIC_API_KEY
      ? "Chat: live (ANTHROPIC_API_KEY set)"
      : "Chat: mock/rule-based (no ANTHROPIC_API_KEY set)"
  );
  console.log(
    MERCHANT_SECRET_KEY && process.env.PRAVA_PUBLISHABLE_KEY
      ? "Prava checkout: live (real keys configured)"
      : "Prava checkout: mock (MERCHANT_SECRET_KEY / PRAVA_PUBLISHABLE_KEY not set)"
  );
});
