import { PravaSDK } from "./vendor/prava-sdk.js";

const chatEl = document.getElementById("chat");
const ordersPanel = document.getElementById("ordersPanel");
const pravaContainer = document.getElementById("pravaContainer");
const form = document.getElementById("composer");
const input = document.getElementById("input");

let history = [];
let userText = "";
let stage = "gathering";
let prefs = { useCases: [] };
let pravaConfig = { pravaConfigured: false, publishableKey: null };
let currentConversationId = null;
let currentTitleLocked = false;

fetch("/api/config").then((r) => r.json()).then((cfg) => { pravaConfig = cfg; });

// --- Sidebar toggle (collapse on small screens / manual toggle) ---
const sidebar = document.getElementById("sidebar");
document.getElementById("sidebarToggle").onclick = () => sidebar.classList.toggle("collapsed");
if (window.innerWidth <= 760) sidebar.classList.add("collapsed");

// --- Conversation list / sidebar ---
const convoList = document.getElementById("convoList");

async function loadConvoList(activeId) {
  const res = await fetch("/api/conversations");
  const convos = await res.json();
  convoList.innerHTML = convos
    .map(
      (c) => `
      <div class="convo-item ${c.id === activeId ? "active" : ""}" data-id="${c.id}">
        <span class="convo-title" data-id="${c.id}">${c.title || "New chat"}</span>
        <span class="convo-actions">
          <button class="rename-btn" data-id="${c.id}" title="Rename">✎</button>
          <button class="del-btn" data-id="${c.id}" title="Delete">✕</button>
        </span>
      </div>`
    )
    .join("") || `<div class="msg system-note">No chats yet</div>`;

  convoList.querySelectorAll(".convo-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("del-btn") || e.target.classList.contains("rename-btn")) return;
      loadConversation(el.dataset.id);
    });
  });
  convoList.querySelectorAll(".del-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetch(`/api/conversations/${btn.dataset.id}`, { method: "DELETE" });
      if (btn.dataset.id === currentConversationId) {
        startNewConversation();
      } else {
        loadConvoList(currentConversationId);
      }
    });
  });
  convoList.querySelectorAll(".rename-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const titleEl = convoList.querySelector(`.convo-title[data-id="${btn.dataset.id}"]`);
      const currentTitle = titleEl.textContent;
      const input = document.createElement("input");
      input.className = "convo-rename-input";
      input.value = currentTitle;
      titleEl.replaceWith(input);
      input.focus();
      input.select();

      const commit = async () => {
        const newTitle = input.value.trim() || currentTitle;
        await fetch(`/api/conversations/${btn.dataset.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: newTitle, titleLocked: true }),
        });
        if (btn.dataset.id === currentConversationId) currentTitleLocked = true;
        loadConvoList(currentConversationId);
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") input.blur();
        if (ev.key === "Escape") { input.value = currentTitle; input.blur(); }
      });
    });
  });
}

async function loadConversation(id) {
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) return;
  const convo = await res.json();

  currentConversationId = convo.id;
  currentTitleLocked = !!convo.titleLocked;
  history = convo.messages || [];
  stage = convo.stage || "gathering";
  prefs = convo.prefs || { useCases: [] };
  userText = history.filter((m) => m.role === "user").map((m) => m.content).join(" ");

  chatEl.innerHTML = "";
  ordersPanel.style.display = "none";
  chatEl.style.display = "flex";
  pravaContainer.style.display = "none";

  if (history.length === 0) {
    addMsg("assistant", "Hey — tell me what gadget you need and what you'll mainly use it for. I'll find the right one and can complete the purchase for you.");
  } else {
    history.forEach((m) => {
      try {
        if (m && m.role === "card" && m.pick) {
          renderCard(m.pick, m.overLimit, m.spendLimit);
          return;
        }
        const role = m && (m.role === "user" || m.role === "assistant") ? m.role : "assistant";
        const content = m && typeof m.content === "string" ? m.content.replace(/^RECOMMEND:\s*/, "") : "(this message couldn't be displayed)";
        addMsg(role, content);
      } catch (err) {
        console.warn("Skipped a malformed message while loading conversation:", m, err);
      }
    });
  }
  loadConvoList(convo.id);
  input.focus();
}

async function startNewConversation() {
  const res = await fetch("/api/conversations", { method: "POST" });
  const convo = await res.json();
  currentConversationId = convo.id;
  currentTitleLocked = false;
  history = [];
  stage = "gathering";
  prefs = { useCases: [] };
  userText = "";
  chatEl.innerHTML = "";
  ordersPanel.style.display = "none";
  chatEl.style.display = "flex";
  addMsg("assistant", "Hey — tell me what gadget you need and what you'll mainly use it for. I'll find the right one and can complete the purchase for you.");
  loadConvoList(convo.id);
  input.focus();
}

document.getElementById("newChatBtn").onclick = startNewConversation;

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    startNewConversation();
  }
});

async function saveCurrentConversation() {
  if (!currentConversationId) return;
  const body = { messages: history, stage, prefs };
  if (!currentTitleLocked) {
    body.title = history.find((m) => m.role === "user")?.content?.slice(0, 40) || "New chat";
  }
  await fetch(`/api/conversations/${currentConversationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  loadConvoList(currentConversationId);
}

// --- Init: load existing conversations, or start a fresh one ---
async function initConversations() {
  const res = await fetch("/api/conversations");
  const convos = await res.json();
  if (convos.length > 0) {
    await loadConversation(convos[0].id);
  } else {
    await startNewConversation();
  }
}

// --- Auth check: redirect to login if not signed in ---
let currentUser = null;

function applyAvatarInitial(name) {
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  document.getElementById("avatarBtn").textContent = initial;
}

async function checkAuth() {
  const res = await fetch("/api/me");
  if (!res.ok) {
    window.location.href = "/login.html";
    return;
  }
  const user = await res.json();
  currentUser = user;
  document.getElementById("greeting").textContent = `hey ${user.name} — tell me what you need`;
  applyAvatarInitial(user.name);
  currentSpendLimit = user.spendLimit;
  updateLimitPill();
  await initConversations();
  input.focus();
}
checkAuth();

// --- Spend limit (editable) ---
let currentSpendLimit = 60000;
const limitPill = document.getElementById("limitPill");
const settingsModal = document.getElementById("settingsModal");
const spendLimitInput = document.getElementById("spendLimitInput");
const spendLimitError = document.getElementById("spendLimitError");

function updateLimitPill() {
  limitPill.textContent = `limit ₹${currentSpendLimit.toLocaleString("en-IN")}`;
}

limitPill.onclick = () => {
  spendLimitInput.value = currentSpendLimit;
  spendLimitError.textContent = "";
  settingsModal.style.display = "flex";
  spendLimitInput.focus();
};
document.getElementById("settingsCancel").onclick = () => { settingsModal.style.display = "none"; };
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.style.display = "none"; });

document.getElementById("settingsSave").onclick = async () => {
  const val = Number(spendLimitInput.value);
  if (!val || val <= 0) {
    spendLimitError.textContent = "enter an amount greater than ₹0";
    return;
  }
  const res = await fetch("/api/spend-limit", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spendLimit: val }),
  });
  const data = await res.json();
  if (!res.ok) {
    spendLimitError.textContent = data.message || "couldn't update — try again";
    return;
  }
  currentSpendLimit = data.spendLimit;
  updateLimitPill();
  settingsModal.style.display = "none";
};

