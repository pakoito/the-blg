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

// Count copies of `type` across the named zones of our own player. Used to track,
// across all the zones a real player can see, how many copies of a stack we have
// already collected when weighing the Five-of-a-Kind pivot.
function countIn(me, type, zones) {
  let n = 0;
  for (const z of zones) for (const t of me[z]) if (t === type) n++;
  return n;
}

// Five-of-a-Kind pivot bonus for a redundant copy of `type`. Only a genuine pivot
// (board height >= 3, below five) earns anything. The base lean grows with the
// stack height; then we sharpen it with copies we can actually see:
//
//   * inReach = board + hand copies — playable without help.
//   * gathered = board + hand + discard copies — discard is recoverable via
//     Forest / reshuffle, so a fully-gathered stack means the five is live.
//
// When the five-race is no longer than the Rainbow race AND every copy we still
// need is already in hand+board, we commit hard enough to race the five past a
// tempo-positive Rainbow piece (which scores 100): finishing the strictly shorter
// race wins sooner.
function pivotBonus(me, type, onBoard, rainbowDist) {
  if (onBoard < 3 || onBoard >= FIVE) return 0;
  let b = 30 + onBoard * 5; // preserve the reference's base lean
  const inReach = countIn(me, type, ['board', 'hand']);
  const gathered = inReach + countIn(me, type, ['discard']);
  if (gathered >= FIVE) b += 6; // the five is guaranteed somewhere recoverable
  if ((FIVE - onBoard) <= rainbowDist && inReach >= FIVE) b += 80; // commit & race
  return b;
}

// Public-information read of how many Tides the opponent could still be hiding
// (in hand or deck). Every zone is fungible arrays of type-keys, and the total
// number of Tides in the game equals copiesPerType. We can SEE the opponent's
// board and discard piles, so the Tides we cannot see must be split between
// their hand and deck. When that number is 0, the opponent provably holds no
// Force of Will: our winning land drops are uncounterable and our own hoarded
// Tides earn nothing as protection — they are just Rainbow pieces to deploy.
function oppHiddenTides(opp, config) {
  const total = (config && config.copiesPerType) || 5;
  const seen = countIn(opp, 'tide', ['board', 'discard']);
  return Math.max(0, total - seen);
}

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
      if (tempoPositive) {
        s += 30; // a Rainbow piece we lack — nudge up, still below real plays
        // A Rainbow REQUIRES a Tide on the board, so over-hoarding can stall it.
        // A Tide only earns its hoard value as a Force of Will against a *winning*
        // land drop, which can only happen when the opponent is at lethal distance
        // (one drop from a win). While they are further away there is nothing to
        // counter, so a held Tide is merely a Rainbow piece we are sitting on —
        // commit it. We still keep one Tide back the moment the opponent reaches
        // lethal range. It only Scrys on enter in base, so score it below real
        // interaction but well above redundant duplicate plays.
        // PUBLIC-INFO READ: if the opponent provably holds no Tide (all copies are
        // visible on their board/discard), they can never Force-of-Will anything,
        // so there is nothing to reserve against — commit the Tide as a Rainbow
        // piece immediately, exactly as when they are far from lethal.
        const oppCanCounter = oppHiddenTides(opp, config) >= 1;
        const reserve = (oppDistance <= 1 && oppCanCounter) ? 1 : 0;
        const spare = tideInHand - reserve;
        const myRainbowDist = TYPES.reduce((n, ty) => n + (myCounts[ty] >= 1 ? 0 : 1), 0);
        if (spare >= 1 && (oppDistance >= 2 || !oppCanCounter)) s = 50 + (5 - myRainbowDist) * 4;
      }
      break;
    case 'meadow':
      if (cloud) {
        // CLOUD VARIANT — Meadow is Cloudshift (re-trigger a land), not a draw.
        // Value it by the best re-trigger actually available on our board; a lone
        // Meadow with nothing useful to flicker is correctly cheap.
        s += (tempoPositive ? 18 : 0) + cloudshiftValue(myCounts, me, opp);
        break;
      }
      // Base game: draw is great early; tuned up (35→45). Even a redundant Meadow
      // refills the hand, but the first one — a Rainbow piece that also draws — is
      // worth pushing harder over speculative interaction.
      s += tempoPositive ? 45 : 18;
      break;
    case 'forest': {
      // Regrowth is a late-game tutor whose whole value is the card it rebuys.
      // Early, with an empty/useless discard, a Forest does nothing — so paying a
      // land drop just for the "first Forest" tempo wastes the turn. Value the
      // Forest almost entirely by what it can return (wantsBack), keeping only a
      // tiny tempo nudge for the Rainbow piece itself. (Tuned via arena: dropping
      // the bare-tempo bonus 20→5, and the idle no-rebuy value 2→0, stops the AI
      // from slamming a do-nothing Forest over real plays — worth ~+2.4% base.)
      const disc = new Set(me.discard);
      const wantsBack = me.discard.some((d) => myCounts[d] === 0) || disc.has('tide');
      // A Forest that returns a needed Rainbow piece / Tide is a real play: price
      // the rebuy (wantsBack) well above fresh development so the tutor outranks a
      // redundant land or speculative interaction (22->60, ~+0.5% base, OOS-robust).
      s += (tempoPositive ? 5 : 0) + (wantsBack ? 60 : 0);
      break;
    }
    case 'volcano': {
      const firstVolcano = myCounts.volcano === 0;
      const hasTarget = opp.board.length > 0;
      // First Volcano with a target is strong; redundant Volcanoes only matter if
      // the opponent is about to win and we can set them back.
      //
      // A tempo-positive Volcano already scores 100 (the base tempo lead), so a
      // large first-Volcano bonus on top just pushes the AI to slam a speculative
      // Stone Rain ahead of grabbing a genuine Rainbow piece it lacks. Trimming the
      // first-Volcano bonus to a tiny nudge keeps the destroy tempo-positive but no
      // longer over-prioritizes early disruption over advancing our own clock; the
      // real interactive value lives in the oppDistance<=1 emergency branch below.
      if (firstVolcano && hasTarget) s += 6; // tempo-positive already; tiny extra nudge (40->6)
      else if (hasTarget && oppDistance <= 1) s += 24; // emergency interaction
      else if (hasTarget) s += 6;
      break;
    }
    case 'bog': {
      const firstBog = myCounts.bog === 0;
      const worthStripping = opp.hand.length > 0 && oppDistance <= 2;
      // Blackmail is best right before our winning turn, to poke a hole in their
      // ability to counter us.
      if (firstBog) s += 8; // trim speculative early Bog (16→8); value lives in worthStripping
      if (worthStripping) s += 20;
      break;
    }
    default:
      break;
  }

  // Five-of-a-kind pivot: if we already have a tall stack, redundant copies of it
  // start to matter again — sharpened by copies seen and the five-vs-Rainbow race.
  const rainbowDist = TYPES.reduce((n, k) => n + (myCounts[k] >= 1 ? 0 : 1), 0);
  s += pivotBonus(me, t, myCounts[t], rainbowDist);

  return s;
}

