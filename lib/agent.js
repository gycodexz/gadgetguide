// lib/agent.js
//
// This is the "brain" of GadgetGuide. It runs as a constrained state machine,
// not free-form chat, so the demo never goes off-script. Each session moves
// through: consult -> decide -> price -> confirm -> limit_check -> transact -> done
//
// The extraction logic here is intentionally rule-based (regex + keyword
// matching) so the whole thing runs with zero external API calls and zero
// API keys for the hackathon demo. See callLLM() at the bottom and README.md
// section "Swapping in a real LLM" for how to upgrade this to GPT-4o.

const laptops = require('../data/laptops.json');

const USE_CASE_KEYWORDS = {
  gaming: ['gaming', 'game', 'games', 'fps', 'esports', 'valorant', 'bgmi'],
  coding: ['coding', 'code', 'programming', 'dev', 'developer', 'engineering', 'cs', 'software', 'compiling', 'ide'],
  creator: ['editing', 'video editing', 'photoshop', 'premiere', 'design', 'render', 'content creation', 'youtube', 'architecture', '3d modeling', '3d', 'cad'],
  ml: ['machine learning', 'data science', 'deep learning', 'ai model', 'tensorflow', 'pytorch', 'ml'],
  business: ['office work', 'corporate', 'work laptop', 'professional', 'business', 'presentations', 'excel'],
  student: ['student', 'college', 'university', 'school', 'class', 'uni', 'coursework', 'assignments'],
  portable: ['light', 'lightweight', 'portable', 'travel', 'carry'],
  battery: ['battery', 'battery life', 'all day', 'unplugged'],
  browsing: ['browsing', 'basic use', 'just docs', 'emails only', 'simple tasks'],
};

function extractBudget(text) {
  const lower = text.toLowerCase();

  // Lakh phrasing: "6 lakh", "1.5 lakh", "under a lakh", "half a lakh"
  if (/half\s*(a\s*)?lakh/.test(lower)) return 50000;
  const lakhMatch = lower.match(/(\d+(?:\.\d+)?)\s*lakh/);
  if (lakhMatch) return Math.round(parseFloat(lakhMatch[1]) * 100000);
  if (/\ba lakh\b/.test(lower)) return 100000;

  // Matches "60k", "₹60,000", "60000", "60 k", "under 60k" etc.
  const kMatch = lower.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);

  const rupeeMatch = text.match(/₹?\s*(\d{2,3}(?:,\d{3})+|\d{4,6})/);
  if (rupeeMatch) return parseInt(rupeeMatch[1].replace(/,/g, ''), 10);

  return null;
}

function extractUseCases(text) {
  const lower = text.toLowerCase();
  const found = new Set();
  for (const [tag, words] of Object.entries(USE_CASE_KEYWORDS)) {
    const matches = words.some((w) => {
      // Multi-word phrases (e.g. "video editing") are fine as plain substrings.
      // Single short words (e.g. "cs", "ml", "dev") need word boundaries so
      // they don't false-positive inside unrelated words like "docs".
      if (w.includes(' ')) return lower.includes(w);
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return re.test(lower);
    });
    if (matches) found.add(tag);
  }
  return Array.from(found);
}

function scoreLaptop(laptop, prefs) {
  let score = 0;
  const budget = prefs.budget || Infinity;

  // Budget fit: reward being under budget, penalize heavily for going over
  if (laptop.price_inr <= budget) {
    score += 10 - (budget - laptop.price_inr) / (budget * 5); // slight preference for using budget well
  } else {
    score -= (laptop.price_inr - budget) / 2000; // steep penalty per rupee over
  }

  // Use-case tag overlap
  for (const useCase of prefs.useCases) {
    if (laptop.tags.includes(useCase)) score += 8;
    if (useCase === 'gaming' && laptop.tags.includes('no-gaming')) score -= 15;
    if (useCase === 'portable' && laptop.weight_kg <= 1.8) score += 3;
    if (useCase === 'battery' && laptop.battery_hrs >= 8) score += 3;
    if (useCase === 'ml' && laptop.ram_gb >= 16) score += 3; // ML workloads want RAM headroom
    if (useCase === 'creator' && laptop.screen.toLowerCase().includes('oled')) score += 3; // color accuracy matters
  }

  return score;
}

// Deterministic tie-breaker so the same inputs always produce the same pick
// in front of judges, even when two laptops score within a hair of each other.
function tieBreak(a, b) {
  if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score; // real difference, not float noise
  if (a.laptop.ram_gb !== b.laptop.ram_gb) return b.laptop.ram_gb - a.laptop.ram_gb;
  return a.laptop.price_inr - b.laptop.price_inr; // cheaper wins if everything else ties
}

