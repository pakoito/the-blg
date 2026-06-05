// ---------------------------------------------------------------------------
// The Basic Land Game — engine test suite
//
// Uses node:test + node:assert/strict. Run with `node --test`.
//
// Many tests are "white-box": we create a game, drive past the opening, then
// directly assign hand/board/deck/discard arrays before calling apply() so we
// can force a precise scenario deterministically. The engine mutates the game
// in place and exposes the next decision via game.awaiting, so after a white-box
// setup we just hand it the matching playLand/counter/... action.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  makeConfig,
  createGame,
  apply,
  view,
  fullState,
  winFor,
  distanceToWin,
  countByType,
  mulliganEligible,
  other,
  TYPES,
  FIVE_OF_A_KIND,
} from '../src/engine.js';

import { CARDS, TYPES as CARD_TYPES, FIVE_OF_A_KIND as CARD_FIVE, effectText, cardName, cardEmoji } from '../src/cards.js';

import { chooseAction } from '../src/ai.js';

// ---- small helpers ---------------------------------------------------------

// Put the game into a clean "player p must play a land" state with explicit
// zones, bypassing the opening/mulligan flow. We keep the seeded RNG intact for
// any draws the effect under test might trigger.
function forcePlayLand(g, p, { hand, board = [], discard = [], oppBoard = [], oppHand = [], oppDiscard = [] } = {}) {
  g.active = p;
  g.winner = null;
  g.pending = null;
  g.bog = null;
  g.flicker = null;
  const o = other(p);
  g.players[p].hand = [...hand];
  g.players[p].board = [...board];
  g.players[p].discard = [...discard];
  g.players[o].board = [...oppBoard];
  g.players[o].hand = [...oppHand];
  g.players[o].discard = [...oppDiscard];
  g.awaiting = { kind: 'playLand', player: p, options: [...new Set(hand)] };
  return g;
}

// Drive a whole game with the AI; returns the finished game.
function autoplay(g, cap = 2000) {
  let n = 0;
  while (g.awaiting && !g.winner) {
    if (n++ > cap) throw new Error('autoplay cap exceeded at turn ' + g.turn);
    const seat = g.awaiting.player;
    apply(g, chooseAction(g, seat));
  }
  return g;
}

// ===========================================================================
// cards.js
// ===========================================================================

test('cards: TYPES, FIVE_OF_A_KIND, emojis and effect text', () => {
  assert.deepEqual(CARD_TYPES, ['meadow', 'forest', 'volcano', 'bog', 'tide']);
  assert.equal(CARD_FIVE, 5);
  assert.equal(cardEmoji('meadow'), '🌻');
  assert.equal(cardEmoji('forest'), '🌲');
  assert.equal(cardEmoji('volcano'), '🌋');
  assert.equal(cardEmoji('bog'), '💀');
  assert.equal(cardEmoji('tide'), '🌊');
  assert.equal(cardName('tide'), 'Tide');

  // Base effect text.
  assert.equal(effectText('meadow', {}), CARDS.meadow.effect);
  assert.equal(effectText('tide', {}), CARDS.tide.effect);
  assert.equal(effectText('bog', {}), CARDS.bog.effect);
  // Variant effect text.
  assert.equal(effectText('meadow', { blueDrawWhiteCloudshift: true }), CARDS.meadow.effectCloudshift);
  assert.equal(effectText('tide', { blueDrawWhiteCloudshift: true }), CARDS.tide.effectDraw);
  assert.equal(effectText('bog', { swampRevealAll: true }), CARDS.bog.effectThoughtseize);
});

// ===========================================================================
// config
// ===========================================================================

test('config: defaults and overrides', () => {
  assert.deepEqual(DEFAULT_CONFIG, { copiesPerType: 5, swampRevealAll: false, blueDrawWhiteCloudshift: false });
  // makeConfig must not mutate the default.
  const c = makeConfig({ copiesPerType: 10 });
  assert.equal(c.copiesPerType, 10);
  assert.equal(c.swampRevealAll, false);
  assert.equal(DEFAULT_CONFIG.copiesPerType, 5);
});

// ===========================================================================
// opening setup
// ===========================================================================

