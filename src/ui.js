// ---------------------------------------------------------------------------
// The Basic Land Game — browser UI controller + renderer.
//
// Drives the pure engine through its single door: read `game.awaiting`,
// present exactly the legal choice to `awaiting.player`, apply the action,
// re-render. Handles vs-CPU autoplay and pass-and-play handoffs (hidden
// information). Exposes window.blg for automated testing.
// ---------------------------------------------------------------------------

import { createGame, apply, view, fullState, makeConfig, other } from './engine.js';
import { chooseAction } from './ai.js';
import { TYPES, CARDS, effectText, cardName, cardEmoji, FIVE_OF_A_KIND } from './cards.js';

// ---- Module state ----------------------------------------------------------
let game = null;
let mode = 'cpu';          // 'cpu' | '2p'
let humanSeats = [0, 1];   // which seats a human controls (cpu: just [0] or [1])
let cpuSeat = null;        // the CPU's seat, or null in 2p
let viewerSeat = 0;        // whose private view is currently shown (2p handoff)
let cpuTimer = null;
let busy = false;          // guard against overlapping async loops

// --- vs-CPU "beats": pacing so the human doesn't miss important events ---
let presentedLogLen = 0;   // log entries already surfaced as paced beats
let beatQueue = [];        // [{html, ms, kind}] toasts to show (with a pause) before continuing
let prevViewerHand = null; // the viewer's hand at the previous render, for the just-drawn glow

const $ = (id) => document.getElementById(id);
const CPU_DELAY = 650;

// ---- Friendly helpers ------------------------------------------------------
const emoji = (t) => cardEmoji(t);
const name = (t) => cardName(t);
const color = (t) => CARDS[t].color;

function nameOf(seat) {
  return game ? game.players[seat].name : `Player ${seat + 1}`;
}