function recommend(prefs) {
  const ranked = laptops
    .map((l) => ({ laptop: l, score: scoreLaptop(l, prefs) }))
    .sort(tieBreak);
  return ranked[0].laptop;
}

// Decide what to ask next, or whether we have enough to recommend.
// This is the "constrained question flow" — at most 2 clarifying questions.
function nextStep(session, incomingText) {
  const prefs = session.prefs;
  if (!prefs.unclearCount) prefs.unclearCount = { budget: 0, useCase: 0 };

  if (incomingText) {
    const budget = extractBudget(incomingText);
    if (budget) prefs.budget = budget;

    const useCases = extractUseCases(incomingText);
    useCases.forEach((u) => {
      if (!prefs.useCases.includes(u)) prefs.useCases.push(u);
    });

    if (!prefs.rawInputs) prefs.rawInputs = [];
    prefs.rawInputs.push(incomingText);

    // If this reply didn't move us forward on a field we were waiting on, count it —
    // used to make the next clarifying question more helpful instead of just repeating.
    if (!budget) prefs.unclearCount.budget += 1;
    else prefs.unclearCount.budget = 0;
    if (useCases.length === 0) prefs.unclearCount.useCase += 1;
    else prefs.unclearCount.useCase = 0;
  }

  const missing = [];
  if (!prefs.budget) missing.push('budget');
  if (prefs.useCases.length === 0) missing.push('useCase');

  return { prefs, missing };
}

// LLM-backed version of nextStep. Same contract, same return shape — the
// caller in server.js doesn't need to know which path ran. Falls back to
// the rule-based nextStep() on ANY failure (no API key, network error,
// malformed model output) so a flaky connection never breaks the demo.
async function nextStepSmart(session, incomingText) {
  const prefs = session.prefs;
  if (!prefs.unclearCount) prefs.unclearCount = { budget: 0, useCase: 0 };

  if (incomingText) {
    if (!prefs.rawInputs) prefs.rawInputs = [];
    prefs.rawInputs.push(incomingText);

    let gotBudget = false;
    let gotUseCase = false;

    try {
      const { callLLM } = require('./llm');
      const conversationText = prefs.rawInputs.join('\n');
      const extracted = await callLLM(conversationText);

      if (extracted.budget) { prefs.budget = extracted.budget; gotBudget = true; }
      extracted.useCases.forEach((u) => {
        if (!prefs.useCases.includes(u)) prefs.useCases.push(u);
      });
      gotUseCase = extracted.useCases.length > 0;
      prefs.lastExtractionSource = 'llm';
    } catch (err) {
      console.warn('[nextStepSmart] LLM extraction failed, falling back to rules:', err.message);
      const budget = extractBudget(incomingText);
      if (budget) { prefs.budget = budget; gotBudget = true; }
      const useCases = extractUseCases(incomingText);
      useCases.forEach((u) => {
        if (!prefs.useCases.includes(u)) prefs.useCases.push(u);
      });
      gotUseCase = useCases.length > 0;
      prefs.lastExtractionSource = 'rules-fallback';
    }

    if (!gotBudget) prefs.unclearCount.budget += 1;
    else prefs.unclearCount.budget = 0;
    if (!gotUseCase) prefs.unclearCount.useCase += 1;
    else prefs.unclearCount.useCase = 0;
  }

  const missing = [];
  if (!prefs.budget) missing.push('budget');
  if (prefs.useCases.length === 0) missing.push('useCase');

  return { prefs, missing };
}

function clarifyingQuestion(missingField, unclearCount = 0) {
  if (missingField === 'budget') {
    if (unclearCount >= 2) {
      return "Still need a number to work with — even a rough one helps, like \"50k\", \"around 1 lakh\", or \"under 70000\".";
    }
    if (unclearCount === 1) {
      return "Didn't catch a budget in that — what's your rough budget in ₹? (e.g. \"around 60k\")";
    }
    return "What's your rough budget in ₹? (e.g. \"around 60k\")";
  }
  if (missingField === 'useCase') {
    if (unclearCount >= 2) {
      return "Just need the main thing you'll use it for — pick one: coding, gaming, video/photo editing, office work, or coursework.";
    }
    if (unclearCount === 1) {
      return "Didn't quite catch that — what will you mainly use it for? (coding, gaming, editing, office work, or general coursework)";
    }
    return "What will you mainly use it for — coding, gaming, video/photo editing, office work, or general coursework?";
  }
  return "Could you tell me a bit more about what you need it for?";
}

module.exports = {
  laptops,
  extractBudget,
  extractUseCases,
  scoreLaptop,
  recommend,
  nextStep,
  nextStepSmart,
  clarifyingQuestion,
};