test('opening: 25-card deck composition, 3-card hands, first turn skips draw', () => {
  const g = createGame({ seed: 42, firstPlayer: 0 });
  for (let p = 0; p < 2; p++) {
    const all = [...g.players[p].deck, ...g.players[p].hand];
    assert.equal(all.length, 25, 'deck+hand should be 25 cards');
    const c = countByType(all);
    for (const t of TYPES) assert.equal(c[t], 5, `5 copies of ${t}`);
    assert.equal(g.players[p].hand.length, 3, 'opening hand is 3 cards');
    assert.equal(g.players[p].board.length, 0);
    assert.equal(g.players[p].discard.length, 0);
  }
  // First turn of the game: the active player did NOT draw, so deck is 25-3=22.
  // (Mulligan eligibility for seed 42 is assumed false here; if a mull fired the
  // hand would still be 3 but the test below covers mulligans explicitly.)
  assert.equal(g.firstDrawSkipped, true);
  // We should be awaiting the first player's land drop (or a mulligan).
  assert.ok(['playLand', 'mulligan'].includes(g.awaiting.kind));
});

test('opening: 50-card deck composition for copiesPerType:10', () => {
  const g = createGame({ seed: 7, config: { copiesPerType: 10 } });
  for (let p = 0; p < 2; p++) {
    const all = [...g.players[p].deck, ...g.players[p].hand];
    assert.equal(all.length, 50);
    const c = countByType(all);
    for (const t of TYPES) assert.equal(c[t], 10);
  }
  // Five-of-a-kind threshold is still 5, not 10.
  assert.equal(FIVE_OF_A_KIND, 5);
});

test('opening: firstPlayer is honored and active starts there', () => {
  const g0 = createGame({ seed: 3, firstPlayer: 0 });
  assert.equal(g0.firstPlayer, 0);
  const g1 = createGame({ seed: 3, firstPlayer: 1 });
  assert.equal(g1.firstPlayer, 1);
  // The first decision belongs to the first player (mulligan or playLand).
  assert.equal(g1.awaiting.player, 1);
});

test('opening: first player skips the very first draw (deck stays at 22)', () => {
  // Use a seed whose opening hands are NOT mulligan-eligible so no extra draws.
  // We assert the relationship deck+hand == 25 and that exactly 3 cards are in
  // hand with none drawn for the turn yet.
  const g = createGame({ seed: 100, firstPlayer: 0 });
  // Skip any mulligans by keeping (AI/keep) until we reach playLand.
  while (g.awaiting && g.awaiting.kind === 'mulligan') {
    apply(g, { type: 'mulligan', keep: true });
  }
  assert.equal(g.awaiting.kind, 'playLand');
  const fp = g.firstPlayer;
  assert.equal(g.players[fp].hand.length, 3, 'first player has not drawn for turn 1');
  assert.equal(g.players[fp].deck.length, 22);
});

// ===========================================================================
// draw + discard reshuffle
// ===========================================================================

test('draw: second turn draws a card (deck shrinks for the player to move)', () => {
  const g = createGame({ seed: 100, firstPlayer: 0 });
  while (g.awaiting && g.awaiting.kind === 'mulligan') apply(g, { type: 'mulligan', keep: true });
  // First player plays any land (no draw happened this turn).
  const fp = g.firstPlayer;
  const sp = other(fp);
  const card = g.awaiting.options[0];
  const deckBefore = g.players[sp].deck.length;
  apply(g, { type: 'playLand', card });
  // Resolve any sub-decision from that land until it's the second player's turn.
  autoUntilPlayLand(g, sp);
  // Now it's the second player's turn; they should have drawn one card.
  assert.equal(g.awaiting.kind, 'playLand');
  assert.equal(g.awaiting.player, sp);
  assert.equal(g.players[sp].deck.length, deckBefore - 1, 'second player drew for the turn');
});

// Helper: drive the AI until it is `who`'s playLand decision (or game over).
function autoUntilPlayLand(g, who) {
  let n = 0;
  while (g.awaiting && !g.winner) {
    if (g.awaiting.kind === 'playLand' && g.awaiting.player === who) return g;
    if (n++ > 500) throw new Error('autoUntilPlayLand stuck');
    apply(g, chooseAction(g, g.awaiting.player));
  }
  return g;
}