document.getElementById("logoutBtn").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
};

// --- Light/dark mode ---
const modeSelect = document.getElementById("modeSelect");

function applyMode() {
  const mode = localStorage.getItem("gg-mode") || "light";
  document.documentElement.setAttribute("data-mode", mode);
  modeSelect.value = mode;
}
modeSelect.onchange = () => { localStorage.setItem("gg-mode", modeSelect.value); applyMode(); };
applyMode();

// --- Color palette ---
const paletteSwatches = document.getElementById("paletteSwatches");

function applyPalette() {
  const palette = localStorage.getItem("gg-palette") || "sage";
  document.documentElement.setAttribute("data-palette", palette);
  paletteSwatches.querySelectorAll(".palette-swatch").forEach((el) => {
    el.classList.toggle("active", el.dataset.palette === palette);
  });
}
paletteSwatches.querySelectorAll(".palette-swatch").forEach((el) => {
  el.onclick = () => { localStorage.setItem("gg-palette", el.dataset.palette); applyPalette(); };
});
applyPalette();

// --- Credit line ---
// Change CREATOR_NAME to have it show in the sidebar footer as "made with ♥ by ___"
const CREATOR_NAME = "GAP and PJ";
document.getElementById("creditName").textContent = CREATOR_NAME;

// --- Settings modal (display + cards tabs) ---
const appSettingsModal = document.getElementById("appSettingsModal");
document.getElementById("appSettingsBtn").onclick = () => {
  appSettingsModal.style.display = "flex";
  loadSavedCards();
};
document.getElementById("appSettingsClose").onclick = () => { appSettingsModal.style.display = "none"; };
appSettingsModal.addEventListener("click", (e) => { if (e.target === appSettingsModal) appSettingsModal.style.display = "none"; });