// Wrap a player's name in a colored span for the seat.
function whoSpan(seat) {
  return `<span class="who-${seat}">${escapeHtml(nameOf(seat))}</span>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isHuman(seat) {
  return mode === '2p' || seat !== cpuSeat;
}

// =====================================================================
// MODE SELECTION
// =====================================================================
function initModeScreen() {
  // Mode pick
  document.querySelectorAll('.mode-option').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.mode-option').forEach((o) => o.classList.remove('selected'));
      el.classList.add('selected');
      mode = el.dataset.mode;
      syncModeUI();
    });
  });

  // First-player pick
  document.querySelectorAll('#first-pick button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#first-pick button').forEach((o) => o.classList.remove('selected'));
      b.classList.add('selected');
    });
  });

  $('start-game').addEventListener('click', startFromModeScreen);
  syncModeUI();
}

function syncModeUI() {
  const n0 = $('name-0');
  const n1 = $('name-1');
  const firstWrap = $('first-pick-wrap');
  if (mode === 'cpu') {
    if (n1.value === 'Player 2' || n1.value === '') n1.value = 'CPU';
    if (n0.value === 'Player 1' || n0.value === '') n0.value = 'Player';
    firstWrap.classList.remove('hidden');
    $('first-0').textContent = n0.value || 'Player';
    $('first-1').textContent = n1.value || 'CPU';
  } else {
    if (n0.value === 'Player') n0.value = 'Player 1';
    if (n1.value === 'CPU') n1.value = 'Player 2';
    // In 2P, first player is random (fair); hide the chooser.
    firstWrap.classList.add('hidden');
  }
}

function selectedFirst() {
  const el = document.querySelector('#first-pick button.selected');
  return el ? el.dataset.first : 'random';
}

function startFromModeScreen() {
  const config = makeConfig({
    swampRevealAll: $('v-thoughtseize').checked,
    blueDrawWhiteCloudshift: $('v-bluewhite').checked,
    copiesPerType: $('v-fifty').checked ? 10 : 5,
  });
  const names = [($('name-0').value || 'Player 1').trim(), ($('name-1').value || 'Player 2').trim()];

  let firstPlayer;
  if (mode === 'cpu') {
    const f = selectedFirst();
    firstPlayer = f === 'random' ? undefined : Number(f);
  } else {
    firstPlayer = undefined; // random in 2P
  }

  newGame({ mode, config, names, firstPlayer });
  $('mode-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
}

// =====================================================================
// GAME LIFECYCLE
// =====================================================================
function newGame(opts = {}) {
  if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null; }
  busy = false;
  mode = opts.mode || mode;
  const config = opts.config ? makeConfig(opts.config) : makeConfig();
  const names = opts.names;

  if (mode === 'cpu') {
    // Default: human is seat 0, CPU is seat 1, unless the caller overrides.
    cpuSeat = opts.cpuSeat != null ? opts.cpuSeat : 1;
    humanSeats = [other(cpuSeat)];
    viewerSeat = other(cpuSeat);
  } else {
    cpuSeat = null;
    humanSeats = [0, 1];
    viewerSeat = 0;
  }

  game = createGame({
    seed: opts.seed != null ? opts.seed : (Math.random() * 0xffffffff) >>> 0,
    config,
    names,
    firstPlayer: opts.firstPlayer,
  });

  // In 2P the first viewer is whoever must act first.
  if (mode === '2p' && game.awaiting) viewerSeat = game.awaiting.player;

  // Reset beat/glow tracking for the fresh game (don't replay setup log as beats).
  presentedLogLen = game.log.length;
  beatQueue = [];
  prevViewerHand = null;
  hideToast();

  window.blg.game = game;
  hideAllOverlays();
  $('mode-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
  render();
  drive();
  return game;
}

function hideAllOverlays() {
  ['handoff', 'decision', 'win-overlay'].forEach((id) => $(id).classList.add('hidden'));
}

// ---- Paced "beats" ---------------------------------------------------------
// In vs-CPU play the engine resolves several things in one step (you draw AND
// the CPU's turn begins; the CPU counters AND takes its turn). Without pacing,
// the human misses what just happened to them. A "beat" is a brief center-screen
// toast shown with a short pause before the game continues. Beats are a vs-CPU
// aid only; 2P handoffs already pace the game, and window.blg automation skips
// them entirely (it keeps presentedLogLen in sync without queuing).
function queueBeat(html, ms, kind) {
  beatQueue.push({ html, ms, kind: kind || '' });
}

function showToast(html, kind) {
  const el = $('toast');
  if (!el) return;
  el.className = 'toast k-' + (kind || '');
  el.innerHTML = html;
}

function hideToast() {
  const el = $('toast');
  if (el) el.className = 'toast hidden';
}

// Turn noteworthy log entries added since last time into beats. The events that
// matter most are the ones the CPU does TO the human, which otherwise scroll by.
function collectBeats() {
  const fresh = game.log.slice(presentedLogLen);
  presentedLogLen = game.log.length;
  if (mode !== 'cpu') return;
  const human = humanSeats[0];
  for (const e of fresh) {
    if (e.kind === 'countered') {
      const by = other(e.player);
      const whose = e.player === human ? 'your' : `${whoSpan(e.player)}’s`;
      queueBeat(`⚡ <b>Force of Will!</b> ${whoSpan(by)} countered ${whose} ${emoji(e.type)} <b>${name(e.type)}</b>.`, 1700, 'counter');
    } else if (e.kind === 'bog-discard' && e.target === human) {
      queueBeat(`💀 ${whoSpan(e.player)}’s Bog made you discard ${emoji(e.type)} <b>${name(e.type)}</b>.`, 1500, 'bog');
    } else if (e.kind === 'volcano-destroy' && e.target === human) {
      queueBeat(`💥 ${whoSpan(e.player)} destroyed your ${emoji(e.type)} <b>${name(e.type)}</b>.`, 1400, 'volcano');
    }
  }
}

// The driver: process whatever the engine is awaiting.
// - Pending beats: show one (with a pause), then continue.
// - CPU seats: auto-play (with delay) until human/over.
// - Human seats: show the appropriate prompt (and handoff in 2P).
function drive() {
  if (busy) return;
  if (!game) return;

  // Surface any queued beats first, one at a time, each holding for its duration.
  if (beatQueue.length) {
    const b = beatQueue.shift();
    busy = true;
    try { showToast(b.html, b.kind); } catch (err) { console.error('toast failed', err); }
    cpuTimer = setTimeout(() => {
      cpuTimer = null;
      busy = false; // release the guard first, so a later throw can't freeze the game
      hideToast();
      render();
      drive();
    }, b.ms);
    return;
  }

  if (game.winner) {
    showWin();
    return;
  }
  const aw = game.awaiting;
  if (!aw) return;

  // CPU turn?
  if (mode === 'cpu' && aw.player === cpuSeat) {
    runCpuStep();
    return;
  }

  // Human turn. In 2P, ensure the right player is holding the device.
  if (mode === '2p' && aw.player !== viewerSeat) {
    showHandoff(aw.player);
    return;
  }

  presentHumanDecision(aw);
}

function runCpuStep() {
  busy = true;
  cpuTimer = setTimeout(() => {
    cpuTimer = null;
    // Re-validate before acting: the game may have been reset or mutated (e.g.
    // a scenario set up via window.blg) between scheduling this timer and it
    // firing, so it might no longer be the CPU's decision. Bail quietly if so.
    const aw = game && game.awaiting;
    if (!aw || game.winner || aw.player !== cpuSeat) {
      busy = false;
      render();
      drive();
      return;
    }
    try {
      const action = chooseAction(game, cpuSeat);
      apply(game, action);
      collectBeats();
    } catch (err) {
      console.error('CPU step failed', err);
    } finally {
      // Always release the guard, even if something above throws, so the game
      // can never freeze with busy stuck true.
      window.blg.game = game;
      busy = false;
    }
    render();
    drive();
  }, CPU_DELAY);
}

// =====================================================================
// HUMAN DECISIONS
// =====================================================================
function presentHumanDecision(aw) {
  switch (aw.kind) {
    case 'mulligan': return promptMulligan(aw);
    case 'playLand': return promptPlayLand(aw);   // handled inline on the board (clickable hand)
    case 'counter': return promptCounter(aw);
    case 'scry': return promptScry(aw);
    case 'forestReturn': return promptPick(aw, 'forestReturn', aw.options,
      `${nameOf(aw.player)}'s Forest ♻️ — return a card from your discard pile to your hand.`);
    case 'volcanoDestroy': return promptPick(aw, 'volcanoDestroy', aw.options,
      `${nameOf(aw.player)}'s Volcano 💥 — destroy one of ${nameOf(aw.target)}'s lands.`);
    case 'cloudshift': return promptPick(aw, 'cloudshift', aw.options,
      `${nameOf(aw.player)}'s Cloudshift ✨ — re-trigger one of your lands in play.`);
    case 'bogReveal': return promptBogReveal(aw);
    case 'bogDiscard': return promptBogDiscard(aw);
    default:
      console.warn('Unknown awaiting kind', aw.kind);
  }
}