test('draw: empty deck reshuffles the discard pile back in (no decking out)', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  // White-box: empty the deck, stash cards in discard, then play a Meadow (draw).
  forcePlayLand(g, 0, { hand: ['meadow'], board: [], discard: ['forest', 'volcano', 'bog'] });
  g.players[0].deck = []; // force the reshuffle path
  apply(g, { type: 'playLand', card: 'meadow' });
  // Meadow draws: deck was empty so discard (3 cards) reshuffled in, then 1 drawn.
  // After draw: hand has the drawn card, deck has 2 left, discard empty.
  const logKinds = g.log.map((l) => l.kind);
  assert.ok(logKinds.includes('reshuffle'), 'a reshuffle was logged');
  assert.equal(g.players[0].discard.length, 0);
  assert.equal(g.players[0].deck.length, 2);
  // The Meadow entered play.
  assert.deepEqual(g.players[0].board, ['meadow']);
});

// ===========================================================================
// win detection
// ===========================================================================

test('winFor / distanceToWin: pure helpers', () => {
  assert.equal(winFor([]), null);
  assert.equal(winFor(['meadow', 'forest', 'volcano', 'bog', 'tide']), 'rainbow');
  assert.equal(winFor(['meadow', 'meadow', 'meadow', 'meadow', 'meadow']), 'five');
  // Five takes priority in the return order, but rainbow with a 5-stack still 'five'.
  assert.equal(winFor(['meadow', 'meadow', 'meadow', 'meadow', 'meadow', 'forest', 'volcano', 'bog', 'tide']), 'five');
  assert.equal(distanceToWin([]), 5);
  assert.equal(distanceToWin(['meadow', 'forest', 'volcano', 'bog']), 1); // one type away from rainbow
  assert.equal(distanceToWin(['meadow', 'meadow', 'meadow', 'meadow']), 1); // one away from five
  assert.equal(distanceToWin(['meadow', 'forest', 'volcano', 'bog', 'tide']), 0);
});

test('win: rainbow via a final land drop', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  // Board has 4 distinct types; playing volcano completes the rainbow.
  forcePlayLand(g, 0, { hand: ['volcano'], board: ['meadow', 'forest', 'bog', 'tide'], oppBoard: ['meadow'] });
  apply(g, { type: 'playLand', card: 'volcano' });
  // Volcano resolves, triggers destroy on opponent's meadow (sub-decision).
  if (g.awaiting && g.awaiting.kind === 'volcanoDestroy') {
    apply(g, { type: 'volcanoDestroy', card: 'meadow' });
  }
  assert.ok(g.winner, 'someone won');
  assert.equal(g.winner.player, 0);
  assert.equal(g.winner.condition, 'rainbow');
  assert.equal(g.awaiting, null, 'no awaiting once the game is over');
});

test('win: five-of-a-kind via a final land drop', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['meadow'], board: ['meadow', 'meadow', 'meadow', 'meadow'] });
  apply(g, { type: 'playLand', card: 'meadow' });
  // Meadow draws a card; no sub-decision. Win check fires in finishLandResolution.
  assert.ok(g.winner);
  assert.equal(g.winner.player, 0);
  assert.equal(g.winner.condition, 'five');
});

test('win: apply throws once the game is over', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['meadow'], board: ['meadow', 'meadow', 'meadow', 'meadow'] });
  apply(g, { type: 'playLand', card: 'meadow' });
  assert.ok(g.winner);
  assert.throws(() => apply(g, { type: 'playLand', card: 'meadow' }), /game is over/);
});

// ===========================================================================
// per-land effects + their awaiting + empty/no-op
// ===========================================================================

test('effect Meadow: draws a card, no sub-decision', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['meadow', 'forest'], board: [] });
  const handBefore = g.players[0].hand.length; // 2
  apply(g, { type: 'playLand', card: 'meadow' });
  // Played one (hand 1), drew one (hand 2). Board has meadow. Turn passed.
  assert.deepEqual(g.players[0].board, ['meadow']);
  assert.equal(g.players[0].hand.length, handBefore); // -1 played +1 drawn
  assert.ok(g.log.some((l) => l.kind === 'effect-draw'));
});

