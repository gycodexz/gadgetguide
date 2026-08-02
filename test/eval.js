// test/eval.js
// Run: node test/eval.js
// Quick regression check for budget/use-case extraction and final recommendations.
// Add a new case here every time a real conversation trips up the agent.

const { extractBudget, extractUseCases, recommend } = require('../lib/agent');

const budgetCases = [
  { input: 'around 60k', expect: 60000 },
  { input: '₹60,000', expect: 60000 },
  { input: 'budget is 60000', expect: 60000 },
  { input: '6 lakh', expect: 600000 },
  { input: 'under a lakh', expect: 100000 },
  { input: 'half a lakh', expect: 50000 },
  { input: '1.5 lakh', expect: 150000 },
  { input: 'no idea on price', expect: null },
];

const useCaseCases = [
  { input: 'coding and some gaming', expect: ['coding', 'gaming'] },
  { input: 'for uni and some valorant', expect: ['student', 'gaming'] },
  { input: 'architecture stuff, lots of rendering', expect: ['creator'] },
  { input: 'need it for machine learning and data science', expect: ['ml'] },
  { input: 'just office work, presentations mostly', expect: ['business'] },
  { input: 'basic use, just docs and emails', expect: ['browsing'] },
  { input: 'coding, want it light to carry around', expect: ['coding', 'portable'] },
];

const recommendationCases = [
  {
    name: 'Engineering student, 60k, coding + gaming',
    prefs: { budget: 60000, useCases: ['coding', 'gaming'] },
    expectId: 'asus-vivobook-16x',
  },
  {
    name: 'Gaming, 75k',
    prefs: { budget: 75000, useCases: ['gaming'] },
    expectId: 'asus-tuf-a15',
  },
  {
    name: 'Tight budget, coding only, 40k',
    prefs: { budget: 40000, useCases: ['coding'] },
  },
  {
    name: 'Architecture / creator, 1 lakh',
    prefs: { budget: 100000, useCases: ['creator'] },
  },
  {
    name: 'ML / data science, 2 lakh',
    prefs: { budget: 200000, useCases: ['ml'] },
  },
  {
    name: 'Business laptop, 70k',
    prefs: { budget: 70000, useCases: ['business'] },
  },
];

let pass = 0, fail = 0;

console.log('--- Budget extraction ---');
for (const c of budgetCases) {
  const got = extractBudget(c.input);
  const ok = got === c.expect;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${c.input}" -> ${got}  (expected ${c.expect})`);
}

console.log('\n--- Use-case extraction ---');
for (const c of useCaseCases) {
  const got = extractUseCases(c.input);
  const ok = c.expect.every((e) => got.includes(e));
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  "${c.input}" -> [${got.join(', ')}]  (expected to include [${c.expect.join(', ')}])`);
}

console.log('\n--- End-to-end recommendations ---');
for (const c of recommendationCases) {
  const rec = recommend(c.prefs);
  const ok = c.expectId ? rec.id === c.expectId : true;
  ok ? pass++ : fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name} -> ${rec.brand} ${rec.model} (₹${rec.price_inr.toLocaleString('en-IN')})` +
      (c.expectId ? `  [expected ${c.expectId}]` : '')
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
