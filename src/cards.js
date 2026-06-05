// ---------------------------------------------------------------------------
// The Basic Land Game — card definitions
//
// This module is the single source of truth for the five land types: their
// fun names, emoji faces, and human-readable effect text. It is pure data and
// imports nothing, so it can be loaded equally by the browser UI, the Node
// engine, and the test suite.
//
// The names are our own (the game lets you call the lands whatever you like),
// but each is a re-skin of a recognizable Magic: The Gathering effect, noted in
// `mtg` for flavor.
// ---------------------------------------------------------------------------

export const TYPES = ['meadow', 'forest', 'volcano', 'bog', 'tide'];

// Win-condition constants. FIVE is a fixed threshold (five copies of one land
// in play wins) regardless of how many copies the deck actually contains — the
// 50-card variant just makes those five easier to find.
export const FIVE_OF_A_KIND = 5;

export const CARDS = {
  meadow: {
    key: 'meadow',
    name: 'Meadow',
    emoji: '🌻',
    color: '#eab308',
    mtg: 'Plains → Divination / Cloudshift',
    // Base effect:
    effect: '🃏 Draw a card.',
    // Variant effect when Blue-draw / White-cloudshift is on:
    effectCloudshift: '✨ Re-trigger one of your other lands in play.',
    short: 'Draw',
  },
  forest: {
    key: 'forest',
    name: 'Forest',
    emoji: '🌲',
    color: '#22c55e',
    mtg: 'Forest → Regrowth',
    effect: '♻️ Return a card from your discard pile to your hand.',
    short: 'Regrow',
  },
  volcano: {
    key: 'volcano',
    name: 'Volcano',
    emoji: '🌋',
    color: '#ef4444',
    mtg: 'Mountain → Stone Rain',
    effect: '💥 Destroy a land your opponent controls.',
    short: 'Destroy',
  },
  bog: {
    key: 'bog',
    name: 'Bog',
    emoji: '💀',
    color: '#a855f7',
    mtg: 'Swamp → Blackmail / Thoughtseize',
    effect: '🗑️ Opponent reveals 3 cards; you pick one for them to discard.',
    effectThoughtseize: '🗑️ Opponent reveals their whole hand; you pick one for them to discard.',
    short: 'Discard',
  },
  tide: {
    key: 'tide',
    name: 'Tide',
    emoji: '🌊',
    color: '#3b82f6',
    mtg: 'Island → Scry / Force of Will',
    effect: '🔮 Scry 1 (peek the top card; keep it or bury it).',
    // Variant effect when Blue-draw / White-cloudshift is on:
    effectDraw: '🃏 Draw a card.',
    // In-hand mode (always available, both base and variant):
    inHand: '🛡️ In hand: discard this + a matching land to counter an opponent\'s land drop.',
    short: 'Scry',
  },
};

// Resolve the on-enter effect text for a card given the active variant config.
export function effectText(typeKey, config = {}) {
  const c = CARDS[typeKey];
  if (typeKey === 'meadow' && config.blueDrawWhiteCloudshift) return c.effectCloudshift;
  if (typeKey === 'tide' && config.blueDrawWhiteCloudshift) return c.effectDraw;
  if (typeKey === 'bog' && config.swampRevealAll) return c.effectThoughtseize;
  return c.effect;
}

export const cardName = (k) => CARDS[k].name;
export const cardEmoji = (k) => CARDS[k].emoji;