test('effect Forest: raises forestReturn and returns a card; empty discard is a no-op', () => {
  // With discard contents:
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['forest'], board: [], discard: ['tide', 'volcano'] });
  apply(g, { type: 'playLand', card: 'forest' });
  assert.equal(g.awaiting.kind, 'forestReturn');
  assert.deepEqual([...g.awaiting.options].sort(), ['tide', 'volcano']);
  apply(g, { type: 'forestReturn', card: 'tide' });
  assert.ok(g.players[0].hand.includes('tide'), 'tide returned to hand');
  assert.ok(!g.players[0].discard.includes('tide'), 'tide left the discard');

  // Empty discard → no-op, no awaiting raised, turn passes.
  const g2 = createGame({ seed: 2, firstPlayer: 0 });
  forcePlayLand(g2, 0, { hand: ['forest'], board: [], discard: [] });
  apply(g2, { type: 'playLand', card: 'forest' });
  assert.ok(g2.log.some((l) => l.kind === 'effect-forest-empty'));
  // forestReturn was never raised.
  assert.notEqual(g2.awaiting && g2.awaiting.kind, 'forestReturn');
});

test('effect Volcano: raises volcanoDestroy and removes a land; no target is a no-op', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['volcano'], board: [], oppBoard: ['meadow', 'tide'] });
  apply(g, { type: 'playLand', card: 'volcano' });
  assert.equal(g.awaiting.kind, 'volcanoDestroy');
  assert.equal(g.awaiting.target, 1);
  apply(g, { type: 'volcanoDestroy', card: 'tide' });
  assert.deepEqual(g.players[1].board, ['meadow'], 'tide destroyed');
  assert.ok(g.players[1].discard.includes('tide'), 'destroyed land hits discard');

  // No target → no-op.
  const g2 = createGame({ seed: 2, firstPlayer: 0 });
  forcePlayLand(g2, 0, { hand: ['volcano'], board: [], oppBoard: [] });
  apply(g2, { type: 'playLand', card: 'volcano' });
  assert.ok(g2.log.some((l) => l.kind === 'effect-volcano-empty'));
  assert.notEqual(g2.awaiting && g2.awaiting.kind, 'volcanoDestroy');
});

test('effect Bog (>3 cards, base): defender reveals 3, attacker picks one to discard', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  // Opponent (p1) hand has 4 cards so the defender chooses which 3 to reveal.
  forcePlayLand(g, 0, { hand: ['bog'], board: [], oppHand: ['meadow', 'forest', 'volcano', 'tide'] });
  apply(g, { type: 'playLand', card: 'bog' });
  // First a bogReveal addressed to the DEFENDER (player 1).
  assert.equal(g.awaiting.kind, 'bogReveal');
  assert.equal(g.awaiting.player, 1);
  assert.equal(g.awaiting.attacker, 0);
  assert.equal(g.awaiting.count, 3);
  apply(g, { type: 'bogReveal', cards: ['meadow', 'forest', 'volcano'] });
  // Then a bogDiscard addressed to the ATTACKER (player 0).
  assert.equal(g.awaiting.kind, 'bogDiscard');
  assert.equal(g.awaiting.player, 0);
  assert.deepEqual(g.awaiting.revealed, ['meadow', 'forest', 'volcano']);
  apply(g, { type: 'bogDiscard', card: 'volcano' });
  assert.ok(g.players[1].discard.includes('volcano'), 'chosen card discarded');
  assert.ok(!g.players[1].hand.includes('volcano'));
});

test('effect Bog (<=3 cards): no reveal step; attacker sees the whole hand', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['bog'], board: [], oppHand: ['meadow', 'tide'] });
  apply(g, { type: 'playLand', card: 'bog' });
  // Hand <=3 → skip bogReveal, go straight to bogDiscard with the full hand.
  assert.equal(g.awaiting.kind, 'bogDiscard');
  assert.equal(g.awaiting.player, 0);
  assert.deepEqual([...g.awaiting.revealed].sort(), ['meadow', 'tide']);
  apply(g, { type: 'bogDiscard', card: 'tide' });
  assert.ok(g.players[1].discard.includes('tide'));
});

test('effect Bog: empty opponent hand is a no-op', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['bog'], board: [], oppHand: [] });
  apply(g, { type: 'playLand', card: 'bog' });
  assert.ok(g.log.some((l) => l.kind === 'effect-bog-empty'));
  assert.notEqual(g.awaiting && g.awaiting.kind, 'bogReveal');
  assert.notEqual(g.awaiting && g.awaiting.kind, 'bogDiscard');
});