function doApply(action) {
  if (busy) return; // ignore stray clicks while a beat/handoff is in progress
  const human = mode === 'cpu' ? humanSeats[0] : null;
  const handBefore = human != null ? [...game.players[human].hand] : null;
  try {
    apply(game, action);
  } catch (err) {
    console.error('apply failed', action, err);
    return;
  }
  // Announce what the human drew/gained from their OWN action (e.g. a Meadow's
  // draw) before the CPU's turn can whisk it away.
  if (human != null) {
    for (const t of multisetDiff(game.players[human].hand, handBefore)) {
      queueBeat(`🃏 You drew ${emoji(t)} <b>${name(t)}</b>.`, 1100, 'draw');
    }
  }
  collectBeats();
  window.blg.game = game;
  hideDecision();
  render();
  drive();
}

// Cards present in `after` beyond what `before` accounts for (with multiplicity).
function multisetDiff(after, before) {
  const b = {};
  for (const t of before) b[t] = (b[t] || 0) + 1;
  const out = [];
  for (const t of after) {
    if (b[t] > 0) b[t]--;
    else out.push(t);
  }
  return out;
}

// ---- playLand: handled by clicking a hand card (see renderMyHand) ----------
function promptPlayLand() {
  // No modal — the player clicks a card in their hand. Just make sure the
  // board reflects that it's their move (render already did).
  hideDecision();
}

// ---- mulligan --------------------------------------------------------------
function promptMulligan(aw) {
  const banner = `${whoSpan(aw.player)} — your opening hand is dead (it can't do anything). Mulligan it?`;
  showDecision(banner, `
    <div class="decision-actions">
      <button class="btn-yes" id="mull-yes">Mulligan</button>
      <button class="btn-no" id="mull-no">Keep</button>
    </div>
  `);
  $('mull-yes').onclick = () => doApply({ type: 'mulligan', keep: false, player: aw.player });
  $('mull-no').onclick = () => doApply({ type: 'mulligan', keep: true, player: aw.player });
}

