# Driving The Basic Land Game from code

This is the agent/automation guide for **The Basic Land Game**. The whole game
is a small, deterministic, DOM-free state machine. Every decision — by a human,
the CPU, the test harness, or you — flows through one door:

> read `game.awaiting` (who must act + what is legal) → build a matching action
> → call `apply(game, action)` → repeat until `game.winner` is set.

There are three ways in:

1. **Node API** — `import` the engine directly. Best for tests and headless bots.
2. **Self-play CLI** — `node tests/play.mjs`, a batch fuzz / single-game replay.
3. **In-browser `window.blg`** — the live UI exposes the same machine; drive it
   with `agent-browser eval`.

All three share the identical `awaiting → action` contract documented below.

---

## 1. The Node API

```js
import {
  createGame, apply, view, fullState,
  winFor, distanceToWin, countByType, makeConfig,
  TYPES, FIVE_OF_A_KIND, other,
} from './src/engine.js';
import { chooseAction } from './src/ai.js';
```

### Lifecycle functions

| Function | Purpose |
| --- | --- |
| `createGame({ seed?, config?, firstPlayer?, names? })` | Build a fresh game. Seeded → deterministic. Returns the `game` object. |
| `apply(game, action)` | Advance the game by one decision. **Mutates `game` in place** and returns it. Throws on an illegal action or once the game is over. |
| `view(game, seat)` | What `seat` is allowed to know (own hand + public zones; the opponent's hand is only a count). Use this for any seat-limited bot. |
| `fullState(game)` | Omniscient snapshot (both full hands + decks). For tests/debugging only. |
| `chooseAction(game, seat)` | The built-in heuristic AI. Returns a legal action for the *current* `awaiting`; requires `game.awaiting.player === seat`. |

### Config / variants

`makeConfig(overrides)` fills in defaults:

```js
{ copiesPerType: 5, swampRevealAll: false, blueDrawWhiteCloudshift: false }
```

- `copiesPerType: 10` → 50-card decks (Five-of-a-Kind still needs **5**, not 10).
- `swampRevealAll: true` → Bog becomes Thoughtseize (defender reveals the *whole*
  hand; the `bogReveal` step never fires).
- `blueDrawWhiteCloudshift: true` → Tide **draws** on enter (no scry); Meadow
  becomes **Cloudshift** (re-trigger one of your *other* lands in play).

### The `game` object (the bits you read)

```js
game.winner   // null until won, then { player: 0|1, condition: 'rainbow'|'five' }
game.awaiting // null when the game is over; otherwise the current decision (below)
game.active   // whose turn it is (0 | 1)
game.turn     // completed land-resolutions so far
game.firstPlayer
game.log      // [{ msg, kind, player?, type?, ... }] — human-readable history
```

### The `awaiting → action` contract

At every decision point `game.awaiting` is one of the shapes below. Reply with
the matching action. `action.player` is optional, but if present it must equal
`awaiting.player` or `apply` throws.

| `awaiting` shape | Legal action(s) |
| --- | --- |
| `{ kind:'mulligan', player }` — offered **only** when the hand is rules-dead | `{type:'mulligan', keep:boolean}` (`keep:false` performs the mulligan) |
| `{ kind:'playLand', player, options:[type...] }` | `{type:'playLand', card:type}` (`type` ∈ `options`) |
| `{ kind:'counter', player, cost, topCardType, landType }` | `{type:'counter'}` or `{type:'pass'}` |
| `{ kind:'scry', player, top:type }` | `{type:'scry', keep:boolean}` (`keep:false` buries the top card) |
| `{ kind:'forestReturn', player, options:[type...] }` | `{type:'forestReturn', card:type}` |
| `{ kind:'volcanoDestroy', player, target, options:[type...] }` | `{type:'volcanoDestroy', card:type}` |
| `{ kind:'bogReveal', player(=defender), attacker, handCount, count:3 }` | `{type:'bogReveal', cards:[t,t,t]}` (a 3-card multiset from your hand) |
| `{ kind:'bogDiscard', player(=attacker), defender, revealed:[type...] }` | `{type:'bogDiscard', card:type}` (`card` ∈ `revealed`) |
| `{ kind:'cloudshift', player, options:[type...] }` | `{type:'cloudshift', card:type}` |

`type` is always one of `'meadow' | 'forest' | 'volcano' | 'bog' | 'tide'` —
cards are fungible within a type, so actions reference *types*, never identities.

### Copy-paste: play a whole game with the built-in AI

```js
import { createGame, apply } from './src/engine.js';
import { chooseAction } from './src/ai.js';

const game = createGame({ seed: 7 });           // both seats are the CPU
while (game.awaiting && !game.winner) {
  const seat = game.awaiting.player;             // whoever must act now
  const action = chooseAction(game, seat);       // the heuristic AI's choice
  apply(game, action);                           // advance
}
console.log(game.winner);  // { player: 0|1, condition: 'rainbow'|'five' }
```

### Copy-paste: drive one seat with your own policy, AI the other

```js
import { createGame, apply, view, winFor } from './src/engine.js';
import { chooseAction } from './src/ai.js';

const MY_SEAT = 0;
const game = createGame({ seed: 1 });

function myPolicy(game) {
  const aw = game.awaiting;
  const v = view(game, MY_SEAT);                 // only what my seat may see
  if (aw.kind === 'playLand') {
    // e.g. prefer a land type I don't control yet (tempo-positive)
    const fresh = aw.options.find((t) => v.my.counts[t] === 0);
    return { type: 'playLand', card: fresh ?? aw.options[0] };
  }
  if (aw.kind === 'counter') {
    // only counter a land that would win the game for its owner
    const owner = game.pending.owner;
    const lethal = winFor([...game.players[owner].board, game.pending.landType]);
    return lethal ? { type: 'counter' } : { type: 'pass' };
  }
  // fall back to the built-in AI for the rest
  return chooseAction(game, MY_SEAT);
}

while (game.awaiting && !game.winner) {
  const seat = game.awaiting.player;
  apply(game, seat === MY_SEAT ? myPolicy(game) : chooseAction(game, seat));
}
```

### Handy helpers

- `winFor(board)` → `'rainbow' | 'five' | null` — pure board check.
- `distanceToWin(board)` → minimum land drops to a win (rainbow vs five, whichever is closer).
- `countByType(zone)` → `{ meadow, forest, volcano, bog, tide }` counts of any array.

---

## 2. The self-play CLI (`tests/play.mjs`)

Runs many deterministic AI-vs-AI games, asserting every one ends with a winner
inside a sane cap and never throws. Doubles as a fuzz/regression check (non-zero
exit on any failure) and as a single-game inspector.

```bash
node tests/play.mjs                      # batch: base config + every variant, 500 games each
node tests/play.mjs --games 2000         # more games per config
node tests/play.mjs --seed 7 --verbose   # full, human-readable move log of ONE game
node tests/play.mjs --seed 42            # run just that seed, print the result line
node tests/play.mjs --big                # copiesPerType:10 (50-card deck)
node tests/play.mjs --thoughtseize       # swampRevealAll (Bog reveals whole hand)
node tests/play.mjs --cloud              # blueDrawWhiteCloudshift
# flags combine, e.g.:
node tests/play.mjs --big --cloud --seed 3 --verbose
```

When you pass any variant flag, only that one config is run; otherwise the base
config plus each variant is swept. Batch output prints per-config stats: games,
fails, avg/max turns, rainbow-vs-five split, and first-vs-second win rate.

---

## 3. In-browser `window.blg` (drive the live UI)

`src/ui.js` mounts the same engine and exposes `window.blg`. Every method that
mutates also re-renders the board and (in vs-CPU mode) lets the CPU take its
turns, so the on-screen state always matches.

| Member | Returns / does |
| --- | --- |
| `window.blg.game` | The live `game` object (read `.awaiting`, `.winner`, `.log`, …). |
| `window.blg.view(seat?)` | `view(game, seat)`; defaults to the current decider's seat. |
| `window.blg.state()` | `fullState(game)` — omniscient snapshot. |
| `window.blg.apply(action)` | Applies the action, re-renders, lets the CPU continue, returns the new `game.awaiting`. |
| `window.blg.ai(seat?)` | `chooseAction(game, seat)`; defaults to the current decider. Does **not** apply. |
| `window.blg.step()` | Applies `chooseAction` for whoever must act now, re-renders, returns the new `awaiting`. Great for stepping the CPU. |
| `window.blg.options()` | `{ awaiting, legalActions }` — the current decision plus an enumerated list of legal action objects you can pick from directly. |
| `window.blg.newGame({ mode, config, seed, firstPlayer, names })` | Starts a fresh game (e.g. `mode:'cpu'`). |

### Copy-paste: play a full game in the browser via `agent-browser`

```bash
# Start a fresh seeded CPU-vs-CPU game, then step it to completion.
agent-browser eval '
  window.blg.newGame({ mode: "cpu", seed: 7 });
  let guard = 0;
  while (window.blg.game.awaiting && !window.blg.game.winner) {
    if (guard++ > 5000) throw new Error("loop guard");
    window.blg.step();            // applies the current decider chooseAction
  }
  window.blg.game.winner;         // trailing expression → eval's completion value
'
# → { player, condition }
```

### Copy-paste: inspect the current decision and pick a specific action

```bash
agent-browser eval 'window.blg.options()'
# → { awaiting: { kind:"playLand", player:0, options:[...] },
#     legalActions: [ { type:"playLand", card:"meadow" }, ... ] }

agent-browser eval 'window.blg.apply({ type:"playLand", card:"tide" })'
# → the new game.awaiting after the play (and any CPU response) resolves
```

> Tip: read `agent-browser skills get core --full` first for the ref/eval
> workflow. `window.blg.options().legalActions` is the safest source of valid
> actions — every entry is directly applyable.
>
> Note: `agent-browser eval` runs the snippet as an **expression**, so a
> top-level `return` is a syntax error. End the snippet with a bare expression
> (its value becomes the result), as shown above.

---

## Rules cheat-sheet (for writing policies)

- **Win:** Rainbow (≥1 of each of the 5 types in play) **or** Five-of-a-Kind (5
  copies of one type in play). No decking out — an empty deck reshuffles the
  discard pile back in.
- **Each turn:** draw 1 (except the very first turn of the game), then play one
  land from hand. Its enter-effect resolves, then the turn passes.
- **Land effects:** Meadow = draw 1 · Forest = return a card from your discard ·
  Volcano = destroy an opponent's land · Bog = opponent reveals 3 (or whole hand)
  and you pick one to discard · Tide = scry 1 on enter.
- **Force of Will:** a Tide *in hand* counters a land drop (pitch the Tide + a
  copy of the played land). Countering a Force of Will costs **2 Tides**. Net: a
  land resolves iff an **even** number of Force-of-Wills end up on the stack;
  when countered it goes to its owner's discard with **no effect** and the turn
  passes to the counterer.
- **Mulligan:** only a rules-dead opening hand is offered (`mulligan` awaiting).
  On the play: a hand of only volcanoes/forests. On the draw: an all-forest hand.
