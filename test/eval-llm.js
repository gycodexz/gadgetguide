// test/eval-llm.js
// Run: node test/eval-llm.js
// Requires ANTHROPIC_API_KEY set (in .env or exported). Tests the LLM
// understanding layer directly, including cases regex genuinely can't catch.

require('dotenv').config();
const { callLLM } = require('../lib/llm');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const cases = [
  'need something for coding and gaming, have about 60k',
  'not sure on budget yet, mostly want it for class',
  'I do a lot of 3D modeling for architecture, budget is flexible up to 1 lakh',
  'just need it for uni and some valorant on the side',
  'training some ML models for a project, 2 lakh budget',
  // Genuinely hard cases regex can't handle — this is the actual point of the upgrade:
  'my thesis involves a lot of Blender rendering, whatever gets that done well, maybe 90k tops',
  'I stream on the side and also just need it for browsing mostly',
  "it's for my kid, just needs to run Zoom and Google Classroom",
];

(async () => {
  for (const input of cases) {
    try {
      const result = await callLLM(input);
      console.log(`"${input}"\n  -> budget: ${result.budget}, useCases: [${result.useCases.join(', ')}]\n  -> reasoning: ${result.reasoning}\n`);
    } catch (err) {
      console.log(`"${input}"\n  -> ERROR: ${err.message}\n`);
    }
  }
})();
