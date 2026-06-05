#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The Basic Land Game — self-play harness (fuzz test + agent scaffolding)
//
// Two jobs in one file:
//
//   1. Fuzz / regression: run a batch of deterministic AI-vs-AI games for the
//      base config and every variant, asserting that EVERY game terminates with
//      a non-null winner inside a sane cap and never throws. Aggregate stats are
//      printed per config (games, avg turns, rainbow/five split, who-won split).
//
//   2. Scaffolding / inspection: `--seed N --verbose` replays exactly one game
//      and prints its full, human-readable move log from game.log.
//
// Everything is driven through the same public door the UI uses:
//   createGame(...) → loop { chooseAction(game, game.awaiting.player) → apply }.
//
// Usage:
//   node tests/play.mjs                      # batch fuzz, base + every variant
//   node tests/play.mjs --games 2000         # more games per config
//   node tests/play.mjs --seed 7 --verbose   # full move log for one game
//   node tests/play.mjs --big                # copiesPerType:10 (50-card deck)
//   node tests/play.mjs --thoughtseize       # swampRevealAll (Bog reveals all)
//   node tests/play.mjs --cloud              # blueDrawWhiteCloudshift
//   (flags combine, e.g. --big --cloud --seed 3 --verbose)
//
// Exit code is non-zero if any game fails an assertion, so it doubles as CI.
// ---------------------------------------------------------------------------

import { createGame, apply } from '../src/engine.js';
import { chooseAction } from '../src/ai.js';

// A land that resolves OR is countered counts as one "land resolution". We cap
// well above the observed maximum (~45) so a hang fails loudly instead of
// spinning forever.
const RESOLUTION_CAP = 400;

// ---- argument parsing ------------------------------------------------------
function parseArgs(argv) {
  const args = {
    games: 500,
    seed: null,
    verbose: false,
    config: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--games': args.games = parseInt(argv[++i], 10); break;
      case '--seed': args.seed = parseInt(argv[++i], 10); break;
      case '--verbose': case '-v': args.verbose = true; break;
      case '--big': args.config.copiesPerType = 10; break;
      case '--thoughtseize': args.config.swampRevealAll = true; break;
      case '--cloud': args.config.blueDrawWhiteCloudshift = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        console.error(`unknown flag: ${a}`);
        process.exit(2);
    }
  }
  return args;
}

const HELP = `Basic Land Game — self-play harness

  node tests/play.mjs                      batch fuzz: base config + every variant
  node tests/play.mjs --games N            games per config (default 500)
  node tests/play.mjs --seed N --verbose   print one game's full move log
  node tests/play.mjs --big                copiesPerType:10 (50-card deck)
  node tests/play.mjs --thoughtseize       swampRevealAll (Bog reveals whole hand)
  node tests/play.mjs --cloud              blueDrawWhiteCloudshift (Tide draws, Meadow flickers)

Flags combine. With --seed but no --verbose, just that seed's config is summarized.`;

// ---- the core loop ---------------------------------------------------------
// Plays one game to completion through chooseAction/apply. Returns the finished
// game, or throws if it exceeds the cap or the engine throws.
function playGame({ seed, config }) {
  const game = createGame({ seed, config });
  let resolutions = 0;
  let lastTurn = -1;
  let steps = 0;
  while (game.awaiting && !game.winner) {
    // Count a land resolution each time the active player's `turn` advances or
    // a land enters/counters. We use the structural step cap as the real guard.
    if (game.turn !== lastTurn) { lastTurn = game.turn; resolutions++; }
    if (resolutions > RESOLUTION_CAP) {
      throw new Error(`seed ${seed} exceeded ${RESOLUTION_CAP} land resolutions (likely a loop)`);
    }
    if (++steps > RESOLUTION_CAP * 50) {
      throw new Error(`seed ${seed} exceeded the micro-step cap (likely a loop)`);
    }
    const seat = game.awaiting.player;
    const action = chooseAction(game, seat);
    apply(game, action);
  }
  if (!game.winner) throw new Error(`seed ${seed} ended with no winner`);
  return game;
}

// ---- verbose single-game replay -------------------------------------------
function emojiFor(kind) {
  return ({
    start: '🎬', mulligan: '🔁', reshuffle: '🔀', draw: '🎴',
    play: '▶️', counter: '🛡️', countered: '🚫', enter: '✅',
    'effect-draw': '🎴', 'effect-forest-empty': '♻️', 'forest-return': '♻️',
    'effect-volcano-empty': '🌋', 'volcano-destroy': '💥',
    'effect-bog-empty': '💀', 'bog-reveal': '👀', 'bog-discard': '🗑️',
    'scry-keep': '🔮', 'scry-bury': '⛏️',
    cloudshift: '✨', 'cloudshift-done': '✨', 'effect-cloudshift-empty': '✨',
    win: '🏆',
  })[kind] || '·';
}