// ---- Force of Will: when to counter ---------------------------------------
// Always spend Tides to stop a land that would WIN the game for its owner —
// blocking the opponent's lethal drop, or forcing through our own lethal drop
// they tried to counter (when our pending land is lethal and they Force-of-Will
// it, winFor is still truthy, so we "force the force" right back).
//
// Beyond lethality we add ONE disciplined exception: counter the opponent's land
// when it would leave them on the BRINK of victory — exactly one uncountered drop
// away (distance 1) — AND that land is a Rainbow piece they did not yet control
// (so it genuinely advances them, rather than being a redundant copy). Stopping
// the brink resets their clock and buys us the tempo to win first; empirically
// this is worth a Tide even when it is our last one, so we only require holding
// one to pay. We never trigger this on a Tide-topped stack (those force-the-force
// wars stay reserved for lethal spots) or on our own pending land.
function chooseCounter(game, p) {
  const pend = game.pending;
  const owner = pend.owner;
  const lethal = winFor([...game.players[owner].board, pend.landType]);
  if (lethal) return { type: 'counter' };

  if (owner !== p && pend.topCardType !== 'tide') {
    const me = game.players[p];
    const opp = game.players[owner];
    const oppBefore = distanceToWin(opp.board);
    const oppAfter = distanceToWin([...opp.board, pend.landType]);
    const tidesInHand = me.hand.filter((t) => t === 'tide').length;
    // Brink: this land actually advances them (their distance drops) and leaves
    // them exactly one uncountered drop from victory — be it the last Rainbow
    // piece or the fourth copy of a five-of-a-kind stack. Either way, stopping it
    // resets their clock and buys us the tempo to win first, and is worth a Tide
    // even when it's our last one.
    if (oppAfter <= 1 && oppAfter < oppBefore && tidesInHand >= 1) {
      return { type: 'counter' };
    }
  }

  return { type: 'pass' };
}

