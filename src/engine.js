// ---------------------------------------------------------------------------
// The Basic Land Game — engine
//
// A deterministic, framework-free, DOM-free state machine that implements the
// full rules of the Basic Land game (a community Magic: The Gathering variant).
//
// Design goals:
//   * Pure logic. No DOM, no globals — importable in the browser, Node, tests.
//   * Deterministic. All randomness flows through a seeded RNG stored in state,
//     so a (seed, action-list) pair always replays to the same game.
//   * One uniform driving interface. At every decision point the engine exposes
//     `game.awaiting` describing *who* must act and *what* choices are legal,
//     and `game.apply(action)` advances. The UI, the CPU AI, and the test
//     harness all drive the game through this single door.
//
// Cards are fungible within a type, so every zone (deck/hand/board/discard) is
// just an array of type-key strings ('meadow' | 'forest' | 'volcano' | 'bog' |
// 'tide'). Actions therefore reference land *types*, never card identities —
// which keeps the API tiny and friendly for both humans and agents.
// ---------------------------------------------------------------------------

import { TYPES, FIVE_OF_A_KIND } from './cards.js';

// ---- Seeded RNG (mulberry32) ----------------------------------------------
// Tiny, fast, deterministic. We keep the 32-bit state inside the game object so
// the whole game serializes/replays exactly.
function rngNext(game) {
  let t = (game.rng = (game.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle(game, arr) {
  // Fisher–Yates using the seeded RNG. Mutates and returns `arr`.
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rngNext(game) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- Config / variants -----------------------------------------------------
export const DEFAULT_CONFIG = {
  copiesPerType: 5, // 5 → 25-card deck; 10 → 50-card deck variant
  swampRevealAll: false, // Bog becomes Thoughtseize (reveal entire hand)
  blueDrawWhiteCloudshift: false, // Tide draws on enter; Meadow becomes Cloudshift
};

export function makeConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ---- Helpers ---------------------------------------------------------------
const other = (p) => (p === 0 ? 1 : 0);

function emptyPlayer(name) {
  return { name, deck: [], hand: [], board: [], discard: [] };
}

export function countByType(zone) {
  const c = { meadow: 0, forest: 0, volcano: 0, bog: 0, tide: 0 };
  for (const t of zone) c[t]++;
  return c;
}

function removeOne(zone, type) {
  const i = zone.indexOf(type);
  if (i === -1) return false;
  zone.splice(i, 1);
  return true;
}

// Win check for a player's board. Returns 'rainbow' | 'five' | null.
export function winFor(board) {
  const c = countByType(board);
  for (const t of TYPES) if (c[t] >= FIVE_OF_A_KIND) return 'five';
  if (TYPES.every((t) => c[t] >= 1)) return 'rainbow';
  return null;
}

// Minimum number of (uncountered) land drops a player needs to reach a win,
// ignoring what's actually in hand/deck. Used by the AI and by "win progress"
// displays. Returns the smaller of the rainbow- and five-distances.
export function distanceToWin(board) {
  const c = countByType(board);
  const rainbow = TYPES.reduce((n, t) => n + (c[t] >= 1 ? 0 : 1), 0);
  let five = Infinity;
  for (const t of TYPES) five = Math.min(five, FIVE_OF_A_KIND - Math.min(c[t], FIVE_OF_A_KIND));
  return Math.min(rainbow, five);
}

// ---- Deck construction & draw ---------------------------------------------
function buildDeck(game, copies) {
  const deck = [];
  for (const t of TYPES) for (let i = 0; i < copies; i++) deck.push(t);
  return shuffle(game, deck);
}

// Draw one card for player `p`. If the deck is empty, shuffle the discard pile
// back in first (no decking-out in this game). Returns the drawn type or null.
function drawCard(game, p) {
  const pl = game.players[p];
  if (pl.deck.length === 0) {
    if (pl.discard.length === 0) return null; // nothing anywhere to draw
    pl.deck = shuffle(game, pl.discard);
    pl.discard = [];
    log(game, `${pl.name} reshuffles their discard pile into their deck.`, { kind: 'reshuffle', player: p });
  }
  const card = pl.deck.shift();
  pl.hand.push(card);
  return card;
}

// ---- Logging ---------------------------------------------------------------
function log(game, msg, data = {}) {
  game.log.push({ msg, ...data });
}

// ---------------------------------------------------------------------------
// Game creation
// ---------------------------------------------------------------------------
// opts: { seed, config, firstPlayer, names: [a, b] }
export function createGame(opts = {}) {
  const config = makeConfig(opts.config);
  const game = {
    config,
    rng: (opts.seed ?? 1) >>> 0,
    seed: (opts.seed ?? 1) >>> 0,
    players: [emptyPlayer((opts.names && opts.names[0]) || 'Player 1'),
              emptyPlayer((opts.names && opts.names[1]) || 'Player 2')],
    active: 0,
    firstPlayer: 0,
    turn: 0, // counts completed land-resolutions for flavor / first-turn skip
    firstDrawSkipped: false,
    awaiting: null, // { kind, player, ...payload }
    pending: null, // counter-war scratch
    bog: null, // blackmail scratch
    flicker: null, // cloudshift scratch
    log: [],
    winner: null, // { player, condition } once decided
  };

  // Decide first player (random unless forced).
  game.firstPlayer = opts.firstPlayer != null ? opts.firstPlayer : (rngNext(game) < 0.5 ? 0 : 1);
  game.active = game.firstPlayer;

  // Build & shuffle decks, draw opening hands of three.
  for (let p = 0; p < 2; p++) {
    game.players[p].deck = buildDeck(game, config.copiesPerType);
    for (let i = 0; i < 3; i++) drawCard(game, p);
  }
  log(game, `${game.players[game.firstPlayer].name} goes first.`, { kind: 'start' });

  // Enter the mulligan phase (first player first, then second player).
  game.mulliganQueue = [game.firstPlayer, other(game.firstPlayer)];
  advanceMulligan(game);
  return game;
}

// ---- Mulligan phase --------------------------------------------------------
// Eligibility per the rules:
//   * On the play (first player): may mull a hand of only mountains/forests
//     (here: only volcano and/or forest, i.e. nothing that does anything).
//   * On the draw (second player): may mull a hand of all forests.
export function mulliganEligible(game, p) {
  const hand = game.players[p].hand;
  if (hand.length === 0) return false;
  if (p === game.firstPlayer) {
    return hand.every((t) => t === 'volcano' || t === 'forest');
  }
  return hand.every((t) => t === 'forest');
}

function advanceMulligan(game) {
  while (game.mulliganQueue.length) {
    const p = game.mulliganQueue[0];
    if (mulliganEligible(game, p)) {
      game.awaiting = { kind: 'mulligan', player: p };
      return;
    }
    game.mulliganQueue.shift(); // not eligible → auto-keep, move on
  }
  // Mulligans resolved → start the first turn (no draw on the very first turn).
  game.mulliganQueue = null;
  game.firstDrawSkipped = true;
  beginTurn(game, /*skipDraw*/ true);
}

function doMulligan(game, p) {
  const pl = game.players[p];
  pl.deck.push(...pl.hand);
  pl.hand = [];
  shuffle(game, pl.deck);
  for (let i = 0; i < 3; i++) drawCard(game, p);
  log(game, `${pl.name} mulligans a dead hand.`, { kind: 'mulligan', player: p });
}

// ---- Turn lifecycle --------------------------------------------------------
function beginTurn(game, skipDraw = false) {
  const p = game.active;
  if (!skipDraw) {
    const c = drawCard(game, p);
    if (c) log(game, `${game.players[p].name} draws for the turn.`, { kind: 'draw', player: p });
  }
  // The only action: play a land from hand.
  game.awaiting = { kind: 'playLand', player: p, options: legalPlays(game, p) };
}

function legalPlays(game, p) {
  // The distinct land types the player can put into play this turn.
  return [...new Set(game.players[p].hand)];
}

function endTurnAdvance(game) {
  if (game.winner) {
    game.awaiting = null;
    return;
  }
  game.turn++;
  game.active = other(game.active);
  beginTurn(game, false);
}

// ---------------------------------------------------------------------------
// Playing a land → the Force-of-Will counter war
// ---------------------------------------------------------------------------
// When the active player plays a land, it does not immediately resolve. The
// opponent may counter it by pitching a Tide + a matching land (Force of Will).
// That counter is itself a land (a Tide) and so can be countered back by
// pitching two Tides ("force the force"), alternating until someone passes.
//
// Net rule: the original land resolves iff an EVEN number of Force-of-Wills end
// up on the stack. Each counter's cards are paid (moved to discard) when it is
// declared, exactly like paying a spell's cost.

function startPlayLand(game, p, type) {
  const pl = game.players[p];
  if (!removeOne(pl.hand, type)) throw new Error(`cannot play ${type}: not in hand`);
  log(game, `${pl.name} plays ${type}.`, { kind: 'play', player: p, type });
  game.pending = {
    owner: p,
    landType: type,
    fowCount: 0,
    // The card currently on top of the stack that an opponent would counter.
    // Initially the land itself; after a Force of Will it becomes a Tide.
    topCardType: type,
    responder: other(p),
  };
  promptCounter(game);
}

// What a counter costs the responder: 1 Tide + 1 copy of the top card's type.
// If the top card is itself a Tide, that means two Tides.
function counterCost(topCardType) {
  if (topCardType === 'tide') return { tide: 2 };
  return { tide: 1, [topCardType]: 1 };
}

function canPay(hand, cost) {
  const have = countByType(hand);
  return Object.entries(cost).every(([t, n]) => have[t] >= n);
}

function promptCounter(game) {
  const pend = game.pending;
  const responder = pend.responder;
  const cost = counterCost(pend.topCardType);
  if (canPay(game.players[responder].hand, cost)) {
    game.awaiting = { kind: 'counter', player: responder, cost, topCardType: pend.topCardType, landType: pend.landType };
  } else {
    // Responder cannot counter → treat as a pass and resolve.
    resolveCounterWar(game);
  }
}

function declareCounter(game) {
  const pend = game.pending;
  const responder = pend.responder;
  const cost = counterCost(pend.topCardType);
  const hand = game.players[responder].hand;
  const disc = game.players[responder].discard;
  for (const [t, n] of Object.entries(cost)) {
    for (let i = 0; i < n; i++) {
      removeOne(hand, t);
      disc.push(t);
    }
  }
  pend.fowCount++;
  pend.topCardType = 'tide'; // the thing now on top is the Force of Will (a Tide)
  log(game, `${game.players[responder].name} counters with Force of Will (Tide).`, {
    kind: 'counter', player: responder,
  });
  // Priority passes to the other player, who may "force the force".
  pend.responder = other(responder);
  promptCounter(game);
}

function resolveCounterWar(game) {
  const pend = game.pending;
  const owner = pend.owner;
  const type = pend.landType;
  game.pending = null;
  if (pend.fowCount % 2 === 1) {
    // Countered: the land never enters; it goes to its owner's discard pile.
    game.players[owner].discard.push(type);
    log(game, `${game.players[owner].name}'s ${type} is countered and discarded.`, {
      kind: 'countered', player: owner, type,
    });
    finishLandResolution(game); // no effect; just end the turn
    return;
  }
  // Resolves: enters the battlefield, then triggers its effect.
  game.players[owner].board.push(type);
  log(game, `${game.players[owner].name}'s ${type} resolves and enters play.`, {
    kind: 'enter', player: owner, type,
  });
  triggerEnterEffect(game, owner, type);
}

// ---------------------------------------------------------------------------
// Land enter-effects
// ---------------------------------------------------------------------------
// Each may either resolve immediately or open a sub-decision (`awaiting`). When
// fully resolved, every path funnels through finishLandResolution().

function triggerEnterEffect(game, p, type) {
  const cfg = game.config;
  switch (type) {
    case 'meadow':
      if (cfg.blueDrawWhiteCloudshift) return effectCloudshift(game, p);
      return effectDraw(game, p);
    case 'tide':
      if (cfg.blueDrawWhiteCloudshift) return effectDraw(game, p);
      return effectScry(game, p);
    case 'forest':
      return effectForest(game, p);
    case 'volcano':
      return effectVolcano(game, p);
    case 'bog':
      return effectBog(game, p);
    default:
      return finishLandResolution(game);
  }
}

function effectDraw(game, p) {
  const c = drawCard(game, p);
  if (c) log(game, `${game.players[p].name} draws a card.`, { kind: 'effect-draw', player: p });
  finishLandResolution(game);
}

function effectScry(game, p) {
  const pl = game.players[p];
  if (pl.deck.length === 0 && pl.discard.length > 0) {
    pl.deck = shuffle(game, pl.discard);
    pl.discard = [];
  }
  if (pl.deck.length === 0) {
    finishLandResolution(game); // nothing to scry
    return;
  }
  game.awaiting = { kind: 'scry', player: p, top: pl.deck[0] };
}

function effectForest(game, p) {
  const pl = game.players[p];
  if (pl.discard.length === 0) {
    log(game, `${pl.name}'s Forest finds an empty discard pile.`, { kind: 'effect-forest-empty', player: p });
    finishLandResolution(game);
    return;
  }
  game.awaiting = { kind: 'forestReturn', player: p, options: [...new Set(pl.discard)] };
}

function effectVolcano(game, p) {
  const opp = other(p);
  if (game.players[opp].board.length === 0) {
    log(game, `${game.players[p].name}'s Volcano has no target.`, { kind: 'effect-volcano-empty', player: p });
    finishLandResolution(game);
    return;
  }
  game.awaiting = { kind: 'volcanoDestroy', player: p, target: opp, options: [...new Set(game.players[opp].board)] };
}

function effectBog(game, p) {
  const opp = other(p);
  const oppHand = game.players[opp].hand;
  if (oppHand.length === 0) {
    log(game, `${game.players[p].name}'s Bog finds an empty hand.`, { kind: 'effect-bog-empty', player: p });
    finishLandResolution(game);
    return;
  }
  const revealAll = game.config.swampRevealAll || oppHand.length <= 3;
  if (revealAll) {
    game.bog = { attacker: p, defender: opp, revealed: [...oppHand] };
    game.awaiting = { kind: 'bogDiscard', player: p, defender: opp, revealed: [...oppHand] };
  } else {
    // Defender chooses which 3 cards to reveal.
    game.bog = { attacker: p, defender: opp, revealed: null };
    game.awaiting = { kind: 'bogReveal', player: opp, attacker: p, handCount: oppHand.length, count: 3 };
  }
}

function effectCloudshift(game, p) {
  // Re-trigger one of the player's OTHER lands already in play.
  const pl = game.players[p];
  const board = pl.board;
  const targets = {};
  for (const t of board) targets[t] = (targets[t] || 0) + 1;
  // Exclude one copy of the Meadow that is doing the flickering ("this").
  targets.meadow = (targets.meadow || 0) - 1;
  // Exclude every land already flickered earlier in this Cloudshift chain. This
  // keeps the chain finite (a Cloudshift can re-trigger another Meadow's
  // Cloudshift, but never the same permanents twice), so it always terminates.
  if (game.flicker && game.flicker.used) {
    for (const [t, n] of Object.entries(game.flicker.used)) {
      targets[t] = (targets[t] || 0) - n;
    }
  }
  const options = Object.keys(targets).filter((t) => targets[t] > 0);
  if (options.length === 0) {
    log(game, `${pl.name}'s Cloudshift has nothing else to flicker.`, { kind: 'effect-cloudshift-empty', player: p });
    finishLandResolution(game);
    return;
  }
  game.awaiting = { kind: 'cloudshift', player: p, options };
}

// ---------------------------------------------------------------------------
// Finishing a land resolution: win check, then pass the turn.
// ---------------------------------------------------------------------------
function finishLandResolution(game) {
  // If we are mid-flicker (Cloudshift), return to finish the Meadow's turn.
  if (game.flicker) {
    const wasFlicker = game.flicker;
    game.flicker = null;
    log(game, `${game.players[wasFlicker.player].name}'s Cloudshift re-triggered ${wasFlicker.type}.`, {
      kind: 'cloudshift-done', player: wasFlicker.player, type: wasFlicker.type,
    });
    // fall through to win check for the cloudshifting player
  }
  const p = game.active;
  const cond = winFor(game.players[p].board);
  if (cond) {
    game.winner = { player: p, condition: cond };
    log(game, `${game.players[p].name} wins by ${cond === 'rainbow' ? 'Rainbow (one of each land)' : 'Five of a Kind'}!`, {
      kind: 'win', player: p, condition: cond,
    });
    game.awaiting = null;
    return;
  }
  endTurnAdvance(game);
}

// ---------------------------------------------------------------------------
// The single public entry point: apply an action against `game.awaiting`.
// ---------------------------------------------------------------------------
export function apply(game, action) {
  const aw = game.awaiting;
  if (game.winner) throw new Error('game is over');
  if (!aw) throw new Error('nothing is awaiting input');
  if (action.player != null && action.player !== aw.player) {
    throw new Error(`it is ${aw.player}'s decision, not ${action.player}'s`);
  }

  switch (aw.kind) {
    case 'mulligan': {
      if (action.type !== 'mulligan') throw new Error('expected mulligan action');
      if (action.keep) {
        game.mulliganQueue.shift();
      } else {
        doMulligan(game, aw.player);
        // If still eligible the same player may mulligan again; otherwise move on.
        if (!mulliganEligible(game, aw.player)) game.mulliganQueue.shift();
      }
      advanceMulligan(game);
      return game;
    }

    case 'playLand': {
      if (action.type !== 'playLand') throw new Error('expected playLand action');
      if (!game.players[aw.player].hand.includes(action.card)) {
        throw new Error(`cannot play ${action.card}: not in hand`);
      }
      startPlayLand(game, aw.player, action.card);
      return game;
    }

    case 'counter': {
      if (action.type === 'counter') declareCounter(game);
      else if (action.type === 'pass') resolveCounterWar(game);
      else throw new Error('expected counter or pass');
      return game;
    }

    case 'scry': {
      if (action.type !== 'scry') throw new Error('expected scry action');
      const pl = game.players[aw.player];
      const top = pl.deck.shift();
      if (action.keep) {
        pl.deck.unshift(top);
        log(game, `${pl.name} keeps the top card.`, { kind: 'scry-keep', player: aw.player });
      } else {
        pl.deck.push(top);
        log(game, `${pl.name} buries the top card.`, { kind: 'scry-bury', player: aw.player });
      }
      finishLandResolution(game);
      return game;
    }

    case 'forestReturn': {
      if (action.type !== 'forestReturn') throw new Error('expected forestReturn action');
      const pl = game.players[aw.player];
      if (!removeOne(pl.discard, action.card)) throw new Error(`${action.card} not in discard`);
      pl.hand.push(action.card);
      log(game, `${pl.name} returns ${action.card} from the discard pile.`, {
        kind: 'forest-return', player: aw.player, type: action.card,
      });
      finishLandResolution(game);
      return game;
    }

    case 'volcanoDestroy': {
      if (action.type !== 'volcanoDestroy') throw new Error('expected volcanoDestroy action');
      const tgt = game.players[aw.target];
      if (!removeOne(tgt.board, action.card)) throw new Error(`${action.card} not on opponent board`);
      tgt.discard.push(action.card);
      log(game, `${game.players[aw.player].name} destroys ${tgt.name}'s ${action.card}.`, {
        kind: 'volcano-destroy', player: aw.player, target: aw.target, type: action.card,
      });
      finishLandResolution(game);
      return game;
    }

    case 'bogReveal': {
      if (action.type !== 'bogReveal') throw new Error('expected bogReveal action');
      const defender = aw.player;
      const hand = game.players[defender].hand;
      const reveal = action.cards.slice();
      if (reveal.length !== aw.count) throw new Error(`must reveal exactly ${aw.count} cards`);
      // Validate the revealed multiset is actually in hand.
      const tmp = [...hand];
      for (const t of reveal) if (!removeOne(tmp, t)) throw new Error(`cannot reveal ${t}: not in hand`);
      game.bog.revealed = reveal;
      log(game, `${game.players[defender].name} reveals ${reveal.join(', ')}.`, {
        kind: 'bog-reveal', player: defender, cards: reveal,
      });
      game.awaiting = { kind: 'bogDiscard', player: game.bog.attacker, defender, revealed: [...reveal] };
      return game;
    }

    case 'bogDiscard': {
      if (action.type !== 'bogDiscard') throw new Error('expected bogDiscard action');
      const { defender } = game.bog;
      if (!game.bog.revealed.includes(action.card)) throw new Error(`${action.card} was not revealed`);
      const dpl = game.players[defender];
      if (!removeOne(dpl.hand, action.card)) throw new Error(`${action.card} not in hand`);
      dpl.discard.push(action.card);
      log(game, `${game.players[game.bog.attacker].name} makes ${dpl.name} discard ${action.card}.`, {
        kind: 'bog-discard', player: game.bog.attacker, target: defender, type: action.card,
      });
      game.bog = null;
      finishLandResolution(game);
      return game;
    }

    case 'cloudshift': {
      if (action.type !== 'cloudshift') throw new Error('expected cloudshift action');
      const p = aw.player;
      if (!aw.options.includes(action.card)) throw new Error(`cannot flicker ${action.card}`);
      // Re-trigger the chosen land's enter-effect. The board is unchanged
      // (flicker out and back in), so this only re-runs the effect.
      // Accumulate the chain of lands flickered so far so that a Cloudshift that
      // re-triggers another Cloudshift can never revisit the same permanents
      // (this bounds the chain and guarantees the turn always terminates).
      const used = (game.flicker && game.flicker.used) || {};
      used[action.card] = (used[action.card] || 0) + 1;
      game.flicker = { player: p, type: action.card, used };
      log(game, `${game.players[p].name} flickers ${action.card}.`, { kind: 'cloudshift', player: p, type: action.card });
      triggerEnterEffect(game, p, action.card);
      return game;
    }

    default:
      throw new Error(`unknown awaiting kind: ${aw.kind}`);
  }
}

// ---------------------------------------------------------------------------
// Views — what a given seat is allowed to know. The engine itself is omniscient;
// the UI and AI consume `view(game, p)` so hidden information stays hidden.
// ---------------------------------------------------------------------------
export function view(game, p) {
  const me = game.players[p];
  const opp = game.players[other(p)];
  return {
    config: game.config,
    me: p,
    opponent: other(p),
    active: game.active,
    firstPlayer: game.firstPlayer,
    turn: game.turn,
    winner: game.winner,
    awaiting: game.awaiting,
    names: [game.players[0].name, game.players[1].name],
    my: {
      hand: [...me.hand],
      board: [...me.board],
      discard: [...me.discard],
      deckCount: me.deck.length,
      counts: countByType(me.board),
      distance: distanceToWin(me.board),
    },
    their: {
      handCount: opp.hand.length,
      board: [...opp.board],
      discard: [...opp.discard],
      deckCount: opp.deck.length,
      counts: countByType(opp.board),
      distance: distanceToWin(opp.board),
    },
    log: game.log,
  };
}

// Convenience for tests/agents that want a snapshot of everything.
export function fullState(game) {
  return {
    config: game.config,
    active: game.active,
    firstPlayer: game.firstPlayer,
    turn: game.turn,
    winner: game.winner,
    awaiting: game.awaiting,
    players: game.players.map((pl) => ({
      name: pl.name,
      hand: [...pl.hand],
      board: [...pl.board],
      discard: [...pl.discard],
      deck: [...pl.deck],
    })),
    log: game.log,
  };
}

export { other, FIVE_OF_A_KIND, TYPES };
