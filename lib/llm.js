// lib/llm.js
//
// This is the "intelligence" upgrade: a real Claude call that understands
// what the user means, including implied needs regex can never catch
// ("I do a lot of 3D modeling for architecture" -> creator/GPU need, even
// though the user never said "gaming" or "editing").
//
// Design principle: the LLM's job is narrow on purpose. It ONLY extracts
// structured data — { budget, useCases } — from the conversation so far.
// It never picks a laptop, never mentions a price, never free-chats. The
// actual recommendation math still lives in lib/agent.js's scoreLaptop(),
// completely unchanged. This keeps the system predictable: an LLM mistake
// can misread what the user wants, but it can never invent a price or
// recommend something not in the catalog, because it doesn't have that job.

const KNOWN_TAGS = [
  'gaming', 'coding', 'creator', 'ml', 'business',
  'student', 'portable', 'battery', 'browsing',
];

const SYSTEM_PROMPT = `You are the understanding layer for GadgetGuide, a laptop-buying assistant.

Your ONLY job: read the user's message and extract two fields. You never recommend a product, never mention a price, never make conversation.

Known use-case tags — use ONLY these, never invent new ones:
${KNOWN_TAGS.join(', ')}

Rules:
- Infer use cases from context even when the exact word isn't used. "I do a lot of 3D modeling for architecture" implies "creator". "It's for my CS degree" implies "coding" and "student". "I need it for TensorFlow work" implies "ml".
- A message can imply zero, one, or several use cases. Don't force a match that isn't there.
- budget is a number in Indian Rupees, or null if not mentioned or too vague to convert. Convert "60k" -> 60000, "6 lakh" -> 600000, "half a lakh" -> 50000.
- If the user gives a range ("50-60k"), use the upper bound.
- Output ONLY valid JSON. No prose, no markdown fences, no explanation outside the JSON.

Output format exactly:
{"budget": <number or null>, "useCases": [<subset of known tags>], "reasoning": "<one short phrase, for logs only>"}

Examples:

User: "need something for coding and gaming, have about 60k"
{"budget": 60000, "useCases": ["coding","gaming"], "reasoning": "explicit budget and use cases"}

User: "not sure on budget yet, mostly want it for class"
{"budget": null, "useCases": ["student"], "reasoning": "no budget given, class implies student"}

User: "I do a lot of 3D modeling for architecture, budget is flexible up to 1 lakh"
{"budget": 100000, "useCases": ["creator"], "reasoning": "3D modeling for architecture implies creator/GPU need"}

User: "just need it for uni and some valorant on the side"
{"budget": null, "useCases": ["student","gaming"], "reasoning": "uni implies student, valorant implies gaming"}

User: "training some ML models for a project, 2 lakh budget"
{"budget": 200000, "useCases": ["ml"], "reasoning": "training ML models implies ml"}`;

const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap, right fit for slot-filling

async function callLLM(conversationText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — LLM understanding is disabled, falling back to rules.');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      temperature: 0, // slot-filling wants predictability, not creativity
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: conversationText }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const rawText = data.content.map((block) => block.text || '').join('');
  return parseAndValidate(rawText);
}

function parseAndValidate(rawText) {
  let parsed;
  try {
    // Strip stray markdown fences if the model adds them despite instructions
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LLM returned non-JSON output, discarding: ${rawText.slice(0, 200)}`);
  }

  const budget =
    typeof parsed.budget === 'number' && parsed.budget > 0 ? Math.round(parsed.budget) : null;

  const useCases = Array.isArray(parsed.useCases)
    ? parsed.useCases.filter((tag) => KNOWN_TAGS.includes(tag))
    : [];

  return { budget, useCases, reasoning: parsed.reasoning || null };
}

module.exports = { callLLM, KNOWN_TAGS, SYSTEM_PROMPT };