// ---- counter window --------------------------------------------------------
function promptCounter(aw) {
  const owner = other(aw.player);
  const costStr = Object.entries(aw.cost).map(([t, n]) => `${n}× ${emoji(t)}`).join(' + ');
  const banner = `${whoSpan(owner)} played ${emoji(aw.landType)} <b>${name(aw.landType)}</b>.` +
    ` Counter it with Force of Will? <span class="five-track">(cost: ${costStr})</span>`;
  showDecision(banner, `
    <div class="decision-actions">
      <button class="btn-confirm" id="ctr-yes">🛡️ Counter</button>
      <button class="btn-no" id="ctr-no">Pass</button>
    </div>
  `);
  $('ctr-yes').onclick = () => doApply({ type: 'counter', player: aw.player });
  $('ctr-no').onclick = () => doApply({ type: 'pass', player: aw.player });
}

// ---- scry ------------------------------------------------------------------
function promptScry(aw) {
  const banner = `${whoSpan(aw.player)}'s Tide 🔮 — Scry 1. Top of your deck:`;
  showDecision(banner, `
    <div class="decision-cards">
      <div class="decision-card" style="--c:${color(aw.top)}">
        <div class="dc-emoji">${emoji(aw.top)}</div>
        <div class="dc-name">${name(aw.top)}</div>
      </div>
    </div>
    <div class="decision-actions">
      <button class="btn-yes" id="scry-keep">Keep on top</button>
      <button class="btn-no" id="scry-bury">Bury to bottom</button>
    </div>
  `);
  $('scry-keep').onclick = () => doApply({ type: 'scry', keep: true, player: aw.player });
  $('scry-bury').onclick = () => doApply({ type: 'scry', keep: false, player: aw.player });
}

// ---- single-pick (forest / volcano / cloudshift) ---------------------------
function promptPick(aw, actionType, options, banner) {
  const cards = options.map((t) => `
    <div class="decision-card pick" data-card="${t}" style="--c:${color(t)}">
      <div class="dc-emoji">${emoji(t)}</div>
      <div class="dc-name">${name(t)}</div>
    </div>
  `).join('');
  showDecision(banner, `<div class="decision-cards">${cards}</div>`);
  document.querySelectorAll('#decision-body .pick').forEach((el) => {
    el.onclick = () => doApply({ type: actionType, card: el.dataset.card, player: aw.player });
  });
}

// ---- bogReveal (defender multi-selects exactly 3) --------------------------
function promptBogReveal(aw) {
  const hand = game.players[aw.player].hand; // defender's own hand (private to them)
  const banner = `${whoSpan(other(aw.player))}'s Bog 🗑️ — reveal exactly ${aw.count} cards from your hand of ${aw.handCount}. ` +
    `${whoSpan(other(aw.player))} will pick one for you to discard.`;
  // Render each card slot as individually selectable (duplicates allowed).
  const slots = hand.map((t, i) => `
    <div class="decision-card pick" data-idx="${i}" data-card="${t}" style="--c:${color(t)}">
      <div class="dc-emoji">${emoji(t)}</div>
      <div class="dc-name">${name(t)}</div>
    </div>
  `).join('');
  showDecision(banner, `
    <div class="decision-cards">${slots}</div>
    <div class="decision-actions">
      <button class="btn-confirm" id="bog-confirm" disabled>Reveal selected (0/${aw.count})</button>
    </div>
  `);
  const chosen = new Set();
  const confirm = $('bog-confirm');
  document.querySelectorAll('#decision-body .pick').forEach((el) => {
    el.onclick = () => {
      const idx = el.dataset.idx;
      if (chosen.has(idx)) { chosen.delete(idx); el.classList.remove('selected'); }
      else if (chosen.size < aw.count) { chosen.add(idx); el.classList.add('selected'); }
      confirm.textContent = `Reveal selected (${chosen.size}/${aw.count})`;
      confirm.disabled = chosen.size !== aw.count;
    };
  });
  confirm.onclick = () => {
    const cards = [...chosen].map((idx) => hand[Number(idx)]);
    doApply({ type: 'bogReveal', cards, player: aw.player });
  };
}

// ---- bogDiscard (attacker picks one revealed card) -------------------------
function promptBogDiscard(aw) {
  const banner = `${whoSpan(aw.player)}'s Bog 🗑️ — ${whoSpan(aw.defender)} revealed these. Pick one for them to discard.`;
  // Revealed may contain duplicates; collapse to distinct clickable types.
  const distinct = [...new Set(aw.revealed)];
  const counts = {};
  for (const t of aw.revealed) counts[t] = (counts[t] || 0) + 1;
  const cards = distinct.map((t) => `
    <div class="decision-card pick" data-card="${t}" style="--c:${color(t)}">
      <div class="dc-emoji">${emoji(t)}</div>
      <div class="dc-name">${name(t)}</div>
      ${counts[t] > 1 ? `<div class="dc-sub">×${counts[t]} revealed</div>` : ''}
    </div>
  `).join('');
  showDecision(banner, `<div class="decision-cards">${cards}</div>`);
  document.querySelectorAll('#decision-body .pick').forEach((el) => {
    el.onclick = () => doApply({ type: 'bogDiscard', card: el.dataset.card, player: aw.player });
  });
}

