# The Basic Land Game

A web implementation of **The Basic Land Game** — a community *Magic: The
Gathering* variant played using nothing but basic lands. Two-player
pass-and-play and vs-CPU, packaged as an installable, offline-capable PWA. No
framework, no build step: native ES modules, a tiny seeded state machine, and a
sprinkle of vanilla DOM.

The rules below follow the source video, **"How to play the Basic Land game"**:
<https://www.youtube.com/watch?v=icr40GWNScQ>

---

## What is it?

Each of the five basic land types is re-skinned as a recognizable Magic effect.
You build toward one of two win conditions by playing one land per turn, while
your opponent tries to do the same — and can pitch Islands as **Force of Will**
to counter your land drops. Cards are fungible within a type, so the whole game
is about *which type* you play, never *which copy*.

| Land | Emoji | MTG re-skin | Effect when it enters play |
| --- | --- | --- | --- |
| **Meadow** | 🌻 | Plains → Divination | Draw a card. |
| **Forest** | 🌲 | Forest → Regrowth | Return a card from your discard pile to hand. |
| **Volcano** | 🌋 | Mountain → Stone Rain | Destroy a land an opponent controls. |
| **Bog** | 💀 | Swamp → Blackmail | Opponent reveals 3 cards; you pick one for them to discard. |
| **Tide** | 🌊 | Island → Scry / Force of Will | Scry 1 on enter. *In hand:* counter a land drop. |

### How a turn works

1. **Draw** one card — except on the very first turn of the game.
2. **Play one land** from your hand. It does not resolve immediately (see Force
   of Will). Once it resolves, its enter-effect triggers, then the turn passes.

That's the entire action economy: one land drop per turn.

### Force of Will (the Tide counter war)

A **Tide held in hand** can counter an opponent's land drop: discard the Tide
plus a matching copy of the land being played. The counter is itself a spell (a
Tide), so it can be countered back by pitching **two Tides** — "force the
force" — and players alternate until someone passes.

Net rule: **a played land resolves iff an even number of Force-of-Wills end up
on the stack.** When a land is countered it goes to its owner's discard pile
with **no effect**, and the turn passes to the counterer. Every counter's cards
are paid (moved to discard) the moment it is declared.

### Mulligan

You may only mulligan a "dead" opening hand that the rules flag — the game
offers it automatically when eligible:

- **On the play** (first player): a hand of only Volcanoes and/or Forests.
- **On the draw** (second player): a hand of all Forests.

A mulligan reshuffles your hand into your deck and draws three fresh cards.

### Win conditions

- **Rainbow** — at least one of each of the five land types in play.
- **Five-of-a-Kind** — five copies of a single land type in play.

There is **no decking out**: when your deck runs empty it is refilled by
reshuffling your discard pile.

---

## Variants

Toggle these from the mode screen (or via `config`):

- **🃏 Big decks (`copiesPerType: 10`)** — 50-card decks instead of 25 (ten of
  each land). Five-of-a-Kind still needs **5** copies, just easier to assemble.
- **💀 Thoughtseize Bog (`swampRevealAll: true`)** — Bog makes the opponent
  reveal their *whole* hand (not just three) before you pick a card to discard.
- **🌊/🌻 Blue-draw / White-cloudshift (`blueDrawWhiteCloudshift: true`)** —
  Tide **draws** a card on enter instead of scrying; Meadow becomes
  **Cloudshift** and re-triggers one of your *other* lands in play.

---

## Running it

It's all static files served over HTTP (ES modules and the service worker need a
real `http(s)://` origin — opening `index.html` from `file://` won't register
the PWA).

```bash
# Option A: the bundled zero-dependency server (default port 8137)
node serve.mjs
# → open http://localhost:8137/

# Option B: any static server rooted at the project directory
npx serve .        # or python3 -m http.server, etc.
```

The landing page (`index.html`) links into the game (`game.html`); pick
pass-and-play or vs-CPU, choose variants, and play.

---

## Tests & self-play

The pure game logic has full unit coverage plus a deterministic self-play fuzz
harness.

```bash
# Unit + integration tests (node:test). Covers opening setup, draws/reshuffle,
# every land effect + its no-op, both win conditions, the Force-of-Will counter
# war, mulligan eligibility, and all three variants.
node --test          # or: npm test

# Self-play harness: many seeded AI-vs-AI games per config, asserting every game
# terminates with a winner and never throws. Prints aggregate stats.
node tests/play.mjs                      # base + every variant, 500 games each
node tests/play.mjs --seed 7 --verbose   # full move-by-move log of one game
node tests/play.mjs --big --cloud        # force specific variant(s)
node tests/play.mjs --games 2000         # more games per config
```

See **[AGENT.md](./AGENT.md)** for the full Node / `window.blg` automation API
and the `awaiting → action` contract.

---

## Architecture & file map

Clean, framework-free, and *smalltx-inspired*: a single deterministic state
machine drives everything through one `apply(game, action)` door, and the UI is
a thin renderer over it. The engine is pure (no DOM, no globals), so the exact
same code runs in the browser, in Node, and in the test suite.

| File | Role |
| --- | --- |
| `src/cards.js` | Single source of truth for the five lands: names, emojis, effect text. Pure data, imports nothing. |
| `src/engine.js` | The rules engine: seeded RNG, deck/draw, the `awaiting`/`apply` state machine, the counter war, win detection, and `view`/`fullState`. DOM-free. |
| `src/ai.js` | The heuristic CPU (`chooseAction(game, seat)`): tempo-positive land drops, hoard Tides for counters, pivot to Five-of-a-Kind when tall. |
| `src/ui.js` | Vanilla-DOM renderer and input handling; mounts the engine and exposes `window.blg` for automation. |
| `game.html` | The game screen (board, hand, log, overlays). |
| `index.html` | Landing page / launcher. |
| `styles.css` | Styling. |
| `serve.mjs` | Tiny zero-dependency static server with correct MIME types. |
| `manifest.webmanifest` | PWA manifest (installability). |
| `sw.js` | Service worker for offline play. |
| `icon-192.png`, `icon-512.png` | PWA icons. |
| `tests/engine.test.mjs` | `node:test` unit/integration suite. |
| `tests/play.mjs` | Deterministic self-play fuzz harness + single-game inspector. |

### The design contract in one sentence

> At every decision point the engine publishes `game.awaiting` (who must act and
> what is legal); the UI, the CPU AI, and the test harness all advance the game
> by handing a matching action to `apply(game, action)` — and because all
> randomness flows through one seeded RNG stored in the game, a `(seed, actions)`
> pair always replays to the identical game.