appSettingsModal.querySelectorAll("[data-settings-tab]").forEach((btn) => {
  btn.onclick = () => {
    appSettingsModal.querySelectorAll("[data-settings-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("displayTab").classList.toggle("active", btn.dataset.settingsTab === "display");
    document.getElementById("cardsTab").classList.toggle("active", btn.dataset.settingsTab === "cards");
  };
});

async function addCardOnly() {
  const btn = document.getElementById("addCardBtn");
  btn.disabled = true;
  btn.textContent = "opening secure Prava page…";

  let session;
  try {
    const sessionRes = await fetch("/api/prava/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totalAmount: "1", description: "Save a card for future purchases", merchantName: "GadgetGuide" }),
    });
    session = await sessionRes.json();
    if (!sessionRes.ok) throw new Error(session.error || "Failed to create Prava session");
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "+ add a card";
    alert(`Couldn't start card setup: ${err.message}`);
    return;
  }

  sessionStorage.setItem(
    "gg-pending-checkout",
    JSON.stringify({
      sessionId: session.session_id,
      type: "addCard",
      laptopLabel: "Save a card",
      amount: 1,
      conversationId: null,
    })
  );

  window.location.href = session.iframe_url;
}
document.getElementById("addCardBtn").onclick = addCardOnly;

async function loadSavedCards() {
  const listEl = document.getElementById("savedCardsList");
  const res = await fetch("/api/saved-cards");
  const cards = await res.json();
  listEl.innerHTML = cards.length
    ? cards.map((c) => `
      <div class="saved-card-row" data-token="${c.token}">
        <div>
          <div class="card-label">•••• ${c.last4}</div>
          <div class="card-meta">expires ${c.expiryMonth}/${c.expiryYear}</div>
        </div>
        <button class="icon-btn remove-card-btn" data-token="${c.token}">remove</button>
      </div>`).join("") + `<div class="saved-card-note">these are the payment credentials issued for your past purchases here.</div>`
    : `<div class="msg system-note">no saved cards yet</div>`;

  listEl.querySelectorAll(".remove-card-btn").forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/saved-cards/${btn.dataset.token}`, { method: "DELETE" });
      loadSavedCards();
    };
  });
}

// --- Custom background upload ---
const customBg = document.getElementById("customBg");
function applyBackground() {
  const bg = localStorage.getItem("gg-bg");
  if (bg) {
    customBg.style.backgroundImage = `url(${bg})`;
    customBg.classList.add("active");
  } else {
    customBg.style.backgroundImage = "";
    customBg.classList.remove("active");
  }
}
document.getElementById("bgUpload").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    localStorage.setItem("gg-bg", reader.result);
    applyBackground();
  };
  reader.readAsDataURL(file);
});
document.getElementById("clearBgBtn").onclick = () => {
  localStorage.removeItem("gg-bg");
  applyBackground();
};
applyBackground();

// --- Orders panel ---
document.getElementById("ordersBtn").onclick = async () => {
  const showingOrders = ordersPanel.style.display !== "none";
  if (showingOrders) {
    ordersPanel.style.display = "none";
    chatEl.style.display = "flex";
    return;
  }
  const res = await fetch("/api/orders");
  const orders = await res.json();
  const total = orders.reduce((sum, o) => sum + (o.amount || 0), 0);
  const summary = orders.length
    ? `<div class="orders-summary"><span>${orders.length} order${orders.length > 1 ? "s" : ""}</span><span>₹${total.toLocaleString("en-IN")} total</span></div>`
    : "";
  ordersPanel.innerHTML = summary + (orders.length
    ? orders.map((o) => `
      <div class="order-row">
        <div class="row-top"><span>${o.laptop}</span><span>₹${o.amount.toLocaleString("en-IN")}</span></div>
        <div class="row-meta">${o.merchant} · ${new Date(o.date).toLocaleString()} · ${o.status}</div>
      </div>`).join("")
    : `<div class="msg system-note">no orders yet — start a chat and buy something</div>`);
  ordersPanel.style.display = "block";
  chatEl.style.display = "none";
};

// --- Profile modal (avatar button) ---
const profileModal = document.getElementById("profileModal");
const profileInfoView = document.getElementById("profileInfoView");
const profileInfoForm = document.getElementById("profileInfoForm");
const profileEditBtn = document.getElementById("profileEditBtn");
const profileNameInput = document.getElementById("profileNameInput");
const profileEmailInput = document.getElementById("profileEmailInput");
const profilePhoneInput = document.getElementById("profilePhoneInput");
const profileFormError = document.getElementById("profileFormError");

function renderProfileInfoView(user) {
  profileInfoView.innerHTML = `
    <div class="profile-info-row"><span class="label">name</span><span>${user.name}</span></div>
    <div class="profile-info-row"><span class="label">email</span><span>${user.email || "—"}</span></div>
    <div class="profile-info-row"><span class="label">phone</span><span>${user.phone || "—"}</span></div>
    <div class="profile-info-row"><span class="label">spend limit</span><span>₹${user.spendLimit.toLocaleString("en-IN")}</span></div>
  `;
}

function renderProfileOrders(orders) {
  const el = document.getElementById("profileOrders");
  if (!orders.count) {
    el.innerHTML = `<div class="profile-empty">no orders yet — start a chat and buy something</div>`;
    return;
  }
  el.innerHTML = `
    <div class="orders-summary"><span>${orders.count} order${orders.count > 1 ? "s" : ""}</span><span>₹${orders.total.toLocaleString("en-IN")} total</span></div>
    ${orders.list.map((o) => `
      <div class="order-row">
        <div class="row-top"><span>${o.laptop}</span><span>₹${o.amount.toLocaleString("en-IN")}</span></div>
        <div class="row-meta">${o.merchant} · ${new Date(o.date).toLocaleString()} · ${o.status}</div>
      </div>`).join("")}
  `;
}

function renderProfileRecommendation(recommendation) {
  const el = document.getElementById("profileRecommendation");
  if (!recommendation) {
    el.innerHTML = `<div class="profile-empty">chat with the agent about a budget and use case to get a personalized pick here</div>`;
    return;
  }
  const { pick, overLimit, spendLimit } = recommendation;
  el.innerHTML = `
    <div class="card profile-rec-card${overLimit ? " over-limit" : ""}">
      <div class="model">${pick.brand} ${pick.model}</div>
      <div class="price">₹${pick.price_inr.toLocaleString("en-IN")} · ${pick.merchant}</div>
      <div class="why-note">${pick.why}</div>
      ${overLimit ? `<div class="row-meta">₹${(pick.price_inr - spendLimit).toLocaleString("en-IN")} over your ₹${spendLimit.toLocaleString("en-IN")} limit</div>` : ""}
    </div>
  `;
}

async function openProfile() {
  const res = await fetch("/api/profile");
  if (!res.ok) return;
  const data = await res.json();
  currentUser = { ...currentUser, ...data.user };

  document.getElementById("profileName").textContent = data.user.name;
  document.getElementById("profileContact").textContent = data.user.email || data.user.phone || "";
  document.getElementById("profileAvatar").textContent = (data.user.name || "?").trim().charAt(0).toUpperCase();

  profileInfoForm.style.display = "none";
  profileEditBtn.style.display = "inline-block";
  renderProfileInfoView(data.user);
  renderProfileOrders(data.orders);
  renderProfileRecommendation(data.recommendation);

  profileModal.style.display = "flex";
}

document.getElementById("avatarBtn").onclick = openProfile;
document.getElementById("profileCloseBtn").onclick = () => { profileModal.style.display = "none"; };
profileModal.addEventListener("click", (e) => { if (e.target === profileModal) profileModal.style.display = "none"; });

profileEditBtn.onclick = () => {
  profileNameInput.value = currentUser.name || "";
  profileEmailInput.value = currentUser.email || "";
  profilePhoneInput.value = currentUser.phone || "";
  profileFormError.textContent = "";
  profileInfoView.style.display = "none";
  profileEditBtn.style.display = "none";
  profileInfoForm.style.display = "flex";
};

document.getElementById("profileCancelBtn").onclick = () => {
  profileInfoForm.style.display = "none";
  profileInfoView.style.display = "block";
  profileEditBtn.style.display = "inline-block";
};

document.getElementById("profileSaveBtn").onclick = async () => {
  const name = profileNameInput.value.trim();
  const email = profileEmailInput.value.trim();
  const phone = profilePhoneInput.value.trim();
  if (!name) {
    profileFormError.textContent = "name can't be empty";
    return;
  }
  const res = await fetch("/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, phone }),
  });
  const data = await res.json();
  if (!res.ok) {
    profileFormError.textContent = data.message || "couldn't save — try again";
    return;
  }
  currentUser = data;
  document.getElementById("greeting").textContent = `hey ${data.name} — tell me what you need`;
  applyAvatarInitial(data.name);
  document.getElementById("profileName").textContent = data.name;
  document.getElementById("profileContact").textContent = data.email || data.phone || "";
  document.getElementById("profileAvatar").textContent = (data.name || "?").trim().charAt(0).toUpperCase();
  renderProfileInfoView(data);
  profileInfoForm.style.display = "none";
  profileInfoView.style.display = "block";
  profileEditBtn.style.display = "inline-block";
};

// --- Chat helpers ---
function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function addNote(text) {
  const div = document.createElement("div");
  div.className = "msg system-note";
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderCard(pick, overLimit, spendLimit) {
  const card = document.createElement("div");
  card.className = "card" + (overLimit ? " over-limit" : "");
  card.innerHTML = `
    <div class="model">${pick.brand} ${pick.model}</div>
    <div class="price">₹${pick.price_inr.toLocaleString("en-IN")} · ${pick.merchant}</div>
    <div class="specs">
      <div>CPU: ${pick.cpu}</div>
      <div>RAM: ${pick.ram_gb}GB</div>
      <div>GPU: ${pick.gpu}</div>
      <div>Storage: ${pick.storage_gb}GB</div>
      <div>Screen: ${pick.screen}</div>
      <div>Battery: ~${pick.battery_hrs}hrs</div>
    </div>
    <div class="why-note">${pick.why}</div>
    <div class="actions"></div>
  `;
  const actions = card.querySelector(".actions");

  if (overLimit) {
    addNote(`this is ₹${(pick.price_inr - spendLimit).toLocaleString("en-IN")} over your ₹${spendLimit.toLocaleString("en-IN")} limit`);
    const approveBtn = document.createElement("button");
    approveBtn.className = "btn primary";
    approveBtn.textContent = "Approve this amount anyway";
    approveBtn.onclick = () => runCheckout(pick, pick.price_inr, card);

    const declineBtn = document.createElement("button");
    declineBtn.className = "btn";
    declineBtn.textContent = "Show a cheaper option";
    declineBtn.onclick = () => {
      addMsg("user", "show me something cheaper");
      requestRecommendation(spendLimit * 0.85, pick.id);
    };
    actions.append(approveBtn, declineBtn);
  } else {
    const buyBtn = document.createElement("button");
    buyBtn.className = "btn primary";
    buyBtn.textContent = "Yes, buy this";
    buyBtn.onclick = () => runCheckout(pick, pick.price_inr, card);

    const noBtn = document.createElement("button");
    noBtn.className = "btn";
    noBtn.textContent = "Show a different one";
    noBtn.onclick = () => {
      addMsg("user", "show me a different option");
      requestRecommendation(null, pick.id);
    };
    actions.append(buyBtn, noBtn);
  }

  chatEl.appendChild(card);
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function runCheckout(laptop, amount, cardEl) {
  cardEl.querySelectorAll("button").forEach((b) => (b.disabled = true));

  if (pravaConfig.pravaConfigured) {
    return runRealPravaCheckout(laptop, amount, cardEl);
  }
  return runMockCheckout(laptop, amount, cardEl);
}

// --- Mock flow (no real Prava credentials set) ---
async function runMockCheckout(laptop, amount, cardEl) {
  const passkey = document.createElement("div");
  passkey.className = "passkey";
  passkey.innerHTML = `<span class="dot"></span> waiting for passkey approval… (mock — add PRAVA keys to .env for real checkout)`;
  chatEl.appendChild(passkey);
  chatEl.scrollTop = chatEl.scrollHeight;

  await new Promise((r) => setTimeout(r, 1200));

  const res = await fetch("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ laptopId: laptop.id, approvedAmount: amount }),
  });
  const data = await res.json();
  passkey.remove();

  if (data.status === "mock_success" || data.status === "success") {
    addMsg("assistant", `Done — ${laptop.brand} ${laptop.model} purchased for ₹${amount.toLocaleString("en-IN")} via Prava. Confirmation sent.`);
  } else {
    addMsg("assistant", `Something went wrong completing the purchase: ${data.message || "unknown error"}`);
  }
}

// --- Real Prava flow (hosted mode): create session -> redirect to Prava's own https page for
// card entry + passkey -> Prava redirects back to checkout-callback.html when done.
// Hosted mode avoids embedding Prava's card form in an iframe on our page, which matters
// specifically because Visa's own security iframe refuses to load inside a non-https parent
// page (a real limitation of running on plain http://localhost during development).
async function runRealPravaCheckout(laptop, amount, cardEl) {
  addNote("opening secure Prava checkout — you'll be redirected…");

  let session;
  try {
    const sessionRes = await fetch("/api/prava/create-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ totalAmount: amount, description: `${laptop.brand} ${laptop.model}`, merchantName: laptop.merchant }),
    });
    session = await sessionRes.json();
    if (!sessionRes.ok) {
      console.error("[Prava] create-session error detail:", session);
      throw new Error(session.error || "Failed to create Prava session");
    }
  } catch (err) {
    addMsg("assistant", `Couldn't start the Prava checkout: ${err.message} (see browser console for full detail)`);
    return;
  }

  // Save what we need to finish up after Prava redirects back to us
  sessionStorage.setItem(
    "gg-pending-checkout",
    JSON.stringify({
      sessionId: session.session_id,
      laptopId: laptop.id,
      laptopLabel: `${laptop.brand} ${laptop.model}`,
      amount,
      conversationId: currentConversationId,
    })
  );

  window.location.href = session.iframe_url;
}

