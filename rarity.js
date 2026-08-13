// ─── RARITY HELPERS ─────────────────────────────────────────────────────────

// Returns true if the card number exceeds the set total (e.g. 231/236 → false, 237/236 → true)
function isBeyondSetTotal(num) {
  if (!num) return false;
  const parts = num.split('/');
  if (parts.length !== 2) return false;
  const n = parseInt(parts[0], 10);
  const total = parseInt(parts[1], 10);
  return !isNaN(n) && !isNaN(total) && n > total;
}

function rarityClass(r, name, num) {
  if (!r) return 'pill-default';
  const l = r.toLowerCase();
  const isFull = isBeyondSetTotal(num);
  if (r === 'MEGA_ATTACK_RARE' || l.includes('mega attack')) return 'pill-mar';
  if (l.includes('mega hyper')) return 'pill-mhr';
  if (l.includes('special illustration')) return 'pill-sir';
  if (l === 'shiny ultra rare') return 'pill-shinyur';
  if (l.includes('hyper rare')) return 'pill-hr';
  if (l === 'tag team') return isFull ? 'pill-fatagteam' : 'pill-tagteam';
  if (l.includes('rare rainbow')) return 'pill-rainbow';
  if (l === 'galarian gallery') return 'pill-gg';
  if (l.includes('trainer gallery')) return 'pill-tg';
  if (l.includes('ace spec')) return 'pill-acespec';
  if (l === 'classic collection') return 'pill-classic';
  if (l.includes('shiny gx')) return 'pill-shgx';
  if (l === 'rare shiny') return 'pill-shiny';
  if (l === 'shiny rare') return 'pill-shinyr';
  if (l.includes('amazing rare')) return 'pill-amazing';
  if (l.includes('radiant rare')) return 'pill-radiant';
  if (l.includes('rare secret') || l.includes('secret rare')) return 'pill-sr';
  if (l.includes('rare ultra')) return isFull ? 'pill-fullart' : 'pill-default';
  if (l === 'illustration rare') return 'pill-ir';
  if (l === 'double rare') return 'pill-default';
  if (l.includes('gold star')) return 'pill-gs';
  if (l.includes('rare shining')) return 'pill-shine';
  if (l.includes('legend')) return 'pill-legend';
  if (l.includes('lv.x') || l.includes('lv x')) return 'pill-lv';
  if (l.includes('prime')) return 'pill-prime';
  if (l.includes('rare break')) return 'pill-break';
  if (l.includes('holo star')) return 'pill-star';
  if (l.includes('rare holo')) return 'pill-holo';
  return 'pill-default';
}

