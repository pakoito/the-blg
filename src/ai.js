// ---------------------------------------------------------------------------
// The Basic Land Game — CPU strategy
//
// A heuristic opponent that plays the strategy laid out in the source video:
//
//   * Tempo is everything. A land you don't already control advances you toward
//     victory (tempo-positive); a redundant land usually does not (tempo-negative).
//     Prefer tempo-positive plays.
//   * Tides (Islands) are the strongest card precisely because, held in hand as
//     a Force of Will, they protect you for free. So: never spend your land drop
//     on a Tide unless it literally completes your win or you have no other play.
//   * Hold your Tides to counter the opponent's *winning* land drop — and keep a
//     matching land in hand to pay for it.
//   * Volcano (Stone Rain) and Bog (Blackmail) are interactive: the first one is
//     tempo-positive, extra copies are tempo-negative, so pick your spots.
//   * Forest (Regrowth) is a late-game tutor — rebuy whatever land plugs a hole.
//   * Default to Rainbow (one-of-each); pivot to Five-of-a-Kind when you already
//     have a tall stack and the copies are within reach.
//
// The AI only ever reads information a real player at its seat could know: its
// own hand plus all public zones (boards, discard piles, counts) and anything an
// opponent has revealed. It never peeks at the opponent's hidden hand.
//
// Entry point: chooseAction(game, seat) → an action object for game.apply().
// ---------------------------------------------------------------------------

import { winFor, distanceToWin, countByType, other, TYPES } from './engine.js';

const FIVE = 5;

// How much we'd like to KEEP a given card, from the perspective of the player
// who owns `board`. Higher = more precious. Used for scry / forest / blackmail.
function keepValue(type, board, ctx = {}) {
  const counts = countByType(board);
  let v = 0;
  if (type === 'tide') v += 100; // protection + flexible win piece — hoard these
  if (counts[type] === 0) v += 40; // a land type we don't yet control = Rainbow piece
  // five-of-a-kind pivot: a card that extends our tallest stack toward 5
  if (counts[type] >= 3 && counts[type] < FIVE) v += 25 + counts[type];
  // interactive lands keep some baseline value for disruption
  if (type === 'volcano') v += 12;
  if (type === 'bog') v += 10;
  if (type === 'meadow') v += 14; // card advantage is always welcome
  if (type === 'forest') v += 8;
  return v;
}