test('effect Tide (base): raises scry; keep leaves the top, bury sends it to the bottom', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['tide'], board: [] });
  // Control the deck so we know the top card.
  g.players[0].deck = ['forest', 'volcano', 'bog'];
  apply(g, { type: 'playLand', card: 'tide' });
  assert.equal(g.awaiting.kind, 'scry');
  assert.equal(g.awaiting.top, 'forest');
  apply(g, { type: 'scry', keep: true });
  assert.equal(g.players[0].deck[0], 'forest', 'kept on top');

  const g2 = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g2, 0, { hand: ['tide'], board: [] });
  g2.players[0].deck = ['forest', 'volcano', 'bog'];
  apply(g2, { type: 'playLand', card: 'tide' });
  apply(g2, { type: 'scry', keep: false });
  assert.notEqual(g2.players[0].deck[0], 'forest', 'buried: forest no longer on top');
  assert.equal(g2.players[0].deck[g2.players[0].deck.length - 1], 'forest', 'forest sent to the bottom');
});

test('effect Tide (base): empty deck+discard scry is a no-op', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['tide'], board: [] });
  g.players[0].deck = [];
  g.players[0].discard = [];
  apply(g, { type: 'playLand', card: 'tide' });
  // No scry raised; the Tide simply entered and the turn passes.
  assert.notEqual(g.awaiting && g.awaiting.kind, 'scry');
  assert.deepEqual(g.players[0].board, ['tide']);
});

// ===========================================================================
// counter war: Force of Will
// ===========================================================================

test('counter: a single Force of Will counters a land — owner discards it, no effect, turn passes to the counterer', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  // p0 plays a Volcano that would destroy p1's meadow. p1 counters with FoW.
  forcePlayLand(g, 0, {
    hand: ['volcano'],
    board: [],
    oppBoard: ['meadow'],
    oppHand: ['tide', 'volcano'], // tide + matching volcano = a Force of Will for this land
  });
  apply(g, { type: 'playLand', card: 'volcano' });
  assert.equal(g.awaiting.kind, 'counter');
  assert.equal(g.awaiting.player, 1);
  assert.deepEqual(g.awaiting.cost, { tide: 1, volcano: 1 });
  apply(g, { type: 'counter' });
  // Land is countered: no destroy happened, meadow survives.
  assert.deepEqual(g.players[1].board, ['meadow'], 'volcano effect did NOT fire');
  // Owner's volcano went to owner's discard.
  assert.ok(g.players[0].discard.includes('volcano'));
  assert.equal(g.players[0].board.length, 0);
  // Counterer paid tide + volcano into their discard.
  assert.deepEqual([...g.players[1].discard].sort(), ['tide', 'volcano']);
  // Turn passed to the counterer (player 1).
  assert.equal(g.active, 1);
  assert.equal(g.awaiting.kind, 'playLand');
  assert.equal(g.awaiting.player, 1);
});

test('counter: "force the force" with 2 Tides lets the original land resolve WITH its effect', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  // p0 plays a winning rainbow Tide. p1 counters (cost 2 Tides). p0 forces the
  // force (cost 2 Tides). p1 cannot pay again → Tide resolves, scrys, then wins.
  forcePlayLand(g, 0, {
    hand: ['tide', 'tide', 'tide'], // the win + 2 to force-the-force
    board: ['meadow', 'forest', 'volcano', 'bog'],
    discard: [],
    oppBoard: [],
    oppHand: ['tide', 'tide'], // exactly enough for one counter
  });
  g.players[0].deck = ['bog']; // give the scry something to look at
  apply(g, { type: 'playLand', card: 'tide' });
  // p1 to counter; cost is {tide:2} because the top card is a Tide.
  assert.equal(g.awaiting.kind, 'counter');
  assert.equal(g.awaiting.player, 1);
  assert.deepEqual(g.awaiting.cost, { tide: 2 });
  apply(g, { type: 'counter' });
  // Now p0 may force the force; same cost {tide:2}.
  assert.equal(g.awaiting.kind, 'counter');
  assert.equal(g.awaiting.player, 0);
  assert.deepEqual(g.awaiting.cost, { tide: 2 });
  apply(g, { type: 'counter' });
  // p1 has 0 Tides left → cannot counter → the Tide resolves WITH its effect.
  // Tide's on-enter scry is raised.
  assert.equal(g.awaiting.kind, 'scry');
  assert.equal(g.awaiting.player, 0);
  apply(g, { type: 'scry', keep: true });
  // Now the rainbow is complete → player 0 wins.
  assert.ok(g.winner);
  assert.equal(g.winner.player, 0);
  assert.equal(g.winner.condition, 'rainbow');
  // Both players pitched their Tides.
  assert.equal(countByType(g.players[1].discard).tide, 2);
});