function shortRarity(r, name, num, subtypes, supertype) {
  if (!r) return '?';
  const isFull = isBeyondSetTotal(num);
  // BUG FIX (2026-07-30): Trainer Gallery V / VMAX / VSTAR cards (raw rarity
  // "Rare Holo V"/"Rare Holo VMAX"/"Rare Holo VSTAR") were falling through to
  // the generic "Rare Holo" -> RH mapping below, since only the plain
  // "Trainer Gallery Rare Holo" rarity string had its own map entry. The
  // filter dropdown already correctly buckets ALL FOUR of these raw rarities
  // into "Trainer Gallery" (see TG_RARITY_STRINGS) — so filtering by Trainer
  // Gallery correctly returned these cards, but their pill still showed RH
  // instead of TG. Card numbers in these Trainer Gallery subsets always
  // carry a "TG" prefix (e.g. "TG12"), which is the same signal
  // TG_RARITY_STRINGS-based logic relies on structurally.
  // BUG FIX (2026-07-31): full-art Trainer-supertype cards inside the SAME
  // Trainer Gallery subsets (Allister, Bea, Nessa, Boss's Orders, etc. —
  // numbered TG24-TG30 in Astral Radiance/Lost Origin) carry raw rarity
  // "Rare Ultra", which was never added to TG_RARITY_STRINGS (deliberately —
  // that set is also used elsewhere to classify ordinary non-TG Rare Ultra
  // cards, like Full Art EX/GX, which must NOT get swept into "Trainer
  // Gallery"). Gating on TG_RARITY_STRINGS membership caused these specific
  // cards to fall through to their raw "Rare Ultra" pill instead of "TG".
  // The TG\d+ card-number prefix alone is an unambiguous, structural signal
  // for "this card lives in a Trainer Gallery subset" regardless of its raw
  // rarity string, so it's now sufficient on its own — no rarity-string
  // gate needed.
  if (/^TG\d+$/i.test((num || '').trim())) return 'TG';
  // Tag Team synthetic rarity — already rewritten in normalizeCard
  if (r === 'Tag Team') return isFull ? 'TGTM' : 'TAG';
  // Rare Ultra: Full Art if beyond set total; otherwise defer to rareUltraBucket()
  // — the SAME classifier the rarity filter dropdown uses — so the pill shown
  // on a card always agrees with which filter bucket it falls into.
  if (r === 'Rare Ultra') {
    if (isFull) return 'FA';
    const bucket = rareUltraBucket({ name, subtypes, supertype });
    if (bucket === '__GX__') return 'GX';
    if (bucket === '__EX__') return 'EX';
    if (bucket === '__FA_POKEMON__') return 'FA';
    return 'FAT';
  }
  // Rare Rainbow: Full Art if beyond set total
  if (r === 'Rare Rainbow') {
    if (isFull) return 'FA';
  }
  // FEATURE (2026-07-30): every rarity now maps to a distinct code, 4
  // characters max (LV.X and the two ★-suffixed codes are the only
  // exceptions, since those symbols/dots are already compact and
  // well-established shorthand on their own). No two rarities share a code
  // — verified by hand when this list was built; if you add a new rarity
  // here, double-check it against every other value before committing.
  const map = {
    'MEGA_ATTACK_RARE':          'MAR',
    'Mega Attack Rare':          'MAR',
    'Hyper Rare':                'HYPR',
    'Special Illustration Rare': 'SIR',
    'Shiny Ultra Rare':          'SHUR',
    'Rainbow Rare':              'RBOW',
    'Rare Rainbow':              'RBOW',
    'Galarian Gallery':          'GG',
    'Trainer Gallery Rare Holo': 'TG',
    'ACE SPEC Rare':             'ACE',
    'Classic Collection':        'CLSC',
    'Rare Shiny GX':             'SHGX',
    // 'Rare Shiny' (plain, non-GX) removed 2026-07-30 — no longer a
    // tracked chase rarity; see PINNED_CARD_IDS comment in the collector.
    'Shiny Rare':                'SHYR',
    'Amazing Rare':              'AMAZ',
    'Radiant Rare':              'RADT',
    'Rare Secret':               'SECR',
    'Secret Rare':               'SECR',
    'Tag Team':                  'TGTM',
    'Rare Ultra':                'EX/GX',
    'Illustration Rare':         'IR',
    'Double Rare':               'DR',
    'Gold Star':                 '★',
    'Rare Shining':              'SHNG',
    'LEGEND':                    'LGND',
    'LV.X':                      'LV.X',
    'Rare Prime':                'PRIM',
    'Rare BREAK':                'BRK',
    'Rare Holo Star':            'HO★',
    'Rare Holo':                 'RH',
  };
  for (const [k, v] of Object.entries(map)) {
    if (r.includes(k)) return v;
  }
  return r.length > 18 ? r.slice(0, 16) + '…' : r;
}


// FEATURE (2026-08-02): lowered from 14 to 7 days per request — a card's
// "Last Priced" date is only allowed to advance when a genuine fresh price
// was confirmed (see the Last Priced fix in POKEMON_RARITY_COLLECTOR.py,
// 2026-08-02) — before that fix this badge could stay silent indefinitely on
// a card whose price feed had been dead for months, since a carried-forward
// value kept re-stamping the date as if it were fresh. 7 days gives a much
// earlier heads-up once a card's price genuinely stops updating.
const STALE_PRICE_DAYS = 7;
// A second, more urgent tier — 30+ days unpriced is a real, probably
// permanent data gap (e.g. a card whose TCGplayer listing pokemontcg.io has
// stopped tracking entirely), not just an unlucky API day. Colored red
// instead of yellow so severity is visible at a glance.
const STALE_PRICE_DAYS_SEVERE = 30;

