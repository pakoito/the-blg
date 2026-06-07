// ---------------------------------------------------------------------------
// arena.mjs — head-to-head comparison of two AI policies.
//
// Pits policy A against policy B over many seeded games and reports A's win
// rate. Each seed is played TWICE with seats swapped (A first, then A second),
// so first-player advantage cancels out: two identical policies score exactly
// 50% — the correct null. Any deviation is a real skill difference.
//
// Usage:
//   node tests/arena.mjs [--a src/ai.js] [--b src/ai.js] [--variant cloud]
//                        [--games 1000] [--seed0 1] [--quiet]
//
// A policy module must `export function chooseAction(game, seat)`.
// Variants: base | cloud | thoughtseize | big | all
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createGame, apply } from '../src/engine.js';

const VARIANTS = {
  base: {},
  cloud: { blueDrawWhiteCloudshift: true },
  thoughtseize: { swampRevealAll: true },
  big: { copiesPerType: 10 },
  all: { copiesPerType: 10, swampRevealAll: true, blueDrawWhiteCloudshift: true },
};

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const pathA = arg('a', 'src/ai.js');
const pathB = arg('b', 'src/ai.js');
const variantName = arg('variant', 'base');
const games = parseInt(arg('games', '1000'), 10);
const seed0 = parseInt(arg('seed0', '1'), 10);
const ITER_CAP = 200000; // backstop against a non-terminating game (should never hit)

const config = VARIANTS[variantName];
if (!config) {
  console.error(`unknown variant "${variantName}". choose: ${Object.keys(VARIANTS).join(', ')}`);
  process.exit(1);
}

const loadPolicy = async (p) => {
  const mod = await import(pathToFileURL(resolve(process.cwd(), p)).href);
  if (typeof mod.chooseAction !== 'function') throw new Error(`${p} does not export chooseAction`);
  return mod.chooseAction;
};

const A = await loadPolicy(pathA);
const B = await loadPolicy(pathB);

// Play one game. `policies[seat]` is the chooseAction fn controlling that seat.
// Returns the winning seat (0|1) or null if it somehow failed to terminate.
function playGame(seed, policies) {
  const g = createGame({ seed, config });
  let iter = 0;
  while (g.awaiting && !g.winner) {
    if (iter++ > ITER_CAP) return null;
    const seat = g.awaiting.player;
    try {
      apply(g, policies[seat](g, seat));
    } catch (err) {
      // A throwing policy forfeits that game (counts as a loss for that seat).
      return seat === 0 ? 1 : 0;
    }
  }
  return g.winner ? g.winner.player : null;
}

let aWins = 0, bWins = 0, noResult = 0;
let aFirstWins = 0, aSecondWins = 0; // A as the first-seat vs as the second-seat

for (let s = seed0; s < seed0 + games; s++) {
  // Game 1: A is seat 0, B is seat 1.
  let w = playGame(s, [A, B]);
  if (w === 0) { aWins++; aFirstWins++; } else if (w === 1) bWins++; else noResult++;
  // Game 2: swap — B is seat 0, A is seat 1.
  w = playGame(s, [B, A]);
  if (w === 1) { aWins++; aSecondWins++; } else if (w === 0) bWins++; else noResult++;
}

const decided = aWins + bWins;
const rate = decided ? aWins / decided : 0;
const ci = decided ? 1.96 * Math.sqrt((rate * (1 - rate)) / decided) : 0; // 95% half-width
const pct = (x) => (x * 100).toFixed(1) + '%';

if (!has('quiet')) {
  console.log(`Arena — variant "${variantName}", ${games} seeds × 2 seats = ${games * 2} games`);
  console.log(`  A = ${pathA}`);
  console.log(`  B = ${pathB}`);
}
console.log(
  `A win rate: ${pct(rate)} ±${(ci * 100).toFixed(1)}  ` +
  `(A ${aWins} – ${bWins} B${noResult ? `, ${noResult} no-result` : ''})  ` +
  `[A-as-1st ${aFirstWins}/${games}, A-as-2nd ${aSecondWins}/${games}]`
);

if (pathA !== pathB) {
  const lo = rate - ci, hi = rate + ci;
  if (lo > 0.5) console.log(`VERDICT: A is stronger (95% CI ${pct(lo)}–${pct(hi)} > 50%).`);
  else if (hi < 0.5) console.log(`VERDICT: A is weaker (95% CI ${pct(lo)}–${pct(hi)} < 50%).`);
  else console.log(`VERDICT: no significant difference (95% CI ${pct(lo)}–${pct(hi)} spans 50%).`);
}