// ---- Main land-drop decision ----------------------------------------------
function choosePlay(game, p) {
  const me = game.players[p];
  const opp = game.players[other(p)];
  const myBoard = me.board;
  const myCounts = countByType(myBoard);
  const oppDistance = distanceToWin(opp.board);
  const options = [...new Set(me.hand)];
  const tideInHand = me.hand.filter((t) => t === 'tide').length;

  // 1) Immediate winning land drop — always take it. If several win, prefer one
  //    we can back up with a Force of Will (we hold a spare Tide besides any we'd
  //    play), and prefer not to spend a Tide to win when another land also wins.
  const wins = options.filter((t) => winFor([...myBoard, t]));
  if (wins.length) {
    const nonTideWin = wins.filter((t) => t !== 'tide');
    const pool = nonTideWin.length ? nonTideWin : wins;
    // Prefer the win we can protect: one that leaves us holding ≥1 Tide afterwards.
    pool.sort((a, b) => protectScore(me.hand, b) - protectScore(me.hand, a));
    return pool[0];
  }

  // 2) Score every legal play. Tempo-positive (a type we don't control yet) is
  //    the backbone; everything else is contextual.
  let best = null;
  let bestScore = -Infinity;
  for (const t of options) {
    const s = playScore(t, { me, opp, myCounts, oppDistance, tideInHand, options, config: game.config });
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best;
}

// Does playing `winType` still leave us a Tide in hand to protect the win?
function protectScore(hand, winType) {
  const tides = hand.filter((t) => t === 'tide').length;
  const left = winType === 'tide' ? tides - 1 : tides;
  return left >= 1 ? 1 : 0;
}

// CLOUD VARIANT only: the value of playing a Meadow (Cloudshift), measured by the
// best enter-effect we could re-trigger among the lands we already control. The
// just-played Meadow itself is excluded by the engine, so a second Meadow can
// still chain another flicker.
function cloudshiftValue(myCounts, me, opp) {
  let best = 0;
  if (myCounts.tide >= 1) best = Math.max(best, 40);                              // re-draw
  if (myCounts.volcano >= 1 && opp.board.length > 0) best = Math.max(best, 45);   // re-destroy
  if (myCounts.forest >= 1 && me.discard.length > 0) best = Math.max(best, 35);   // re-rebuy
  if (myCounts.bog >= 1 && opp.hand.length > 0) best = Math.max(best, 30);        // re-strip
  if (myCounts.meadow >= 2) best = Math.max(best, 28);                            // chain a flicker
  return best;
}

function playScore(t, ctx) {
  const { me, opp, myCounts, oppDistance, tideInHand, options, config } = ctx;
  const cloud = config && config.blueDrawWhiteCloudshift;
  const tempoPositive = myCounts[t] === 0;
  let s = tempoPositive ? 100 : 0; // the central rule: tempo-positive lands lead

  switch (t) {
    case 'tide':
      if (cloud) {
        // CLOUD VARIANT — Tide DRAWS a card on enter, so don't hoard it. Keep a
        // Force-of-Will reserve (two Tides when the opponent is within striking
        // distance, so we can counter or "force the force"); spend the rest as
        // card-advantage plays. The +25-when-spare nudge is what tips us into
        // leading with the drawing Tide early, which compounds into faster wins.
        const reserve = oppDistance <= 2 ? 2 : 0;
        const spare = tideInHand - reserve;
        if (tempoPositive) s = 100 + (spare >= 1 ? 25 : 0); // a fresh Rainbow piece that also draws
        else if (spare >= 1) s = 55;                         // redundant, but still draws a card
        else s = -200 + (options.length === 1 ? 400 : 0);    // last Tide while threatened → hold it
        break;
      }
      // Base game: hold Tides for counters; only play one as a last resort.
      s = -200 + (options.length === 1 ? 400 : 0);
      if (tempoPositive) s += 30; // a Rainbow piece we lack — nudge up, still below real plays
      break;
    case 'meadow':
      if (cloud) {
        // CLOUD VARIANT — Meadow is Cloudshift (re-trigger a land), not a draw.
        // Value it by the best re-trigger actually available on our board; a lone
        // Meadow with nothing useful to flicker is correctly cheap.
        s += (tempoPositive ? 18 : 0) + cloudshiftValue(myCounts, me, opp);
        break;
      }
      // Base game: draw is great early and even a redundant Meadow refills the hand.
      s += tempoPositive ? 35 : 18;
      break;
    case 'forest': {
      // Regrowth shines when the discard pile holds something we want.
      const disc = new Set(me.discard);
      const wantsBack = me.discard.some((d) => myCounts[d] === 0) || disc.has('tide');
      s += (tempoPositive ? 20 : 0) + (wantsBack ? 22 : 2);
      break;
    }
    case 'volcano': {
      const firstVolcano = myCounts.volcano === 0;
      const hasTarget = opp.board.length > 0;
      // First Volcano with a target is strong; redundant Volcanoes only matter if
      // the opponent is about to win and we can set them back.
      if (firstVolcano && hasTarget) s += 30;
      else if (hasTarget && oppDistance <= 1) s += 24; // emergency interaction
      else if (hasTarget) s += 6;
      break;
    }
    case 'bog': {
      const firstBog = myCounts.bog === 0;
      const worthStripping = opp.hand.length > 0 && oppDistance <= 2;
      // Blackmail is best right before our winning turn, to poke a hole in their
      // ability to counter us.
      if (firstBog) s += 16;
      if (worthStripping) s += 20;
      break;
    }
    default:
      break;
  }

  // Five-of-a-kind pivot: if we already have a tall stack, redundant copies of it
  // start to matter again.
  if (myCounts[t] >= 3 && myCounts[t] < FIVE) s += 30 + myCounts[t] * 5;

  return s;
}

// ---- Force of Will: when to counter ---------------------------------------
// Faithful, disciplined rule: only ever spend Tides to stop a land that would
// WIN the game for its owner — whether that's blocking the opponent's lethal
// drop, or forcing through your own lethal drop that they tried to counter. The
// engine only asks when we can actually pay, so we just decide on lethality.
function chooseCounter(game, p) {
  const pend = game.pending;
  const owner = pend.owner;
  const lethal = winFor([...game.players[owner].board, pend.landType]);
  return lethal ? { type: 'counter' } : { type: 'pass' };
}

// ---- Sub-decisions ---------------------------------------------------------
function chooseScry(game, p) {
  const me = game.players[p];
  const top = me.deck[0];
  const counts = countByType(me.board);
  const tidesInHand = me.hand.filter((t) => t === 'tide').length;
  // Keep it if it advances Rainbow, gives us protection, or feeds a pivot stack.
  const keep =
    counts[top] === 0 ||
    (top === 'tide' && tidesInHand < 2) ||
    (counts[top] >= 3 && counts[top] < FIVE);
  return { type: 'scry', keep };
}

function chooseForestReturn(game, p) {
  const me = game.players[p];
  const opp = game.players[other(p)];
  const options = [...new Set(me.discard)];
  const tidesInHand = me.hand.filter((t) => t === 'tide').length;
  const oppDistance = distanceToWin(opp.board);
  // Shore up Island coverage first if we're exposed; else rebuy a Rainbow piece.
  options.sort((a, b) => forestRank(b) - forestRank(a));
  function forestRank(t) {
    let v = keepValue(t, me.board);
    if (t === 'tide' && tidesInHand < 1 && oppDistance <= 2) v += 60; // plug a hole in coverage
    return v;
  }
  return { type: 'forestReturn', card: options[0] };
}

function chooseVolcano(game, p) {
  const opp = game.players[other(p)];
  const options = [...new Set(opp.board)];
  const before = distanceToWin(opp.board);
  // Destroy the land that sets the opponent back the most; break ties by sparing
  // Meadows (often correct to let Plains live) and hitting their taller stacks.
  let best = options[0];
  let bestScore = -Infinity;
  for (const t of options) {
    const reduced = [...opp.board];
    reduced.splice(reduced.indexOf(t), 1);
    const setback = distanceToWin(reduced) - before;
    const oppCounts = countByType(opp.board);
    let score = setback * 100;
    if (t !== 'meadow') score += 5;
    score += oppCounts[t]; // chip their tallest stack on ties
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return { type: 'volcanoDestroy', card: best };
}

function chooseBogReveal(game, p) {
  // We are the defender: reveal our three LEAST valuable cards, hiding Tides and
  // anything we still need to win.
  const me = game.players[p];
  const sorted = [...me.hand].sort((a, b) => keepValue(a, me.board) - keepValue(b, me.board));
  return { type: 'bogReveal', cards: sorted.slice(0, 3) };
}

function chooseBogDiscard(game, p) {
  // We are the attacker: strip the opponent's most valuable revealed card —
  // ideally a Tide (their counter) or a land that completes their Rainbow.
  const aw = game.awaiting;
  const defender = aw.defender;
  const oppBoard = game.players[defender].board;
  const revealed = [...new Set(aw.revealed)];
  revealed.sort((a, b) => keepValue(b, oppBoard) - keepValue(a, oppBoard));
  return { type: 'bogDiscard', card: revealed[0] };
}

function chooseCloudshift(game, p) {
  // Re-trigger the most impactful of our other lands.
  const me = game.players[p];
  const opp = game.players[other(p)];
  const options = game.awaiting.options;
  function rank(t) {
    if (t === 'volcano') return opp.board.length ? 90 : 5;
    if (t === 'bog') return opp.hand.length ? 70 : 5;
    if (t === 'tide') return 60; // draw (in this variant) — pure value
    if (t === 'meadow') return 55; // chains another flicker
    if (t === 'forest') return me.discard.length ? 50 : 5;
    return 10;
  }
  const best = [...options].sort((a, b) => rank(b) - rank(a))[0];
  return { type: 'cloudshift', card: best };
}

// ---- Dispatcher ------------------------------------------------------------
export function chooseAction(game, seat) {
  const aw = game.awaiting;
  if (!aw || aw.player !== seat) throw new Error('not this seat\'s decision');
  switch (aw.kind) {
    case 'mulligan':
      // The engine only offers a mulligan on a hand the rules deem dead, so take it.
      return { type: 'mulligan', keep: false };
    case 'playLand':
      return { type: 'playLand', card: choosePlay(game, seat) };
    case 'counter':
      return chooseCounter(game, seat);
    case 'scry':
      return chooseScry(game, seat);
    case 'forestReturn':
      return chooseForestReturn(game, seat);
    case 'volcanoDestroy':
      return chooseVolcano(game, seat);
    case 'bogReveal':
      return chooseBogReveal(game, seat);
    case 'bogDiscard':
      return chooseBogDiscard(game, seat);
    case 'cloudshift':
      return chooseCloudshift(game, seat);
    default:
      throw new Error(`AI has no policy for ${aw.kind}`);
  }
}

export { keepValue };