// Returns HTML for a staleness note (text pill, used in the modal), or ''
// if not stale / not applicable. Only surfaces once a card's price has gone
// unresolved for a while, so a single bad-API-day doesn't trigger noise.
function stalePriceBadge(c) {
  const noPrice = !c.price || c.price === 'N/A';
  const days = daysSince(c.lastPriced);
  if (noPrice) {
    const checkedDays = daysSince(c.lastChecked);
    if (days === null) {
      return `<span class="price-stale" title="No price has ever been fetched for this card">Never priced</span>`;
    }
    return `<span class="price-stale" title="Last real price was ${days} day(s) ago (last checked ${checkedDays !== null ? checkedDays + ' day(s) ago' : 'unknown'})">Stale ${days}d</span>`;
  }
  // Has a current price, but flag if it's suspiciously old (e.g. fallback-preserved for weeks)
  if (days !== null && days >= STALE_PRICE_DAYS) {
    return `<span class="price-stale" title="Price last confirmed ${days} days ago">Stale ${days}d</span>`;
  }
  return '';
}

// FEATURE (2026-08-02): compact warning icon (no text) for list rows / grid
// tiles, sitting right next to the price — the text pill above is reserved
// for the modal, where there's room to spell it out. Yellow ⚠ once a price
// has gone STALE_PRICE_DAYS (7) without a genuine refresh; red ⚠ once it
// crosses STALE_PRICE_DAYS_SEVERE (30), signaling a likely permanent data
// gap rather than a temporary API hiccup. Returns '' if not stale.
function staleWarningIcon(c) {
  // FEATURE (2026-08-02): hidden entirely in read-only share view, same
  // reasoning as the 70%-of-market badge and price-change % — this is
  // owner-facing data-pipeline signal (pokemontcg.io feed health), not
  // something a visitor browsing someone else's collection needs to see.
  if (READ_ONLY_SHARE) return '';
  const noPrice = !c.price || c.price === 'N/A';
  const days = daysSince(c.lastPriced);
  if (days === null) {
    // Never priced at all — only worth flagging if there's at least some
    // price on screen to sit next to (an outright "—"/N/A price already
    // reads as missing data on its own, no icon needed to pile on).
    return '';
  }
  if (noPrice) return '';
  if (days >= STALE_PRICE_DAYS_SEVERE) {
    return `<span class="price-stale-icon severe" title="Price last confirmed ${days} days ago — likely a permanent data gap">⚠</span>`;
  }
  if (days >= STALE_PRICE_DAYS) {
    return `<span class="price-stale-icon" title="Price last confirmed ${days} days ago">⚠</span>`;
  }
  return '';
}

function priceVal(p) {
  if (!p || p === 'N/A') return -1;
  return parseFloat(p.replace(/[^0-9.]/g, '')) || 0;
}

// FEATURE (2026-07-29): "70%" price — exactly 70% of the current market
// price. Computed on the fly from c.price at render time rather than stored
// in the CSV: it's a single multiplication, always stays in sync with the
// live market price with zero extra collector/storage cost, and needs no
// schema change. Returns '' (nothing rendered) when there's no real market
// price to base it on.
function seventyPercentVal(c) {
  const v = priceVal(c.price);
  return v > 0 ? v * 0.7 : null;
}
function seventyPercentLabel(c) {
  const v = seventyPercentVal(c);
  return v !== null ? `$${v.toFixed(2)}` : null;
}
// Compact inline HTML badge — used in list rows / grid tiles where space is
// tight, styled to sit quietly next to the main price rather than compete
// with it.
function seventyPercentBadgeHtml(c) {
  // FEATURE (2026-08-02): hidden entirely in read-only share view — a
  // visitor browsing someone else's collection has no use for "what to pay"
  // guidance on cards they don't own, and it's not the owner's info to show.
  if (READ_ONLY_SHARE) return '';
  const label = seventyPercentLabel(c);
  return label ? `<span class="price-70pct" title="70% of market price">70%: ${label}</span>` : '';
}