// ---- Sub-decisions ---------------------------------------------------------
function chooseScry(game, p) {
  const me = game.players[p];
  const top = me.deck[0];
  const counts = countByType(me.board);
  const tidesInHand = me.hand.filter((t) => t === 'tide').length;
  const tideThreatened = distanceToWin(game.players[other(p)].board) <= 1;
  // Keep it if it advances Rainbow, gives us protection, or feeds a pivot stack.
  // A redundant second Tide is only worth scrying to when we are actually
  // threatened — otherwise dig for a real Rainbow piece instead.
  const keep =
    counts[top] === 0 ||
    (top === 'tide' && tidesInHand < 2 && tideThreatened) ||
    (counts[top] >= 3 && counts[top] < FIVE);
  return { type: 'scry', keep };
}

function chooseForestReturn(game, p) {
  const me = game.players[p];
  const opp = game.players[other(p)];
  const options = [...new Set(me.discard)];
  const tidesInHand = me.hand.filter((t) => t === 'tide').length;
  const myCounts = countByType(me.board);
  const oppDistance = distanceToWin(opp.board);
  // Shore up Island coverage first if we're exposed; else rebuy a Rainbow piece.
  options.sort((a, b) => forestRank(b) - forestRank(a));
  function forestRank(t) {
    let v = keepValue(t, me.board);
    if (t === 'tide') {
      if (tidesInHand < 1 && oppDistance <= 2) v += 60; // plug a hole in coverage
      // Don't rebuy yet another Tide when we are already swimming in them: a board
      // Tide secured plus a Force-of-Will reserve means a fresh Rainbow piece we
      // actually lack is the better grab.
      if (myCounts.tide >= 1 && tidesInHand >= 2 && oppDistance >= 2) v -= 70;
    }
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
  const oppCounts = countByType(opp.board);
  const oppDiscCounts = countByType(opp.discard);
  const copies = (game.config && game.config.copiesPerType) || 5;
  for (const t of options) {
    const reduced = [...opp.board];
    reduced.splice(reduced.indexOf(t), 1);
    const setback = distanceToWin(reduced) - before;
    let score = setback * 100;
    if (t !== 'meadow') score += 5;
    // Tie-break toward their hardest-to-replace, most central land. A Tide they
    // control is their Rainbow Tide *and* a Scry engine; replacing it means
    // spending a hoarded Force of Will, so blowing it up costs them the most.
    if (t === 'tide') score += 10;
    else if (t === 'volcano' || t === 'bog') score += 2; // their interaction next
    score += oppCounts[t]; // chip their tallest stack on ties
    // PUBLIC-INFO READ: among lands that set them back equally, prefer the one they
    // can least easily rebuild. If we blow up their only on-board copy of a type
    // and most other copies are already burned in their (visible) discard, few
    // copies remain in their hidden hand+deck — so the hole we punch stays open
    // longer. Scaled by how scarce the type has become for them.
    if (oppCounts[t] === 1) {
      const remaining = copies - oppCounts[t] - oppDiscCounts[t]; // in their hand+deck
      score += Math.max(0, copies - 1 - remaining) * 12; // more burned = harder to rebuild
    }
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
  const oppCounts = countByType(oppBoard);
  const oppDist = distanceToWin(oppBoard);
  const revealed = [...new Set(aw.revealed)];
  // A revealed land that would WIN for them right now is the single most valuable
  // thing to peel — this also catches a fifth copy completing a five-of-a-kind,
  // which the Rainbow-brink rank below would miss (oppCounts[t] !== 0 there).
  const lethalPiece = revealed.find((t) => winFor([...oppBoard, t]));
  if (lethalPiece) return { type: 'bogDiscard', card: lethalPiece };
  function rank(t) {
    let v = keepValue(t, oppBoard);
    // If they are on the brink (one drop from a Rainbow) and a revealed card is
    // the very land that completes it, taking that card actually delays their win —
    // worth more than peeling a spare Tide they could simply re-draw.
    if (oppDist <= 1 && oppCounts[t] === 0 && t !== 'tide') v += 120;
    return v;
  }
  revealed.sort((a, b) => rank(b) - rank(a));
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