// =====================================================================
// HANDOFF (pass-and-play)
// =====================================================================
function showHandoff(nextSeat) {
  busy = true; // pause driving until acknowledged
  hideDecision();
  $('handoff-name').innerHTML = `Pass to ${whoSpan(nextSeat)}`;
  const aw = game.awaiting;
  let sub = 'Hand the device over, then tap when ready. Your opponent should not peek.';
  if (aw && aw.kind === 'counter') {
    sub = `${escapeHtml(nameOf(other(nextSeat)))} played a land — it's your chance to respond with Force of Will.`;
  }
  $('handoff-sub').textContent = sub;
  $('handoff').classList.remove('hidden');
  $('handoff-ready').onclick = () => {
    viewerSeat = nextSeat;
    prevViewerHand = null; // new perspective: don't glow the whole hand as "drawn"
    busy = false;
    $('handoff').classList.add('hidden');
    render();
    drive();
  };
}

// =====================================================================
// DECISION MODAL plumbing
// =====================================================================
function showDecision(bannerHtml, bodyHtml) {
  $('decision-banner').innerHTML = bannerHtml;
  $('decision-body').innerHTML = bodyHtml;
  $('decision').classList.remove('hidden');
}
function hideDecision() { $('decision').classList.add('hidden'); }

// =====================================================================
// RENDER
// =====================================================================
function render() {
  if (!game) return;
  // Whose perspective do we render? The viewer (2p) or the lone human (cpu).
  const seat = currentViewerSeat();
  const v = view(game, seat);

  renderStatusBar(v, seat);
  renderPanel($('opp-panel'), v, seat, /*isOpp*/ true);
  renderPanel($('me-panel'), v, seat, /*isOpp*/ false);
  renderLog(v);
  applyDrawGlow(v);
}

// Glow the viewer's newly-gained hand cards (draws, Forest returns) so a fresh
// card is obvious at a glance. prevViewerHand is reset on new game / handoff so
// switching perspective doesn't light up the whole hand.
function applyDrawGlow(v) {
  const cur = v.my.hand;
  if (prevViewerHand === null) { prevViewerHand = [...cur]; return; }
  const gained = multisetDiff(cur, prevViewerHand);
  prevViewerHand = [...cur];
  if (!gained.length) return;
  const need = {};
  for (const t of gained) need[t] = (need[t] || 0) + 1;
  const cards = [...document.querySelectorAll('#me-panel .card')];
  for (let i = cards.length - 1; i >= 0; i--) {
    const t = cards[i].dataset.card;
    if (need[t] > 0) { cards[i].classList.add('just-drawn'); need[t]--; }
  }
}

// In CPU mode the viewer is always the human; in 2P it is whoever holds device.
function currentViewerSeat() {
  if (mode === 'cpu') return humanSeats[0];
  return viewerSeat;
}

function renderStatusBar(v, seat) {
  const active = v.active;
  const pill = $('turn-pill');
  pill.className = '';
  pill.classList.add(`seat-${active}`);
  let label;
  if (game.winner) label = 'Game over';
  else if (mode === 'cpu' && active === cpuSeat) label = `${nameOf(active)} (CPU) thinking…`;
  else if (mode === '2p') label = `${nameOf(active)}'s turn`;
  else label = active === seat ? 'Your turn' : `${nameOf(active)}'s turn`;
  $('turn-text').textContent = label;
  pill.querySelector('#turn-text').textContent = label;

  // Variant tags
  const tags = [];
  if (v.config.swampRevealAll) tags.push('💀 Thoughtseize');
  if (v.config.blueDrawWhiteCloudshift) tags.push('🌊 Blue draws / 🌻 White flickers');
  if (v.config.copiesPerType >= 10) tags.push('🃏 50-card decks');
  $('variant-tags').innerHTML = tags.map((t) => `<span class="variant-tag">${t}</span>`).join('');
}