test('counter: responder who cannot pay is auto-passed (land resolves)', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, {
    hand: ['meadow'],
    board: [],
    oppHand: ['forest'], // no tide → cannot counter
  });
  apply(g, { type: 'playLand', card: 'meadow' });
  // No counter awaiting at all; the meadow resolved immediately.
  assert.deepEqual(g.players[0].board, ['meadow']);
  assert.notEqual(g.awaiting && g.awaiting.kind, 'counter');
});

test('counter: pass action resolves the land', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, {
    hand: ['volcano'],
    board: [],
    oppBoard: ['meadow'],
    oppHand: ['tide', 'volcano'],
  });
  apply(g, { type: 'playLand', card: 'volcano' });
  assert.equal(g.awaiting.kind, 'counter');
  apply(g, { type: 'pass' });
  // Volcano resolves: opponent must lose a land; destroy raised then resolved.
  if (g.awaiting && g.awaiting.kind === 'volcanoDestroy') apply(g, { type: 'volcanoDestroy', card: 'meadow' });
  assert.deepEqual(g.players[1].board, [], 'volcano resolved and destroyed the meadow');
});

// ===========================================================================
// mulligan eligibility (both seats)
// ===========================================================================

test('mulligan: first player may mull a hand of only volcano/forest, not otherwise', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  // eligible: all volcano/forest
  g.players[0].hand = ['volcano', 'forest', 'forest'];
  assert.equal(mulliganEligible(g, 0), true);
  g.players[0].hand = ['volcano', 'volcano', 'volcano'];
  assert.equal(mulliganEligible(g, 0), true);
  // not eligible: contains a Meadow / Tide / Bog
  g.players[0].hand = ['volcano', 'forest', 'meadow'];
  assert.equal(mulliganEligible(g, 0), false);
  g.players[0].hand = ['tide', 'forest', 'forest'];
  assert.equal(mulliganEligible(g, 0), false);
  // empty hand never eligible
  g.players[0].hand = [];
  assert.equal(mulliganEligible(g, 0), false);
});

test('mulligan: second player may mull only an ALL-forest hand', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  const sp = 1; // second player
  g.players[sp].hand = ['forest', 'forest', 'forest'];
  assert.equal(mulliganEligible(g, sp), true);
  g.players[sp].hand = ['forest', 'forest', 'volcano'];
  assert.equal(mulliganEligible(g, sp), false, 'a volcano makes it non-mulliganable for the draw');
  g.players[sp].hand = ['forest', 'meadow', 'forest'];
  assert.equal(mulliganEligible(g, sp), false);
});

test('mulligan: engine raises the awaiting only for an eligible hand, and performs the mull on keep:false', () => {
  // Build a game and force the first player into an eligible (all-forest/volcano)
  // hand BEFORE the mulligan phase is entered. We do that by reconstructing the
  // opening through createGame with a seed, then overriding and re-running the
  // mulligan check via a fresh createGame call is awkward; instead we directly
  // assert the awaiting flow with a hand we control via the public apply path.
  // Find a seed where the first player is eligible by brute force.
  let g = null;
  for (let s = 0; s < 500; s++) {
    const cand = createGame({ seed: s, firstPlayer: 0 });
    if (cand.awaiting && cand.awaiting.kind === 'mulligan' && cand.awaiting.player === cand.firstPlayer) {
      g = cand;
      break;
    }
  }
  assert.ok(g, 'found a seed where the first player is offered a mulligan');
  const fp = g.firstPlayer;
  const handBefore = [...g.players[fp].hand];
  // The offered hand really is rules-eligible.
  assert.ok(handBefore.every((t) => t === 'volcano' || t === 'forest'));
  // Perform the mulligan (keep:false). Hand is reshuffled and 3 new cards drawn.
  apply(g, { type: 'mulligan', keep: false });
  assert.equal(g.players[fp].hand.length, 3, 'still 3 cards after a mulligan');
  // The deck+hand total is conserved at 25.
  assert.equal(g.players[fp].deck.length + g.players[fp].hand.length + g.players[fp].discard.length, 25);
});

// ===========================================================================
// variant: swampRevealAll (Thoughtseize)
// ===========================================================================