// FEATURE (2026-08-12): condition-tiered pricing (NM/LP/MP/HP/DMG), shown
// only in the card detail modal (not list/grid — those stay single-price to
// avoid crowding). No live per-condition API is used here — condition
// pricing data from every source we evaluated (TCG API's Pro-tier endpoint,
// JustTCG's free tier) was either paywalled or unreliable on thin-volume
// vintage cards (e.g. a Base Set Shadowless Charizard whose "Moderately
// Played" price came back at $10,000 — 40x its Near Mint price — clearly a
// single bad/thin-sample listing dominating the number with no real trading
// volume to correct it). Instead this is a flat, deterministic formula
// applied to the market price we already have: condition_price = market
// price × tier% × 0.70. The 0.70 factor is the SAME 70%-of-market vendor
// discount as seventyPercentVal() above (NM here reuses that exact value —
// they're the same number, not two independent calculations, so they never
// drift out of sync). The tier percentages (NM 100%, LP 80%, MP 50%, HP 30%,
// DMG 10%) are a standard collector/vendor rule-of-thumb ladder, not a
// TCGplayer-published standard — real vintage/high-value cards can deviate
// from flat percentages (e.g. HP+ demand often craters harder than 30% on
// $1,000+ cards), but a flat ladder is the right first pass for a single
// formula covering every card in the app uniformly.
const CONDITION_TIERS = [
  { key: 'NM',  label: 'Near Mint',        pct: 1.00 },
  { key: 'LP',  label: 'Lightly Played',   pct: 0.80 },
  { key: 'MP',  label: 'Moderately Played', pct: 0.50 },
  { key: 'HP',  label: 'Heavily Played',   pct: 0.30 },
  { key: 'DMG', label: 'Damaged',          pct: 0.10 },
];
function conditionPrices(c) {
  const v = priceVal(c.price);
  if (v <= 0) return null;
  const base = v * 0.70; // same 70%-of-market factor as seventyPercentVal()
  return CONDITION_TIERS.map(t => ({
    key: t.key,
    label: t.label,
    value: base * t.pct,
  }));
}

// FEATURE (2026-08-08): "% change" everywhere in the app now compares
// today's price against the price from ~7 days ago, not against yesterday's
// "Previous Price" column (which only ever reflects the single most recent
// prior day the collector ran — a one-day-over-one-day comparison, not a
// weekly trend). PRICE_HISTORY[cardId] (loaded from card-price-history.json,
// see app.js's tryAutoLoad) holds a real per-day timeline, so the 7-day-ago
// price can be looked up directly from it instead of adding a new CSV
// column. Finds the history entry closest to (today - days) without going
// OVER that many days back — i.e. the most recent entry that is at least
// `days` old — so a slightly irregular collector schedule (a skipped day,
// a late-night run) doesn't break the lookup. Returns null if there's no
// history entry old enough yet (e.g. a card added to the app less than a
// week ago) — callers should treat null the same as "no previous price".
function getPriceNDaysAgo(cardId, days) {
  const history = (typeof PRICE_HISTORY !== 'undefined' && PRICE_HISTORY[cardId]) || [];
  if (history.length === 0) return null;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
  // history entries are appended in chronological order by the collector —
  // walk backward from the end (most recent first) and take the first entry
  // whose date is on or before the cutoff, i.e. the most recent one that's
  // still at least `days` old.
  for (let i = history.length - 1; i >= 0; i--) {
    const entryDate = new Date(history[i].d + 'T00:00:00');
    if (entryDate <= cutoff) return history[i].p;
  }
  // Every entry is more recent than the cutoff — no data old enough yet.
  return null;
}

// Returns HTML badge string for price change, or ''. Compares the current
// price against the price from 7 days ago (see getPriceNDaysAgo) rather than
// yesterday's single prior value.
function priceChangeBadge(current, cardId) {
  // FEATURE (2026-08-02): price-change % hidden entirely in read-only share
  // view, same reasoning as the 70%-of-market badge — not useful/appropriate
  // to show a visitor browsing someone else's collection.
  if (READ_ONLY_SHARE) return '';
  const cv = priceVal(current);
  const pv7 = getPriceNDaysAgo(cardId, 7);
  if (cv < 0 || pv7 === null || pv7 <= 0) return '';
  const delta = cv - pv7;
  const pct = (delta / pv7) * 100;
  if (Math.abs(delta) < 0.01) return '<span class="price-change price-flat">—</span>';
  const arrow = delta > 0 ? '↑' : '↓';
  const cls = delta > 0 ? 'price-up' : 'price-down';
  const sign = delta > 0 ? '+' : '';
  return `<span class="price-change ${cls}">${arrow} ${sign}${pct.toFixed(1)}%</span>`;
}