function renderPanel(el, v, viewSeat, isOpp) {
  const seat = isOpp ? v.opponent : v.me;
  const data = isOpp ? v.their : v.my;
  const counts = data.counts;
  const board = data.board;
  const onTurn = v.active === seat;

  el.classList.toggle('opp-of-me', isOpp);
  el.style.borderColor = onTurn
    ? (seat === 0 ? 'var(--p1)' : 'var(--p2)')
    : 'var(--accent-1)';

  const rainbow = TYPES.map((t) =>
    `<span class="gem ${counts[t] >= 1 ? 'lit' : ''}" title="${name(t)}">${emoji(t)}</span>`
  ).join('');

  // Tallest stack toward five-of-a-kind.
  let topType = TYPES[0], topCount = 0;
  for (const t of TYPES) if (counts[t] > topCount) { topCount = counts[t]; topType = t; }
  const fiveTrack = topCount > 0
    ? `${emoji(topType)} <b>${topCount}</b> / ${FIVE_OF_A_KIND}`
    : `— / ${FIVE_OF_A_KIND}`;

  // Board chips (grouped).
  const chips = TYPES.filter((t) => counts[t] > 0).map((t) =>
    `<span class="chip" style="--c:${color(t)}"><span class="em">${emoji(t)}</span>${name(t)} <span class="x">×${counts[t]}</span></span>`
  ).join('') || '<span class="empty-note">no lands in play yet</span>';

  // Discard pile (a.k.a. graveyard) — PUBLIC info in this game, so we show its
  // grouped contents at a glance for both players. Dimmed/dashed to read as
  // "seen but not in play" — handy for tracking copies toward five-of-a-kind.
  const discCounts = TYPES.reduce((m, t) => ((m[t] = 0), m), {});
  for (const t of data.discard) discCounts[t]++;
  const discChips = TYPES.filter((t) => discCounts[t] > 0).map((t) =>
    `<span class="chip disc" style="--c:${color(t)}" title="${name(t)} ×${discCounts[t]} in discard"><span class="em">${emoji(t)}</span><span class="x">×${discCounts[t]}</span></span>`
  ).join('');
  const discardRow = `<div class="graveyard-row"><span class="zone-label" title="Discard pile (public)">🗑️</span>${
    discChips || '<span class="empty-note">empty</span>'
  }</div>`;

  // Hand region differs for me vs opponent.
  let handHtml;
  if (isOpp) {
    handHtml = renderFacedownHand(data.handCount);
  } else {
    handHtml = renderMyHand(v, data.hand, seat);
  }

  const meta = `
    <span class="meta-chip">🃏 hand ${isOpp ? data.handCount : data.hand.length}</span>
    <span class="meta-chip">📚 deck ${data.deckCount}</span>
  `;

  const distLabel = data.distance === 0 ? 'WINNING' : `${data.distance} to win`;

  el.innerHTML = `
    <div class="panel-head">
      <div class="panel-name">
        <span class="who-${seat}">${escapeHtml(nameOf(seat))}</span>
        ${isOpp ? '<span style="font-size:0.8rem;color:var(--text-secondary)">(opponent)</span>' : ''}
        ${onTurn ? '<span class="turn-dot" style="color:' + (seat === 0 ? 'var(--p1)' : 'var(--p2)') + '"></span>' : ''}
      </div>
      <div class="panel-meta">${meta}</div>
    </div>
    <div class="progress-row">
      <div class="rainbow" title="Rainbow: one of each land">${rainbow}</div>
      <div class="five-track">${fiveTrack}</div>
      <div class="distance-badge">${distLabel}</div>
    </div>
    <div class="board-chips">${chips}</div>
    ${discardRow}
    ${handHtml}
  `;

  // Wire up clickable hand cards (only for the human whose turn it is to play a land).
  if (!isOpp) {
    const aw = game.awaiting;
    const canPlay = aw && aw.kind === 'playLand' && aw.player === seat && isHuman(seat) &&
      (mode === 'cpu' || seat === viewerSeat);
    if (canPlay) {
      el.querySelectorAll('.card.clickable').forEach((cardEl) => {
        cardEl.addEventListener('click', () => {
          doApply({ type: 'playLand', card: cardEl.dataset.card, player: seat });
        });
      });
    }
  }
}

function renderFacedownHand(count) {
  const backs = Array.from({ length: count }, () => '<div class="card-back">🂠</div>').join('');
  return `
    <div class="hand-label">Hand (${count})</div>
    <div class="hand facedown">${backs || '<span class="empty-note">empty hand</span>'}</div>
  `;
}

