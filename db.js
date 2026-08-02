// Minimal file-based "database" - good enough for a hackathon prototype.
// Stores everything in db.json. No native modules, no setup required.

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "db.json");

function load() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: [] };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function findUserByIdentifier(identifier) {
  const data = load();
  return data.users.find((u) => u.email === identifier || u.phone === identifier);
}

function findUserById(id) {
  const data = load();
  return data.users.find((u) => u.id === id);
}

function createUser(user) {
  const data = load();
  data.users.push(user);
  save(data);
  return user;
}

function updateUser(userId, updates) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  Object.assign(user, updates);
  save(data);
  return user;
}

function setResetToken(userId, token, expiresAt) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  user.resetToken = token;
  user.resetTokenExpiry = expiresAt;
  save(data);
  return user;
}

function findUserByResetToken(token) {
  const data = load();
  return data.users.find((u) => u.resetToken === token);
}

function updatePassword(userId, passwordHash) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  user.passwordHash = passwordHash;
  user.resetToken = null;
  user.resetTokenExpiry = null;
  save(data);
  return user;
}

function getConversations(userId) {
  const user = findUserById(userId);
  return user ? (user.conversations || []).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })) : [];
}

function getConversation(userId, conversationId) {
  const user = findUserById(userId);
  if (!user) return null;
  return (user.conversations || []).find((c) => c.id === conversationId) || null;
}

function createConversation(userId, conversation) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  user.conversations = user.conversations || [];
  user.conversations.unshift(conversation);
  save(data);
  return conversation;
}

function updateConversation(userId, conversationId, updates) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  const convo = (user.conversations || []).find((c) => c.id === conversationId);
  if (!convo) return null;
  Object.assign(convo, updates, { updatedAt: new Date().toISOString() });
  save(data);
  return convo;
}

function deleteConversation(userId, conversationId) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  user.conversations = (user.conversations || []).filter((c) => c.id !== conversationId);
  save(data);
  return true;
}

function upsertSavedCard(userId, card) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  user.savedCards = user.savedCards || [];
  const existing = user.savedCards.find((c) => c.token === card.token);
  if (existing) {
    Object.assign(existing, card);
  } else {
    user.savedCards.push(card);
  }
  save(data);
  return card;
}

function getSavedCards(userId) {
  const user = findUserById(userId);
  return user ? user.savedCards || [] : [];
}

function removeSavedCard(userId, token) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  user.savedCards = (user.savedCards || []).filter((c) => c.token !== token);
  save(data);
  return true;
}

function addOrder(userId, order) {
  const data = load();
  const user = data.users.find((u) => u.id === userId);
  if (!user) return null;
  user.orders = user.orders || [];
  user.orders.push(order);
  save(data);
  return order;
}

function getOrders(userId) {
  const user = findUserById(userId);
  return user ? user.orders || [] : [];
}

// Conversations are stored newest-first (unshift on create), so the first
// one with an actual budget/useCase gives us the most recent real prefs.
function getLatestPrefs(userId) {
  const user = findUserById(userId);
  if (!user) return null;
  const convos = user.conversations || [];
  const withPrefs = convos.find(
    (c) => c.prefs && (c.prefs.budget || (c.prefs.useCases || []).length > 0)
  );
  return withPrefs ? withPrefs.prefs : null;
}

module.exports = {
  findUserByIdentifier,
  findUserById,
  createUser,
  updateUser,
  addOrder,
  getOrders,
  upsertSavedCard,
  getSavedCards,
  removeSavedCard,
  setResetToken,
  findUserByResetToken,
  updatePassword,
  getConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  getLatestPrefs,
};