const RARITY_DISPLAY = {
  'Hyper Rare':               'Hyper Rare',
  'MEGA_ATTACK_RARE':         'Mega Attack Rare',
  'Special Illustration Rare':'Special Illustration Rare',
  'Illustration Rare':        'Illustration Rare',
  'Shiny Ultra Rare':         'Shiny Ultra Rare',
  'Shiny Rare':               'Shiny Rare',
  'Tag Team':                 'Tag Team',
  'Rainbow Rare':             'Rainbow Rare',
  'Rare Rainbow':             'Rainbow Rare',
  'Galarian Gallery':         'Galarian Gallery',
  'Trainer Gallery Rare Holo':'Trainer Gallery',
  'ACE SPEC Rare':            'ACE SPEC Rare',
  'Classic Collection':       'Classic Collection',
  'Rare Shiny GX':            'Rare Shiny GX',
  'Amazing Rare':             'Amazing Rare',
  'Radiant Rare':             'Radiant Rare',
  'Rare Secret':              'Secret Rare',
  'Rare Ultra':               'Full Art (ex / GX)',
  'Gold Star':                'Gold Star',
  'LEGEND':                   'LEGEND',
  'LV.X':                     'LV.X',
  'Rare Prime':               'Rare Prime',
  'Rare Holo Star':           'Rare Holo Star',
  'Rare Shining':             'Rare Shining',
  'Rare Holo':                'Rare Holo',
};

// All TG rarity strings that map to the single "Trainer Gallery" filter option
const TG_RARITY_STRINGS = new Set(['Trainer Gallery Rare Holo','Rare Holo V','Rare Holo VMAX','Rare Holo VSTAR']);

// Classify a "Rare Ultra" card into a real sub-type. Tag Team cards (name has
// "&") are normalized to 'Tag Team' upstream already and never reach this
// function with rarity === 'Rare Ultra'.
//
// Prefers the API's `subtypes` field (e.g. ["Basic","EX"] or ["Basic","GX"])
// when available — this is ground truth from the game data itself, unlike
// scanning the printed name, which misses cards like classic Full Art
// Legendary "Reshiram" (Black & White base set) that carry EX/GX status only
// in their subtype, not in the printed card name.
// Falls back to name-matching for older rows fetched before the Subtypes
// column existed, or fallback-preserved rows where subtypes came back empty.
// A card with neither an EX/GX subtype/name-match nor a Trainer supertype is
// a plain Full Art Pokémon (e.g. non-EX Reshiram/Zekrom) — its own bucket,
// so it no longer gets lumped in with real Trainer cards.
function rareUltraBucket(c) {
  const subtypes = c.subtypes || [];
  if (subtypes.length > 0) {
    if (subtypes.includes('GX')) return '__GX__';
    if (subtypes.includes('EX')) return '__EX__';
    if (c.supertype && c.supertype !== 'Pokémon') return '__FA_TRAINER__';
    return '__FA_POKEMON__';
  }
  // No subtypes data (older row / fallback-preserved) — fall back to name matching.
  if (/GX\b/.test(c.name)) return '__GX__';
  if (/-EX\b|\bEX\b/i.test(c.name)) return '__EX__';
  return '__FA_TRAINER__';
}