test('variant swampRevealAll: Bog reveals the whole hand, no bogReveal step even with >3 cards', () => {
  const g = createGame({ seed: 1, firstPlayer: 0, config: { swampRevealAll: true } });
  forcePlayLand(g, 0, {
    hand: ['bog'],
    board: [],
    oppHand: ['meadow', 'forest', 'volcano', 'tide'], // 4 cards
  });
  apply(g, { type: 'playLand', card: 'bog' });
  // No bogReveal — straight to bogDiscard seeing the full hand.
  assert.equal(g.awaiting.kind, 'bogDiscard');
  assert.equal(g.awaiting.player, 0);
  assert.deepEqual([...g.awaiting.revealed].sort(), ['forest', 'meadow', 'tide', 'volcano']);
  apply(g, { type: 'bogDiscard', card: 'tide' });
  assert.ok(g.players[1].discard.includes('tide'));
});

// ===========================================================================
// variant: blueDrawWhiteCloudshift
// ===========================================================================

test('variant blueDrawWhiteCloudshift: Tide draws on enter (no scry)', () => {
  const g = createGame({ seed: 1, firstPlayer: 0, config: { blueDrawWhiteCloudshift: true } });
  forcePlayLand(g, 0, { hand: ['tide'], board: [] });
  g.players[0].deck = ['forest', 'volcano'];
  const handBefore = g.players[0].hand.length; // 1
  apply(g, { type: 'playLand', card: 'tide' });
  // No scry; instead a draw happened.
  assert.notEqual(g.awaiting && g.awaiting.kind, 'scry');
  assert.deepEqual(g.players[0].board, ['tide']);
  // Played the tide (hand 0) then drew one (hand 1).
  assert.equal(g.players[0].hand.length, handBefore);
  assert.ok(g.log.some((l) => l.kind === 'effect-draw'));
});

test('variant blueDrawWhiteCloudshift: Meadow becomes Cloudshift — re-triggers one OTHER land', () => {
  const g = createGame({ seed: 1, firstPlayer: 0, config: { blueDrawWhiteCloudshift: true } });
  // Board already has a Volcano; play a Meadow (Cloudshift) to re-trigger it.
  forcePlayLand(g, 0, { hand: ['meadow'], board: ['volcano'], oppBoard: ['bog', 'tide'] });
  apply(g, { type: 'playLand', card: 'meadow' });
  assert.equal(g.awaiting.kind, 'cloudshift');
  assert.deepEqual(g.awaiting.options, ['volcano']); // meadow itself excluded
  apply(g, { type: 'cloudshift', card: 'volcano' });
  // The re-triggered Volcano now destroys one of the opponent's lands.
  assert.equal(g.awaiting.kind, 'volcanoDestroy');
  apply(g, { type: 'volcanoDestroy', card: 'tide' });
  assert.equal(g.players[1].board.length, 1, 'one opponent land destroyed by the flicker');
});

test('variant blueDrawWhiteCloudshift: Cloudshift with no other land is a no-op', () => {
  const g = createGame({ seed: 1, firstPlayer: 0, config: { blueDrawWhiteCloudshift: true } });
  // Only the just-played Meadow is on board → nothing else to flicker.
  forcePlayLand(g, 0, { hand: ['meadow'], board: [] });
  apply(g, { type: 'playLand', card: 'meadow' });
  assert.ok(g.log.some((l) => l.kind === 'effect-cloudshift-empty'));
  assert.notEqual(g.awaiting && g.awaiting.kind, 'cloudshift');
  assert.deepEqual(g.players[0].board, ['meadow']);
});

test('variant blueDrawWhiteCloudshift: chained Cloudshifts terminate (no infinite loop)', () => {
  const g = createGame({ seed: 1, firstPlayer: 0, config: { blueDrawWhiteCloudshift: true } });
  // Two extra Meadows already in play; play a third Meadow. The Cloudshift can
  // re-trigger another Meadow (which re-triggers Cloudshift) but the chain must
  // exclude already-flickered permanents and terminate.
  forcePlayLand(g, 0, { hand: ['meadow'], board: ['meadow', 'meadow', 'forest'], discard: ['tide'] });
  g.players[0].deck = ['bog', 'volcano'];
  apply(g, { type: 'playLand', card: 'meadow' });
  // Drive the chain with the AI; it must terminate without throwing.
  let n = 0;
  while (g.awaiting && g.awaiting.kind === 'cloudshift') {
    if (n++ > 20) throw new Error('cloudshift chain did not terminate');
    apply(g, chooseAction(g, g.awaiting.player));
    // resolve any sub-decision the flicker produced, then continue the chain
    while (g.awaiting && g.awaiting.kind !== 'cloudshift' && g.awaiting.player === 0 && !g.winner) {
      apply(g, chooseAction(g, g.awaiting.player));
    }
  }
  assert.ok(true, 'chain terminated');
});