function renderMyHand(v, hand, seat) {
  const aw = game.awaiting;
  const myTurnToPlay = aw && aw.kind === 'playLand' && aw.player === seat && isHuman(seat) &&
    (mode === 'cpu' || seat === viewerSeat);

  // Group identical cards but render each as its own card so each is clickable.
  const cards = hand.map((t) => {
    const isTide = t === 'tide';
    const fow = isTide ? `<div class="c-fow">🛡️ In hand: Force of Will</div>` : '';
    return `
      <div class="card ${myTurnToPlay ? 'clickable' : ''}" data-card="${t}" style="--c:${color(t)}">
        <div class="c-top"><span class="c-emoji">${emoji(t)}</span><span class="c-name">${name(t)}</span></div>
        <div class="c-effect">${effectText(t, v.config)}</div>
        ${fow}
      </div>
    `;
  }).join('') || '<span class="empty-note">empty hand</span>';

  const hint = myTurnToPlay ? ' — click a card to play it' : '';
  return `
    <div class="hand-label">Your hand (${hand.length})${hint}</div>
    <div class="hand">${cards}</div>
  `;
}

// ---- log -------------------------------------------------------------------
const LOG_ICON = {
  start: '🚩', draw: '🃏', mulligan: '♻️', play: '▶️', enter: '✅',
  countered: '🚫', counter: '🛡️', win: '🏆', 'effect-draw': '🃏',
  'scry-keep': '🔮', 'scry-bury': '🔮', 'forest-return': '♻️',
  'volcano-destroy': '💥', 'bog-reveal': '👁️', 'bog-discard': '🗑️',
  'cloudshift': '✨', 'cloudshift-done': '✨', reshuffle: '🔄',
};

function renderLog(v) {
  const logEl = $('log');
  const entries = v.log.map((e) => {
    const icon = LOG_ICON[e.kind] || '•';
    let msg = escapeHtml(e.msg);
    // Color player names in the message.
    for (let s = 0; s < 2; s++) {
      const n = escapeHtml(nameOf(s));
      if (n) msg = msg.split(n).join(`<span class="who-${s}">${n}</span>`);
    }
    return `<div class="log-entry k-${e.kind || ''}">${icon} ${msg}</div>`;
  }).join('');
  logEl.innerHTML = entries;
  logEl.scrollTop = logEl.scrollHeight;
}

// =====================================================================
// WIN SCREEN
// =====================================================================
function showWin() {
  const w = game.winner;
  if (!w) return;
  hideDecision();
  $('handoff').classList.add('hidden');
  const cond = w.condition === 'rainbow' ? 'Rainbow 🌈' : 'Five of a Kind 🎰';
  $('win-emoji').textContent = w.condition === 'rainbow' ? '🌈' : '🎰';
  $('win-title').textContent = `${nameOf(w.player)} wins!`;
  $('win-cond').textContent = `by ${cond}`;
  $('win-overlay').classList.remove('hidden');
}

// =====================================================================
// RULES MODAL
// =====================================================================
function buildRulesContent() {
  const cfg = game ? game.config : makeConfig();
  const cards = TYPES.map((t) => {
    const c = CARDS[t];
    return `
      <div class="rule-card" style="--c:${c.color}">
        <div class="rc-emoji">${c.emoji}</div>
        <div>
          <div class="rc-name">${c.name}</div>
          <div class="rc-effect">${effectText(t, cfg)}${t === 'tide' ? ' <i>' + escapeHtml(c.inHand) + '</i>' : ''}</div>
          <div class="rc-mtg">MTG: ${escapeHtml(c.mtg)}</div>
        </div>
      </div>
    `;
  }).join('');

  const variants = [];
  if (cfg.swampRevealAll) variants.push('💀 Thoughtseize Bog (reveal whole hand)');
  if (cfg.blueDrawWhiteCloudshift) variants.push('🌊 Blue draws / 🌻 White flickers');
  if (cfg.copiesPerType >= 10) variants.push('🃏 50-card decks (10 of each)');
  const variantsHtml = variants.length
    ? `<ul>${variants.map((x) => `<li>${x}</li>`).join('')}</ul>`
    : '<p>None — base rules.</p>';

  $('rules-content').innerHTML = `
    <div class="rules-section">
      <h3>Goal</h3>
      <p>Win by <b>Rainbow</b> (one of each of the five lands in play) or <b>Five-of-a-Kind</b> (five copies of one land in play).</p>
    </div>
    <div class="rules-section">
      <h3>Each turn</h3>
      <p>Draw a card (except the very first turn), then take your one action: <b>play a land from hand</b>. Its enter-effect resolves, then the turn passes.</p>
    </div>
    <div class="rules-section">
      <h3>The five lands</h3>
      ${cards}
    </div>
    <div class="rules-section">
      <h3>Force of Will (Tide)</h3>
      <p>A Tide in your hand can <b>counter</b> an opponent's land drop: discard it plus a matching land. A Force of Will can itself be countered by pitching <b>two Tides</b> — the engine resolves the whole war and just asks you to counter or pass.</p>
    </div>
    <div class="rules-section">
      <h3>Mulligan</h3>
      <p>You may only mulligan a "dead" opening hand that the rules flag (nothing playable). The game offers it automatically when eligible.</p>
    </div>
    <div class="rules-section">
      <h3>Active variants</h3>
      ${variantsHtml}
    </div>
  `;
}