function runVerbose({ seed, config }) {
  const game = playGame({ seed, config });
  const cfgStr = JSON.stringify(config);
  console.log(`# Basic Land Game — seed ${seed}  config ${cfgStr}`);
  console.log(`# ${game.players[0].name} vs ${game.players[1].name}; ${game.players[game.firstPlayer].name} went first\n`);
  for (const entry of game.log) {
    const who = entry.player != null ? `[P${entry.player + 1}] ` : '      ';
    console.log(`${emojiFor(entry.kind)} ${who}${entry.msg}`);
  }
  const w = game.winner;
  console.log(`\n=> Winner: ${game.players[w.player].name} (P${w.player + 1}) by ${w.condition}.`);
  console.log(`=> Turns (land resolutions): ${game.turn}`);
}

// ---- batch fuzz ------------------------------------------------------------
function runBatch({ games, config: forcedConfig, onlyForced }) {
  // If the user forced any variant flags, only that config is run. Otherwise we
  // sweep the base config plus each individual variant (the most useful default
  // for catching regressions across all rule branches).
  const configs = onlyForced
    ? [forcedConfig]
    : [
        { label: 'base', config: {} },
        { label: 'thoughtseize (swampRevealAll)', config: { swampRevealAll: true } },
        { label: 'blue-draw/white-cloudshift', config: { blueDrawWhiteCloudshift: true } },
        { label: 'big deck (copiesPerType:10)', config: { copiesPerType: 10 } },
        { label: 'all variants combined', config: { copiesPerType: 10, swampRevealAll: true, blueDrawWhiteCloudshift: true } },
      ].map((x) => x);

  let anyFail = false;
  console.log(`Self-play: ${games} games per config, cap ${RESOLUTION_CAP} resolutions, deterministic seeds 0..${games - 1}.\n`);

  for (const item of configs) {
    const config = item.config !== undefined ? item.config : item;
    const label = item.label || JSON.stringify(config) || 'base';
    const stats = {
      games: 0, fails: 0, totalTurns: 0, maxTurns: 0,
      rainbow: 0, five: 0, firstWins: 0, secondWins: 0,
    };
    for (let seed = 0; seed < games; seed++) {
      try {
        const game = playGame({ seed, config });
        stats.games++;
        stats.totalTurns += game.turn;
        stats.maxTurns = Math.max(stats.maxTurns, game.turn);
        if (game.winner.condition === 'rainbow') stats.rainbow++; else stats.five++;
        if (game.winner.player === game.firstPlayer) stats.firstWins++; else stats.secondWins++;
      } catch (err) {
        stats.fails++;
        anyFail = true;
        console.error(`  ✗ ${label}: ${err.message}`);
      }
    }
    const pct = (n) => stats.games ? ((100 * n) / stats.games).toFixed(1) + '%' : 'n/a';
    const avg = stats.games ? (stats.totalTurns / stats.games).toFixed(1) : 'n/a';
    const mark = stats.fails === 0 ? '✓' : '✗';
    console.log(`${mark} ${label.padEnd(34)} games=${stats.games} fails=${stats.fails} ` +
      `avgTurns=${avg} maxTurns=${stats.maxTurns} ` +
      `rainbow=${pct(stats.rainbow)} five=${pct(stats.five)} ` +
      `1stWin=${pct(stats.firstWins)} 2ndWin=${pct(stats.secondWins)}`);
  }

  console.log(`\n${anyFail ? 'FAILED — see errors above.' : 'All games terminated with a winner. PASS.'}`);
  return anyFail ? 1 : 0;
}

// ---- main ------------------------------------------------------------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return 0; }

  const onlyForced = Object.keys(args.config).length > 0;

  if (args.seed != null && args.verbose) {
    runVerbose({ seed: args.seed, config: args.config });
    return 0;
  }
  if (args.seed != null) {
    // Single seed without --verbose: run just that one game and report.
    try {
      const game = playGame({ seed: args.seed, config: args.config });
      console.log(`seed ${args.seed} ${JSON.stringify(args.config)} → winner P${game.winner.player + 1} ` +
        `by ${game.winner.condition} in ${game.turn} turns.`);
      return 0;
    } catch (err) {
      console.error(`seed ${args.seed} FAILED: ${err.message}`);
      return 1;
    }
  }

  return runBatch({ games: args.games, config: args.config, onlyForced });
}

process.exit(main());