// ===========================================================================
// variant: copiesPerType:10 still wins at five
// ===========================================================================

test('variant copiesPerType:10: five-of-a-kind threshold stays 5', () => {
  const g = createGame({ seed: 1, firstPlayer: 0, config: { copiesPerType: 10 } });
  forcePlayLand(g, 0, { hand: ['bog'], board: ['bog', 'bog', 'bog', 'bog'], oppHand: ['meadow'] });
  apply(g, { type: 'playLand', card: 'bog' });
  // Bog's discard effect raises a decision; resolve it, then the win fires.
  while (g.awaiting && !g.winner) apply(g, chooseAction(g, g.awaiting.player));
  assert.ok(g.winner);
  assert.equal(g.winner.condition, 'five');
});

// ===========================================================================
// view: hidden information & shape
// ===========================================================================

test('view: exposes my full zones but only counts/boards of the opponent', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  forcePlayLand(g, 0, { hand: ['meadow', 'tide'], board: ['forest'], oppHand: ['bog', 'volcano'], oppBoard: ['tide'] });
  const v = view(g, 0);
  assert.equal(v.me, 0);
  assert.equal(v.opponent, 1);
  assert.deepEqual([...v.my.hand].sort(), ['meadow', 'tide']);
  assert.deepEqual(v.my.board, ['forest']);
  // Opponent hand is hidden: only a count is exposed, never the card list.
  assert.equal(v.their.handCount, 2);
  assert.equal(v.their.hand, undefined);
  assert.deepEqual(v.their.board, ['tide']);
  assert.ok('distance' in v.my && 'distance' in v.their);
  assert.deepEqual(v.names, ['Player 1', 'Player 2']);
});

test('fullState: omniscient snapshot has both full hands and decks', () => {
  const g = createGame({ seed: 5, firstPlayer: 0 });
  const s = fullState(g);
  assert.equal(s.players.length, 2);
  for (const pl of s.players) {
    assert.ok(Array.isArray(pl.hand));
    assert.ok(Array.isArray(pl.deck));
    assert.ok(Array.isArray(pl.board));
    assert.ok(Array.isArray(pl.discard));
  }
});

// ===========================================================================
// AI smoke + determinism
// ===========================================================================

test('ai: chooseAction requires the seat to be the current decider', () => {
  const g = createGame({ seed: 1, firstPlayer: 0 });
  const wrongSeat = other(g.awaiting.player);
  assert.throws(() => chooseAction(g, wrongSeat), /not this seat/);
});

test('ai: a full AI-vs-AI game always reaches a winner and never throws (base config)', () => {
  for (const seed of [1, 2, 3, 7, 42, 99, 123, 500]) {
    const g = createGame({ seed });
    autoplay(g, 400 * 6);
    assert.ok(g.winner, `seed ${seed} produced a winner`);
    assert.equal(g.awaiting, null);
  }
});

test('ai: determinism — same seed replays to the identical winner', () => {
  const a = autoplay(createGame({ seed: 314 }));
  const b = autoplay(createGame({ seed: 314 }));
  assert.deepEqual(a.winner, b.winner);
  assert.equal(a.turn, b.turn);
  assert.equal(a.log.length, b.log.length);
});

test('ai: every variant combination finishes cleanly for a batch of seeds', () => {
  const variants = [
    {},
    { swampRevealAll: true },
    { blueDrawWhiteCloudshift: true },
    { copiesPerType: 10 },
    { copiesPerType: 10, swampRevealAll: true, blueDrawWhiteCloudshift: true },
  ];
  for (const config of variants) {
    for (let seed = 0; seed < 40; seed++) {
      const g = createGame({ seed, config });
      autoplay(g, 400 * 8);
      assert.ok(g.winner, `config ${JSON.stringify(config)} seed ${seed} has a winner`);
    }
  }
});