// =====================================================================
// WINDOW.BLG — agent test API
// =====================================================================
function legalActionsFor(aw) {
  if (!aw) return [];
  switch (aw.kind) {
    case 'mulligan': return [{ type: 'mulligan', keep: true }, { type: 'mulligan', keep: false }];
    case 'playLand': return aw.options.map((t) => ({ type: 'playLand', card: t }));
    case 'counter': return [{ type: 'counter' }, { type: 'pass' }];
    case 'scry': return [{ type: 'scry', keep: true }, { type: 'scry', keep: false }];
    case 'forestReturn': return aw.options.map((t) => ({ type: 'forestReturn', card: t }));
    case 'volcanoDestroy': return aw.options.map((t) => ({ type: 'volcanoDestroy', card: t }));
    case 'cloudshift': return aw.options.map((t) => ({ type: 'cloudshift', card: t }));
    case 'bogDiscard': return [...new Set(aw.revealed)].map((t) => ({ type: 'bogDiscard', card: t }));
    case 'bogReveal': {
      // Enumerating all 3-subsets is overkill; the AI provides a concrete one.
      try { return [chooseAction(game, aw.player)]; } catch { return []; }
    }
    default: return [];
  }
}

function setupAgentApi() {
  window.blg = {
    game,
    view(seat) {
      const s = seat != null ? seat : (game && game.awaiting ? game.awaiting.player : 0);
      return view(game, s);
    },
    state() { return fullState(game); },
    apply(action) {
      apply(game, action);
      presentedLogLen = game.log.length; // automation bypasses paced beats
      window.blg.game = game;
      render();
      drive();
      return game.awaiting;
    },
    ai(seat) {
      const s = seat != null ? seat : (game && game.awaiting ? game.awaiting.player : 0);
      return chooseAction(game, s);
    },
    step() {
      if (!game || !game.awaiting) return null;
      const s = game.awaiting.player;
      const action = chooseAction(game, s);
      apply(game, action);
      presentedLogLen = game.log.length; // automation bypasses paced beats
      window.blg.game = game;
      render();
      drive();
      return game.awaiting;
    },
    options() {
      const aw = game ? game.awaiting : null;
      return { awaiting: aw, legalActions: legalActionsFor(aw) };
    },
    // Re-render from the current (possibly hand-mutated) game state without
    // applying an action — handy when setting up a scenario via window.blg.game.
    rerender: () => { render(); return game ? game.awaiting : null; },
    newGame(opts = {}) {
      // Map a friendly {mode,config,seed,firstPlayer} into a fresh game.
      return newGame({
        mode: opts.mode || mode,
        config: opts.config,
        seed: opts.seed,
        firstPlayer: opts.firstPlayer,
        names: opts.names,
        cpuSeat: opts.cpuSeat,
      });
    },
  };
}

// =====================================================================
// BOOT
// =====================================================================
function boot() {
  setupAgentApi();
  initModeScreen();

  $('btn-rules').addEventListener('click', () => {
    buildRulesContent();
    $('rules-modal').classList.remove('hidden');
  });
  $('btn-close-rules').addEventListener('click', () => $('rules-modal').classList.add('hidden'));
  $('rules-modal').addEventListener('click', (e) => {
    if (e.target === $('rules-modal')) $('rules-modal').classList.add('hidden');
  });

  $('btn-menu').addEventListener('click', () => {
    if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null; }
    busy = false;
    hideAllOverlays();
    $('app').classList.add('hidden');
    $('mode-overlay').classList.remove('hidden');
  });

  $('btn-play-again').addEventListener('click', () => {
    $('win-overlay').classList.add('hidden');
    $('app').classList.add('hidden');
    $('mode-overlay').classList.remove('hidden');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