async function requestRecommendation(budgetOverride, excludeId) {
  const res = await fetch("/api/recommend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefs, excludeId, budgetOverride }),
  });
  const data = await res.json();
  renderCard(data.pick, data.overLimit, data.spendLimit);
  history.push({ role: "card", pick: data.pick, overLimit: data.overLimit, spendLimit: data.spendLimit });
  await saveCurrentConversation();
}

const sendBtn = form.querySelector("button[type=submit]");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  userText += " " + text;

  addMsg("user", text);
  history.push({ role: "user", content: text });

  input.disabled = true;
  sendBtn.disabled = true;
  const typing = document.createElement("div");
  typing.className = "msg assistant";
  typing.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  chatEl.appendChild(typing);
  chatEl.scrollTop = chatEl.scrollHeight;

  let data;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, stage, prefs }),
    });
    data = await res.json();
  } catch (err) {
    typing.remove();
    addMsg("assistant", "Couldn't reach the server — check it's still running.");
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
    return;
  }

  typing.remove();
  history.push({ role: "assistant", content: data.content });
  stage = data.stage || "gathering";
  prefs = data.prefs || prefs;

  if (data.content.startsWith("RECOMMEND:")) {
    addMsg("assistant", data.content.replace("RECOMMEND:", "").trim());
    renderCard(data.recommendation, data.overLimit, data.spendLimit);
    history.push({ role: "card", pick: data.recommendation, overLimit: data.overLimit, spendLimit: data.spendLimit });
  } else {
    addMsg("assistant", data.content);
  }

  input.disabled = false;
  sendBtn.disabled = false;
  input.focus();

  await saveCurrentConversation();
});