// ─── Rarity sort priority — rarest first within each set ─────────────────────
const RARITY_ORDER = [
  // ── Scarlet & Violet era (rarest first) ──────────────────────────────────
  'Hyper Rare',                // SV gold card apex (~1:1260)
  'MEGA_ATTACK_RARE',          // MAR — secret-numbered beyond set total; scarcer than most SIRs
  'Special Illustration Rare', // SIR — full-art painterly chase tier
  'ACE SPEC Rare',             // ACE SPEC — 1-per-deck mechanic
  'Shiny Ultra Rare',          // Paldean Fates shiny ex
  'Illustration Rare',         // IR ~1:10-12
  // Double Rare removed 2026-07-30 — no longer a tracked chase rarity.
  // ── Sword & Shield era ───────────────────────────────────────────────────
  'Galarian Gallery',          // Crown Zenith GG (synthetic rarity)
  'Rare Holo VMAX',            // TG VMAX sub-tier
  'Rare Holo VSTAR',           // TG VSTAR sub-tier
  'Rare Holo V',               // TG V sub-tier
  'Trainer Gallery Rare Holo', // TG base holo sub-tier
  'Rainbow Rare',              // SWSH Rainbow Rare
  'Rare Rainbow',              // SM Rainbow Rare
  'Rare Shiny GX',             // Shiny Vault GX (Hidden/Shining Fates)
  // 'Rare Shiny' removed 2026-07-30 — no longer tracked (was bulk tier).
  'Amazing Rare',              // SWSH Amazing Rare
  // ── Sun & Moon era ───────────────────────────────────────────────────────
  'Tag Team',                  // SM Tag Team GX (synthetic)
  'Rare Secret',               // Gold-border Secret Rares (SM+)
  'Radiant Rare',              // SWSH Radiant — 1-per-deck
  'Rare Ultra',                // Full Art GX / Supporter FA
  // ── EX era ───────────────────────────────────────────────────────────────
  'Gold Star',                 // EX Gold Star ★ (~1:72 packs) — rarest EX era card
  // ── Neo / E-Card era ─────────────────────────────────────────────────────
  'Rare Shining',              // Neo Shining Pokémon (Charizard, Mewtwo, Tyranitar tier)
  // ── HGSS era ─────────────────────────────────────────────────────────────
  'LEGEND',                    // HGSS dual-card pairs
  'Rare Prime',                // HGSS Prime
  // ── Diamond & Pearl / Platinum ───────────────────────────────────────────
  'LV.X',                      // DP/Platinum LV.X
  'Rare Holo Star',            // DP Holo Star
  // ── Vintage / Base-WOTC era ──────────────────────────────────────────────
  'Promo',                     // WOTC Black Star Promos
  'Rare Holo',                 // Standard Rare Holo (vintage & modern)
  // ── Base rarity tiers (e.g. Legendary Collection reverse holos) ──────────
  'Rare',                      // Base "Rare" tier — below Rare Holo
  'Uncommon',                  // Below Rare
  'Common',                    // Below Uncommon — least rare
];
function rarityRank(r, subtypes) {
  if (subtypes && subtypes.includes && subtypes.includes('Gold Star')) return RARITY_ORDER.indexOf('Gold Star');
  if (subtypes && subtypes.includes && subtypes.includes('LEGEND')) return RARITY_ORDER.indexOf('LEGEND');
  if (subtypes && subtypes.includes && subtypes.includes('LV.X')) return RARITY_ORDER.indexOf('LV.X');
  const idx = RARITY_ORDER.indexOf(r);
  return idx === -1 ? 99 : idx;
}

function rarityColor(r, name, num) {
  const isFull = isBeyondSetTotal(num);
  // Tag Team synthetic rarity
  if (r === 'Tag Team') return isFull ? '#ff4d00' : '#f97d16';
  if (r === 'Rare Ultra' && isFull) return '#60a5fa';
  const map = {
    'MEGA_ATTACK_RARE':          '#ff6a00',
    'Mega Attack Rare':          '#ff6a00',
    'Hyper Rare':                '#ff4d6d',
    'Special Illustration Rare': '#ff6fb8',
    'Shiny Ultra Rare':          '#e879f9',
    'Rainbow Rare':              '#a78bfa',
    'Tag Team':                  '#f97d16',
    'Rare Rainbow':              '#a78bfa',
    'Galarian Gallery':          '#38bdf8',
    'Trainer Gallery Rare Holo': '#FFCB05',
    'ACE SPEC Rare':             '#f472b6',
    'Classic Collection':        '#f59e0b',
    'Rare Shiny GX':             '#ff7fc2',
    'Rare Shiny':                '#fda4af',
    'Shiny Rare':                '#c084fc',
    'Amazing Rare':              '#34d399',
    'Radiant Rare':              '#fb923c',
    'Rare Secret':               '#9d7cff',
    'Rare Ultra':                '#94a3b8',
    'Illustration Rare':         '#FFE066',
    'Double Rare':               '#94a3b8',
    'Gold Star':                 '#5ce1e6',
    'LEGEND':                    '#ffd700',
    'LV.X':                      '#ffb3e0',
    'Rare Prime':                '#e0779c',
    'Rare Holo Star':            '#5ce1e6',
    'Rare Shining':              '#b98aff',
    'Rare Holo':                 '#E8B914',
    'Rare':                      '#c0c5d1',
    'Uncommon':                  '#9aa5b8',
    'Common':                    '#77808f',
  };
  return map[r] || '#8b8fa3';
}
