// ─── DATA ────────────────────────────────────────────────────────────────────
let ALL_CARDS = [];
let PRICE_HISTORY = {};  // card_id -> [{d: 'YYYY-MM-DD', p: 1.23}, ...]
let currentView = 'list';  // default to list view
let showOwnedOnly = false;
const STORAGE_KEY = 'pokemon-rarity-binder-owned';
let _priceChart = null;  // Chart.js instance

// FEATURE (2026-07-30): sorts that represent one global ordering across
// every set (most recently purchased, or highest/lowest price) rather than
// a within-set ordering. Both list view (renderFlatList) and grid view
// (renderGridFlat) skip the normal era/set grouping for these — grouping
// would chop the single global order back into per-set chunks, which is
// exactly what these sorts are meant to avoid. Shared here so list and grid
// can't drift out of sync on which sorts get flat treatment.
const FLAT_SORTS = new Set(['recent-purchase', 'price-desc', 'price-asc']);
const FLAT_SORT_TITLES = {
  'recent-purchase': '🕐 Recent Purchases',
  'price-desc': '💰 Price: High to Low',
  'price-asc': '💰 Price: Low to High',
};

// ─── SHARED (READ-ONLY) VIEW ──────────────────────────────────────────────────
// If the page was opened via a share link (?share=<id>), we're viewing someone
// else's collection: card data still loads normally from the CSV (public,
// same for everyone), but the *owned* set comes from their public Firestore
// share doc instead of our own localStorage, and nothing is editable.
const SHARE_ID = new URLSearchParams(window.location.search).get('share');
const READ_ONLY_SHARE = !!SHARE_ID;
let _sharedOwned = new Set(); // populated by firebase.js once the share doc loads

// ─── OWNED COLLECTION (persisted to localStorage, unless viewing a share) ────
// FEATURE (2026-07-29): owned cards now carry metadata (currently just
// addedAt, a ms timestamp — foundation for the planned "recent purchases"
// sort/filter, and for a future optional purchase-price field) instead of
// just being a plain Set of key strings. Storage format is now an object
// map { [cardKey]: { addedAt } } rather than an array of keys.
// getOwned() returns a Map (key -> metadata) so existing `.has(key)` call
// sites elsewhere in the file keep working unchanged.
//
// BACKWARD COMPAT: any pre-existing localStorage/Firestore data is still a
// plain array of key strings (the old format). normalizeOwnedData() upgrades
// that transparently on read — migrated cards get addedAt set to "now"
// since their real add time was never recorded, which is the best available
// answer (they'll just sort to the bottom of "recent purchases" over time
// as newly-added cards push past them).
function cardKey(c) {
  return `${c.set}||${c.num}||${c.name}`;
}
function normalizeOwnedData(raw) {
  // raw is whatever came out of JSON.parse — either the old array-of-keys
  // format, or the { [key]: {addedAt, purchasePrice?} } object format.
  // purchasePrice is optional (2026-07-29 feature) — undefined/missing means
  // the user hit Skip or hasn't been prompted (older data), never defaulted
  // to a fabricated number.
  const map = new Map();
  if (Array.isArray(raw)) {
    const now = Date.now();
    for (const key of raw) map.set(key, { addedAt: now });
  } else if (raw && typeof raw === 'object') {
    for (const [key, meta] of Object.entries(raw)) {
      const entry = { addedAt: (meta && meta.addedAt) || Date.now() };
      if (meta && typeof meta.purchasePrice === 'number') entry.purchasePrice = meta.purchasePrice;
      map.set(key, entry);
    }
  }
  return map;
}
function getOwned() {
  if (READ_ONLY_SHARE) return _sharedOwned;
  try { return normalizeOwnedData(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
  catch(e) { return new Map(); }
}
function setOwned(owned) {
  // Serialize the Map back to the { [key]: {addedAt} } object format.
  const obj = {};
  for (const [key, meta] of owned) obj[key] = meta;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}
// Returns true if the toggle just ADDED the card to owned (newly owned this
// call) — false if it removed it. Used to decide whether to show the
// purchase-price prompt (only on the owned-ADD transition, never on removal).
function toggleOwned(c) {
  if (READ_ONLY_SHARE) return false; // visitors can't edit someone else's collection
  const owned = getOwned();
  const key = cardKey(c);
  let justAdded = false;
  let meta = null;
  if (owned.has(key)) {
    owned.delete(key);
  } else {
    meta = { addedAt: Date.now() };
    owned.set(key, meta);
    justAdded = true;
  }
  setOwned(owned);
  // BUG FIX (2026-07-30): Sync to Firestore as a single-key DELTA, not the
  // whole map. The old code sent the entire `owned` object on every toggle;
  // if a stale client (a backgrounded tab/phone that hadn't picked up a
  // recent removal yet) fired its own write afterward, it would silently
  // resurrect every card it still thought was owned, because it always
  // overwrote the whole field. Sending just {key, action} lets each write
  // touch only the one field that actually changed, so no client can ever
  // stomp another client's unrelated changes — see firebase.js's
  // pushOwnedDelta, which uses dot-notation updates / deleteField().
  window.dispatchEvent(new CustomEvent('owned-changed', {
    detail: { owned, key, action: justAdded ? 'add' : 'remove', meta }
  }));
  updateCollectionValue();
  return justAdded;
}
function isOwned(c) {
  return getOwned().has(cardKey(c));
}
// Returns the addedAt timestamp (ms) for an owned card, or 0 if not owned /
// unknown — used by the "Recent Purchases" sort.
function ownedAddedAt(c) {
  const meta = getOwned().get(cardKey(c));
  return (meta && meta.addedAt) || 0;
}
// FEATURE (2026-07-29): records what was actually paid for an already-owned
// card (set via the modal's purchase-price prompt). No-op if the card isn't
// owned (shouldn't happen from the UI flow, but guards against stale calls).
function setPurchasePrice(c, price) {
  if (READ_ONLY_SHARE) return;
  const owned = getOwned();
  const key = cardKey(c);
  const meta = owned.get(key);
  if (!meta) return;
  meta.purchasePrice = price;
  owned.set(key, meta);
  setOwned(owned);
  window.dispatchEvent(new CustomEvent('owned-changed', {
    detail: { owned, key, action: 'add', meta }
  }));
}
// Returns the recorded purchase price (number) for an owned card, or null if
// not recorded (skipped, or an older card added before this feature).
function ownedPurchasePrice(c) {
  const meta = getOwned().get(cardKey(c));
  return (meta && typeof meta.purchasePrice === 'number') ? meta.purchasePrice : null;
}

// Called by firebase.js once the shares/{shareId} doc loads (and again on
// every live update from its onSnapshot listener).
function setSharedOwned(raw) {
  _sharedOwned = normalizeOwnedData(raw || []);
  updateCollectionValue();
  // Force a full rebuild rather than the cheap same-set hide/show fast path
  // in _doRender (see _lastRenderedSet) — that path only toggles row
  // visibility for search/filter changes and never touches owned checkmarks,
  // so a live ownership update while viewing a set's detail page would
  // otherwise update the header stats but leave stale checkmarks on screen.
  _lastRenderedSet = null;
  if (typeof render === 'function') render();
}
function updateCollectionValue() {
  const owned = getOwned();
  let total = 0;
  let count = 0;
  for (const c of ALL_CARDS) {
    if (owned.has(cardKey(c))) {
      const v = priceVal(c.price);
      if (v > 0) total += v;
      count++;
    }
  }
  document.getElementById('statOwned').textContent = count.toLocaleString();
  document.getElementById('statValue').textContent = total > 0 ? '$' + total.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '$0.00';
}

function toggleOwnedFilter() {
  showOwnedOnly = !showOwnedOnly;
  document.getElementById('statOwnedBox').classList.toggle('active', showOwnedOnly);
  // BUG FIX (2026-07-30): if the Owned filter is toggled ON while on the main
  // page and you THEN enter a set, renderSetDetail only builds DOM rows for
  // the (already owned-only-filtered) subset of cards. Toggling the filter
  // back OFF while still in that same set previously hit the "same set
  // already rendered" fast path (filterSetDetailInPlace), which only
  // hides/shows EXISTING rows — it can't reveal cards that were never built
  // into the DOM in the first place, so non-owned cards stayed missing.
  // Forcing _lastRenderedSet = null here means the next render() always does
  // a full rebuild instead of the in-place fast path, so every row for the
  // set actually exists before hide/show logic runs.
  _lastRenderedSet = null;
  render();
}

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

// ─── CSV PARSER ──────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const cards = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    if (vals.length < 2) continue;
    const obj = {};
    header.forEach((h, idx) => obj[h] = (vals[idx] || '').trim());
    cards.push(obj);
  }
  return cards;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuote && line[i+1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      result.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

// Map CSV columns — handle both old and new format
function normalizeCard(raw) {
  const name = raw.card_name || raw.name || '';
  const series = raw.series || raw.series_name || '';
  // Strip "HS-" prefix from HG&SS set names (e.g. "HS-Unleashed" → "Unleashed")
  let set = (raw.set_name || raw['set_name'] || '').replace(/^HS-/, '');
  const setCode = raw.set_code || raw['set_code'] || '';
  const num = raw.card_number || raw['card_number'] || raw.number || '';
  const setTotal = raw['Set Total'] || raw.set_total || raw.setTotal || '';
  let rarity = raw.rarity || '';
  let price = raw.price || 'N/A';
  const prevPrice = raw.previous_price || raw['previous_price'] || 'N/A';
  // BUG FIX (2026-07-31): when the collector's price source fails for a card
  // on a given run (most commonly the TCG API's daily quota running out
  // mid-fetch for Mega Evolution cards), the CSV can have "Price" = N/A even
  // though "Previous Price" has a real, recent value. Fixing this in the
  // collector script requires a fresh run + push before it's visible; fixing
  // it here instead means it self-heals the moment the page loads, with no
  // dependency on when the next collector run happens. Same principle used
  // everywhere else in this app: show the last known-good number rather than
  // blanking it out.
  if (price === 'N/A' && prevPrice !== 'N/A') {
    price = prevPrice;
  }
  const cardId = raw.card_id || raw['card_id'] || '';
  const pic = raw.picture_url || raw['picture_url'] || raw.image || '';
  const setLogo = raw.set_logo || raw['set_logo'] || '';
  const setSymbol = raw.set_symbol || raw['set_symbol'] || '';
  const date = raw.release_date || raw['release_date'] || '';
  const lastChecked = raw.last_checked || raw['last_checked'] || '';
  const lastPriced = raw.last_priced || raw['last_priced'] || '';
  const supertype = raw.supertype || raw['supertype'] || '';
  // Subtypes is stored pipe-joined in the CSV (e.g. "Basic|EX" or "Basic|TAG TEAM|GX").
  // Split into an array so callers can check e.g. subtypes.includes('EX').
  const subtypesRaw = raw.subtypes || raw['subtypes'] || '';
  const subtypes = subtypesRaw ? subtypesRaw.split('|') : [];
  // Synthetic "Tag Team" rarity — Tag Team GX/EX cards always have & in the name.
  // This check takes priority over GX/EX classification — a card with & is always Tag Team.
  // BUG FIX (2026-07-31): only checked rarity === 'Rare Ultra' or 'Rare
  // Rainbow', so Sun & Moon era Tag Team GX cards (Celebi & Venusaur-GX,
  // Gengar & Mimikyu-GX, etc.) — which carry raw rarity "Rare Holo GX", NOT
  // "Rare Ultra" — never got normalized, and kept showing "Rare Holo GX" as
  // their pill/filter bucket instead of being grouped with the rest of the
  // TAG TEAM cards. The Subtypes field (ground truth from the API, already
  // parsed above) is a more reliable signal than scanning the name for "&",
  // so check subtypes.includes('TAG TEAM') directly rather than adding more
  // rarity strings to the OR chain one at a time as new eras turn up.
  if (subtypes.includes('TAG TEAM')) {
    rarity = 'Tag Team';
  } else if (name.includes('&') && (rarity === 'Rare Ultra' || rarity === 'Rare Rainbow')) {
    rarity = 'Tag Team';
  }
  // Synthetic "Galarian Gallery" rarity — Crown Zenith Galarian Gallery subset
  // The GG set uses several rarity strings; normalize them all to "Galarian Gallery"
  if (set === 'Crown Zenith Galarian Gallery') {
    rarity = 'Galarian Gallery';
  }
  // BUG FIX (2026-07-27): removed a rule that blindly converted every raw
  // "Hyper Rare" rarity to "Rainbow Rare", on the premise that pokemontcg.io
  // used "Hyper Rare" to mean SWSH's Rainbow Rare treatment. Checked the
  // actual CSV data: EVERY card with raw rarity "Hyper Rare" is Series =
  // "Scarlet & Violet" (74 cards, including Prismatic Evolutions' 5 gold-
  // star ex cards) — genuine SV Hyper Rares, not SWSH Rainbow Rares. SWSH
  // (and SM) Rainbow Rares are actually tagged "Rare Rainbow" in the data
  // and are already correctly normalized to "Rainbow Rare" a few lines up
  // (see the 'Rare Rainbow' branch). No real SWSH card was found using raw
  // "Hyper Rare" in the current dataset, so this rule had no correct case
  // left to handle and was only mislabeling real Hyper Rares as Rainbow
  // Rares (reported: Prismatic Evolutions cards showing as Rainbow Rare
  // despite being genuine 3-star gold Hyper Rares).
  // SV "Mega Hyper Rare" (our old internal name) → "Hyper Rare" (community name for SV gold cards)
  if (rarity === 'Mega Hyper Rare') {
    rarity = 'Hyper Rare';
  }
  // API stores LV.X as "Rare Holo LV.X" — normalize to "LV.X" for display/sorting
  if (rarity === 'Rare Holo LV.X') {
    rarity = 'LV.X';
  }
  return { name, series, set, setCode, num, setTotal, rarity, price, prevPrice, cardId, pic, setLogo, setSymbol, date, lastChecked, lastPriced, supertype, subtypes };
}

// Formats a release/history date for display as MM/DD/YYYY. Accepts either
// "YYYY/MM/DD" (CSV release dates, needed as-is for chronological string-sort
// in getFiltered()) or "YYYY-MM-DD" (price-history entries) — both are
// display-only conversions; the underlying stored value is left untouched.
function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  const m = dateStr.match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/);
  if (!m) return dateStr;
  const [, yyyy, mm, dd] = m;
  return `${mm}/${dd}/${yyyy}`;
}

// Shortens "Trainer Gallery" -> "TG" and "Galarian Gallery" -> "GG" in a set
// name for display on the main-page set overview cards. Display-only — the
// underlying c.set string is left untouched since it's used for matching/
// routing (openSetDetail, era/set grouping, etc.).
function shortSetName(setName) {
  if (!setName) return setName;
  return setName.replace('Trainer Gallery', 'TG').replace('Galarian Gallery', 'GG');
}

// Japanese set symbol equivalents, keyed by exact CSV/rarity-binder Set Name.
// Each value is a list of {name, symbol} for the JP set(s) that correspond to
// this English set (some English sets map to 2-3 JP sets).
// Sourced from pokesymbols.com's own English<->Japanese set equivalence data,
// with every image URL individually confirmed against the live page (the site
// uses two different image path prefixes depending on set era, and a handful of
// filenames don't match their slug -- e.g. SoulSilver Collection's file is
// "soulsilver-collection.png" not "soul-silver-collection.png").
// Trainer Gallery / Shiny Vault / Galarian Gallery subsets inherit their parent
// set's JP symbol since they're the same physical Japanese product.
// Sets absent from this object have no confirmed Japanese equivalent (Emerald,
// Chaos Rising) or were intentionally left unchanged (Wizards/SWSH Black Star
// Promos -- promos aren't tied to a single Japanese product).
const JP_SET_SYMBOLS = {
  "151": [{ name: "Pokémon Card 151", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/pokemon-card-151.png" }],
  "Ancient Origins": [{ name: "Bandit Ring", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/bandit-ring.png" }],
  "Aquapolis": [{ name: "The Town on No Map", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/the-town-on-no-map.png" }, { name: "Wind from the Sea", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/wind-from-the-sea.png" }],
  "Ascended Heroes": [{ name: "MEGA Dream ex", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/mega-dream-ex.png" }],
  "Astral Radiance": [{ name: "Time Gazer", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/time-gazer.png" }, { name: "Space Juggler", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/space-juggler.png" }],
  "Astral Radiance Trainer Gallery": [{ name: "Time Gazer", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/time-gazer.png" }, { name: "Space Juggler", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/space-juggler.png" }],
  "BREAKpoint": [{ name: "Rage of the Broken Heavens", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rage-of-the-broken-heavens.png" }],
  "Chaos Rising": [{ name: "Ninja Spinner", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/ninja-spinner.png" }],
  "BREAKthrough": [{ name: "Blue Shock", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/blue-shock.png" }, { name: "Red Flash", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/red-flash.png" }],
  "Base": [{ name: "Expansion Pack", symbol: "https://pokesymbols.com/images/tcg/sets/logos/base.png" }],
  "Battle Styles": [{ name: "Single Strike Master", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/single-strike-master.png" }, { name: "Rapid Strike Master", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rapid-strike-master.png" }],
  "Black & White": [{ name: "Black Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/black-collection.png" }, { name: "White Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/white-collection.png" }],
  "Black Bolt": [{ name: "Black Bolt", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/black-bolt.png" }, { name: "White Flare", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/white-flare.png" }],
  "Boundaries Crossed": [{ name: "Freeze Bolt", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/freeze-bolt.png" }, { name: "Cold Flare", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/cold-flare.png" }],
  "Brilliant Stars": [{ name: "Star Birth", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/star-birth.png" }],
  "Brilliant Stars Trainer Gallery": [{ name: "Star Birth", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/star-birth.png" }],
  "Burning Shadows": [{ name: "To Have Seen the Battle Rainbow", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/to-have-seen-the-battle-rainbow.png" }, { name: "Darkness that Consumes Light", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/darkness-that-consumes-light.png" }],
  "Celestial Storm": [{ name: "Sky-Splitting Charisma", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/sky-splitting-charisma.png" }],
  "Chilling Reign": [{ name: "Silver Lance", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/silver-lance.png" }, { name: "Jet-Black Spirit", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/jet-black-spirit.png" }],
  "Cosmic Eclipse": [{ name: "Alter Genesis", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/alter-genesis.png" }],
  "Crimson Invasion": [{ name: "Awakened Heroes", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/awakened-heroes.png" }, { name: "Ultradimensional Beasts", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/ultradimensional-beasts.png" }],
  "Crown Zenith": [{ name: "VSTAR Universe", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/vstar-universe.png" }],
  "Crown Zenith Galarian Gallery": [{ name: "VSTAR Universe", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/vstar-universe.png" }],
  "Crystal Guardians": [{ name: "Miracle Crystal", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/miracle-crystal.png" }],
  "Dark Explorers": [{ name: "Dark Rush", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dark-rush.png" }],
  "Darkness Ablaze": [{ name: "Infinity Zone", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/infinity-zone.png" }],
  "Delta Species": [{ name: "Holon Research Tower", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/holon-research-tower.png" }],
  "Deoxys": [{ name: "Clash of the Blue Sky", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/clash-of-the-blue-sky.png" }],
  "Destined Rivals": [{ name: "Glory of the Rocket Gang", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/glory-of-the-rocket-gang.png" }, { name: "Hot Wind Arena", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/hot-wind-arena.png" }],
  "Double Crisis": [{ name: "Magma Gang VS Aqua Gang: Double Crisis", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/magma-gang-vs-aqua-gang-double-crisis.png" }],
  "Dragon": [{ name: "Rulers of the Heavens", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rulers-of-the-heavens.png" }],
  "Dragon Frontiers": [{ name: "Offense and Defense of the Furthest Ends", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/offense-and-defense-of-the-furthest-ends.png" }],
  "Dragon Majesty": [{ name: "Dragon Storm", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dragon-storm.png" }],
  "Dragons Exalted": [{ name: "Dragon Blast", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dragon-blast.png" }, { name: "Dragon Blade", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dragon-blade.png" }],
  "Emerging Powers": [{ name: "Black Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/black-collection.png" }, { name: "White Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/white-collection.png" }],
  "Evolutions": [{ name: "Expansion Pack 20th Anniversary", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/expansion-pack-20th-anniversary.png" }],
  "Evolving Skies": [{ name: "Blue Sky Stream", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/blue-sky-stream.png" }, { name: "Skyscraping Perfection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/skyscraping-perfection.png" }],
  "Expedition Base Set": [{ name: "Base Expansion Pack", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/base-expansion-pack.png" }],
  "Fates Collide": [{ name: "Awakening Psychic King", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/awakening-psychic-king.png" }],
  "FireRed & LeafGreen": [{ name: "Flight of Legends", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/flight-of-legends.png" }],
  "Flashfire": [{ name: "Wild Blaze", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/wild-blaze.png" }],
  "Forbidden Light": [{ name: "Forbidden Light", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/forbidden-light.png" }],
  "Fossil": [{ name: "Mystery of the Fossils", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/mystery-of-the-fossils.png" }],
  "Furious Fists": [{ name: "Rising Fist", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rising-fist.png" }],
  "Fusion Strike": [{ name: "Fusion Arts", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/fusion-arts.png" }],
  "Generations": [{ name: "PokéKyun Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/pokekyun-collection.png" }],
  "Guardians Rising": [{ name: "Islands Await You", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/islands-await-you.png" }, { name: "Alolan Moonlight", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/alolan-moonlight.png" }],
  "Gym Challenge": [{ name: "Challenge from the Darkness", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/challenge-from-the-darkness.png" }],
  "Gym Heroes": [{ name: "Leaders' Stadium", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/leaders-stadium.png" }],
  "HS—Triumphant": [{ name: "Clash at the Summit", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/clash-at-the-summit.png" }],
  "HS—Undaunted": [{ name: "Reviving Legends", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/reviving-legends.png" }],
  "HS—Unleashed": [{ name: "HeartGold Collection", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/heartgold-collection.png" }, { name: "SoulSilver Collection", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/soulsilver-collection.png" }],
  "HeartGold & SoulSilver": [{ name: "HeartGold Collection", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/heartgold-collection.png" }, { name: "SoulSilver Collection", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/soulsilver-collection.png" }],
  "Hidden Fates": [{ name: "Sky Legend", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/sky-legend.png" }],
  "Hidden Fates Shiny Vault": [{ name: "GX Ultra Shiny", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/gx-ultra-shiny.png" }],
  "Hidden Legends": [{ name: "Undone Seal", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/undone-seal.png" }],
  "Holon Phantoms": [{ name: "Holon Phantom", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/holon-phantom.png" }],
  "Journey Together": [{ name: "Battle Partners", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/battle-partners.png" }],
  "Jungle": [{ name: "Pokémon Jungle", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/pokemon-jungle.png" }],
  "Legend Maker": [{ name: "Mirage Forest", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/mirage-forest.png" }],
  "Legendary Treasures": [{ name: "EX Battle Boost", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/ex-battle-boost.png" }, { name: "Shiny Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/shiny-collection.png" }],
  "Lost Origin": [{ name: "Paradigm Trigger", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/paradigm-trigger.png" }],
  "Lost Origin Trainer Gallery": [{ name: "Paradigm Trigger", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/paradigm-trigger.png" }],
  "Lost Thunder": [{ name: "Super-Burst Impact", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/super-burst-impact.png" }],
  "Mega Evolution": [{ name: "Mega Symphonia", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/mega-symphonia.png" }, { name: "Mega Brave", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/mega-brave.png" }],
  "Mysterious Treasures": [{ name: "Secret of the Lakes", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/secret-of-the-lakes.png" }],
  "Neo Destiny": [{ name: "Darkness, and to Light...", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/darkness-and-to-light.png" }],
  "Neo Discovery": [{ name: "Crossing the Ruins...", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/crossing-the-ruins.png" }],
  "Neo Genesis": [{ name: "Gold, Silver, to a New World...", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/gold-silver-to-a-new-world.png" }],
  "Neo Revelation": [{ name: "Awakening Legends", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/awakening-legends.png" }],
  "Next Destinies": [{ name: "Hail Blizzard", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/hail-blizzard.png" }, { name: "Psycho Drive", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/psycho-drive.png" }],
  "Noble Victories": [{ name: "Red Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/red-collection.png" }],
  "Obsidian Flames": [{ name: "Ruler of the Black Flame", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/ruler-of-the-black-flame.png" }],
  "Paldea Evolved": [{ name: "Snow Hazard", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/snow-hazard.png" }, { name: "Clay Burst", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/clay-burst.png" }],
  "Paldean Fates": [{ name: "Shiny Treasure ex", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/shiny-treasure-ex.png" }],
  "Paradox Rift": [{ name: "Ancient Roar", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/ancient-roar.png" }, { name: "Future Flash", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/future-flash.png" }],
  "Perfect Order": [{ name: "Nihil Zero", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/nihil-zero.png" }],
  "Phantasmal Flames": [{ name: "Inferno X", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/inferno-x.png" }],
  "Phantom Forces": [{ name: "Phantom Gate", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/phantom-gate.png" }],
  "Pitch Black": [{ name: "Abyss Eye", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/abyss-eye.png" }],
  "Plasma Blast": [{ name: "Megalo Cannon", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/megalo-cannon.png" }],
  "Plasma Freeze": [{ name: "Spiral Force", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/spiral-force.png" }, { name: "Thunder Knuckle", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/thunder-knuckle.png" }],
  "Plasma Storm": [{ name: "Plasma Gale", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/plasma-gale.png" }],
  "Platinum": [{ name: "Galactic's Conquest", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/galactics-conquest.png" }],
  "Pokémon GO": [{ name: "Pokémon GO", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/pokemon-go.png" }],
  "Power Keepers": [{ name: "World Champions Pack", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/world-champions-pack.png" }],
  "Primal Clash": [{ name: "Gaia Volcano", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/gaia-volcano.png" }, { name: "Tidal Storm", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/tidal-storm.png" }],
  "Prismatic Evolutions": [{ name: "Terastal Fest ex", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/terastal-fest-ex.png" }],
  "Rebel Clash": [{ name: "Rebellion Crash", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rebellion-crash.png" }],
  "Rising Rivals": [{ name: "Bonds to the End of Time", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/bonds-to-the-end-of-time.png" }],
  "Roaring Skies": [{ name: "Emerald Break", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/emerald-break.png" }],
  "Ruby & Sapphire": [{ name: "ADV Expansion Pack", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/adv-expansion-pack.png" }],
  "Sandstorm": [{ name: "Miracle of the Desert", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/miracle-of-the-desert.png" }],
  "Scarlet & Violet": [{ name: "Scarlet ex", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/scarlet-ex.png" }, { name: "Violet ex", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/violet-ex.png" }],
  "Shining Fates": [{ name: "Shiny Star V", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/shiny-star-v.png" }],
  "Shining Fates Shiny Vault": [{ name: "Shiny Star V", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/shiny-star-v.png" }],
  "Shining Legends": [{ name: "Shining Legends", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/shining-legends.png" }],
  "Shrouded Fable": [{ name: "Night Wanderer", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/night-wanderer.png" }],
  "Silver Tempest": [{ name: "Lost Abyss", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/lost-abyss.png" }],
  "Silver Tempest Trainer Gallery": [{ name: "Lost Abyss", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/lost-abyss.png" }],
  "Skyridge": [{ name: "Mysterious Mountains", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/mysterious-mountains.png" }, { name: "Split Earth", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/split-earth.png" }],
  "Steam Siege": [{ name: "Cruel Traitor", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/cruel-traitor.png" }, { name: "Fever-Burst Fighter", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/fever-burst-fighter.png" }],
  "Stellar Crown": [{ name: "Stellar Miracle", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/stellar-miracle.png" }],
  "Stormfront": [{ name: "Intense Fight in the Destroyed Sky", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/intense-fight-in-the-destroyed-sky.png" }],
  "Sun & Moon": [{ name: "Collection Sun", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/collection-sun.png" }, { name: "Collection Moon", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/collection-moon.png" }],
  "Supreme Victors": [{ name: "Beat of the Frontier", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/beat-of-the-frontier.png" }],
  "Surging Sparks": [{ name: "Super Electric Breaker", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/super-electric-breaker.png" }],
  "Sword & Shield": [{ name: "Sword", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/sword.png" }, { name: "Shield", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/shield.png" }],
  "Team Magma vs Team Aqua": [{ name: "Magma VS Aqua: Two Ambitions", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/magma-vs-aqua-two-ambitions.png" }],
  "Team Rocket": [{ name: "Rocket Gang", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/rocket-gang.png" }],
  "Team Rocket Returns": [{ name: "Rocket Gang Strikes Back", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rocket-gang-strikes-back.png" }],
  "Team Up": [{ name: "Tag Bolt", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/tag-bolt.png" }],
  "Temporal Forces": [{ name: "Wild Force", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/wild-force.png" }, { name: "Cyber Judge", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/cyber-judge.png" }],
  "Twilight Masquerade": [{ name: "Transformation Mask", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/transformation-mask.png" }],
  "Ultra Prism": [{ name: "Ultra Sun", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/ultra-sun.png" }, { name: "Ultra Moon", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/ultra-moon.png" }],
  "Unbroken Bonds": [{ name: "Double Blaze", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/double-blaze.png" }],
  "Unified Minds": [{ name: "Miracle Twin", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/miracle-twin.png" }],
  "Unseen Forces": [{ name: "Golden Sky, Silvery Ocean", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/golden-sky-silvery-ocean.png" }],
  "Vivid Voltage": [{ name: "Amazing Volt Tackle", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/amazing-volt-tackle.png" }],
  "White Flare": [{ name: "Black Bolt", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/black-bolt.png" }, { name: "White Flare", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/white-flare.png" }],
  "XY": [{ name: "Collection X", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/collection-x.png" }, { name: "Collection Y", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/collection-y.png" }],
};

// Sets where the JP symbol icon is visually indistinguishable from the
// English icon (WOTC/EX-era Nintendo used near-identical pictogram symbols
// across languages) — showing both side by side is just a duplicate, so
// jpSymbolsFor() suppresses the JP badge for these even though a real JP
// equivalent set exists and is documented above.
const JP_SYMBOL_VISUALLY_DUPLICATE = new Set([
  'Team Rocket', 'Fossil', 'Wizards Black Star Promos', 'Jungle', 'Base',
  'Neo Destiny', 'Neo Revelation', 'Neo Discovery', 'Neo Genesis',
  'Power Keepers', 'Dragon Frontiers', 'Crystal Guardians', 'Holon Phantoms',
  'Legend Maker', 'Delta Species', 'Unseen Forces', 'Emerald', 'Deoxys',
  'Team Rocket Returns', 'FireRed & LeafGreen', 'Hidden Legends',
  'Team Magma vs Team Aqua', 'Dragon', 'Sandstorm', 'Ruby & Sapphire',
]);

// Returns the JP symbol image URL(s) for a given English set name, or null if
// no confirmed Japanese equivalent exists. Trainer Gallery / Shiny Vault /
// Galarian Gallery subsets fall back to their parent set name.
function jpSymbolsFor(setName) {
  if (!setName) return null;
  if (JP_SYMBOL_VISUALLY_DUPLICATE.has(setName)) return null;
  if (JP_SET_SYMBOLS[setName]) return JP_SET_SYMBOLS[setName];
  const parent = setName.replace(/ (Trainer Gallery|Galarian Gallery)$/, '');
  if (parent !== setName && JP_SYMBOL_VISUALLY_DUPLICATE.has(parent)) return null;
  if (parent !== setName && JP_SET_SYMBOLS[parent]) return JP_SET_SYMBOLS[parent];
  return null;
}

// Returns days between a YYYY-MM-DD date string and today, or null if invalid/missing.
function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const diffMs = Date.now() - d.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

// Returns HTML for a staleness note, or '' if not stale / not applicable.
// Only surfaces once a card's price has gone unresolved for a while, so a
// single bad-API-day doesn't trigger noise.
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
  if (days !== null && days >= 14) {
    return `<span class="price-stale" title="Price last confirmed ${days} days ago">Stale ${days}d</span>`;
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

// Returns HTML badge string for price change, or ''
function priceChangeBadge(current, prev) {
  // FEATURE (2026-08-02): price-change % hidden entirely in read-only share
  // view, same reasoning as the 70%-of-market badge — not useful/appropriate
  // to show a visitor browsing someone else's collection.
  if (READ_ONLY_SHARE) return '';
  const cv = priceVal(current);
  const pv = priceVal(prev);
  if (cv < 0 || pv < 0 || pv === 0) return '';
  const delta = cv - pv;
  const pct = (delta / pv) * 100;
  if (Math.abs(delta) < 0.01) return '<span class="price-change price-flat">—</span>';
  const arrow = delta > 0 ? '↑' : '↓';
  const cls = delta > 0 ? 'price-up' : 'price-down';
  const sign = delta > 0 ? '+' : '';
  return `<span class="price-change ${cls}">${arrow} ${sign}${pct.toFixed(1)}%</span>`;
}

// ─── LOAD DATA ───────────────────────────────────────────────────────────────
function loadCards(rawCards) {
  ALL_CARDS = rawCards.map(normalizeCard).filter(c => c.set || c.name);
  updateStats();
  populateFilters();
  document.getElementById('toolbar').style.display = '';
  document.getElementById('noDataState').style.display = 'none';
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('cardView').style.display = '';
  updateCollectionValue();
  showQuickRow();
  if (READ_ONLY_SHARE) {
    // FEATURE (2026-08-02): shared collections default to grid view, filtered
    // to owned cards only — that's the whole point of sharing a collection,
    // so skip straight to it instead of making a visitor click "Owned" + "Grid".
    if (!showOwnedOnly) toggleOwnedFilter();
    setView('grid');
  } else {
    setView('list'); // default to list view on load
  }
}

// ─── READ-ONLY SHARE UI (header button row + Now button hidden) ─────────────
// Called once from firebase.js's initReadOnlyShareView(). Hides the sign-in/
// share controls and the "Now" trend button (gainers/drops don't make sense
// browsing someone else's collection read-only). The numeric stats row
// (Total Cards / Owned / Value) and the read-only banner stay visible — see
// 2026-08-02 revert: the "{firstName}'s Collection" heading was tried and
// then explicitly reverted by request, keep the top bar as the original
// stats row instead.
function applyReadOnlyShareUI() {
  const headerBtnRow = document.getElementById('headerBtnRow');
  if (headerBtnRow) headerBtnRow.style.display = 'none';
  ['btnNow', 'btnNowDesktop'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  // FEATURE (2026-08-02): hides the owned checkbox + owned "grayed out /
  // struck-through" styling on cards in read-only share view (see CSS rules
  // scoped under body.read-only-share). Since the default view here is
  // grid+owned-only, every visible card would otherwise show as checked/
  // greyed, which reads as noise rather than useful signal to a visitor.
  document.body.classList.add('read-only-share');
}
window.applyReadOnlyShareUI = applyReadOnlyShareUI;

function updateStats() {
  document.getElementById('statCards').textContent = ALL_CARDS.length.toLocaleString();
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

function populateFilters() {
  const eras = [...new Set(ALL_CARDS.map(c => c.series).filter(Boolean))].sort();
  const eraEl = document.getElementById('eraFilter');
  const rarEl = document.getElementById('rarityFilter');
  eraEl.innerHTML = '<option value="">All Eras</option>' + eras.map(e => `<option value="${e}">${e}</option>`).join('');

  // Build filter options keyed by DISPLAY LABEL, not raw rarity string, so
  // raw values that mean the same thing (e.g. "Rare Rainbow" + "Rainbow Rare")
  // collapse into a single selectable option instead of showing twice.
  // value format: "label::raw1|raw2|..." — getFiltered() matches against the
  // pipe-separated raw value list.
  const seenLabels = new Map(); // label -> Set of raw rarity strings it covers
  const seenUltraBuckets = new Set(); // which __GX__/__EX__/__FA_TRAINER__ actually occur

  for (const c of ALL_CARDS) {
    const r = c.rarity;
    if (!r) continue;
    if (TG_RARITY_STRINGS.has(r)) {
      if (!seenLabels.has('Trainer Gallery')) seenLabels.set('Trainer Gallery', new Set());
      seenLabels.get('Trainer Gallery').add('__TG__');
      continue;
    }
    if (r === 'Rare Ultra') {
      seenUltraBuckets.add(rareUltraBucket(c));
      continue;
    }
    const label = RARITY_DISPLAY[r] || r;
    if (!seenLabels.has(label)) seenLabels.set(label, new Set());
    seenLabels.get(label).add(r);
  }

  // FEATURE (2026-07-31): "Full Art Trainer" removed as a selectable filter
  // option by request — cards in this bucket stay in the app (still
  // findable via search or other filters) and still classify correctly
  // everywhere else (pill labels, sort order), just no longer get their own
  // dropdown entry. Simplest fix: drop __FA_TRAINER__ from this loop only;
  // rareUltraBucket() itself is untouched, so nothing downstream breaks.
  const ULTRA_LABELS = {
    '__GX__':         'Full Art GX',
    '__EX__':         'Full Art EX',
    '__FA_POKEMON__': 'Full Art Pokémon',
  };
  for (const bucket of ['__GX__', '__EX__', '__FA_POKEMON__']) {
    if (seenUltraBuckets.has(bucket)) {
      seenLabels.set(ULTRA_LABELS[bucket], new Set([bucket]));
    }
  }

  const rarityOptions = [...seenLabels.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, rawSet]) => `<option value="${[...rawSet].join('|')}">${label}</option>`);

  rarEl.innerHTML = '<option value="">All Rarities</option>' + rarityOptions.join('');
  syncMobileFilters();
}

function isFiltersActive() {
  const search = document.getElementById('search').value;
  const era = document.getElementById('eraFilter').value;
  const rarity = document.getElementById('rarityFilter').value;
  const sort = document.getElementById('sortBy').value;
  return search || era || rarity || sort !== 'date-desc' || showOwnedOnly || !!_trendMode;
}

function updateResetBtn() {
  const show = isFiltersActive();
  ['resetBtn','resetBtnM'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.opacity = show ? '1' : '0.4';
    el.style.borderColor = show ? '#f87171' : '';
    el.style.color = show ? '#f87171' : '';
    el.style.background = show ? '#f8717112' : '';
  });
}

function showQuickRow() {
  const qr = document.getElementById('quickRow');
  if (qr) qr.classList.add('visible');
}

function resetFilters() {
  document.getElementById('search').value = '';
  document.getElementById('searchWrap').classList.remove('has-text');
  document.getElementById('eraFilter').value = '';
  document.getElementById('rarityFilter').value = '';
  document.getElementById('sortBy').value = 'date-desc';
  // Sync mobile
  ['eraFilterM','rarityFilterM','sortByM'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'sortByM' ? 'date-desc' : '';
  });
  if (showOwnedOnly) toggleOwnedFilter();
  // Clear gainers/losers mode
  if (_trendMode) {
    _trendMode = null;
    ['btnGainers','btnDrops','btnGainersM','btnDropsM'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active-gainers','active-drops');
    });
    updateNowBtn();
  }
  // Reset always drops back to list view — grid view requires a search/filter
  // to render anything, so staying in grid after a reset would just show
  // the empty "search to explore" placeholder.
  if (currentView === 'grid') applyViewState('list');
  updateResetBtn();

  // BUG FIX (2026-07-29): Reset previously left you inside a set's detail
  // page if one was open — it only cleared filters/sort/search, never
  // _activeSet, so you'd land back on the (now unfiltered) same set instead
  // of the main overview. Exit via history.back() rather than clearing
  // _activeSet directly: entering a set pushes a history entry (see
  // openSetDetail), and the popstate handler above already knows how to
  // unwind that state correctly (clears _activeSet, resets view, restores
  // overview scroll position) — going around it would leave a stale
  // history entry that the browser back button would then mishandle.
  // All filter state above is already cleared before this fires, so the
  // popstate handler's render() call lands on a clean main overview.
  if (_activeSet) {
    history.back();
  } else {
    render();
  }
}

// ─── FILTER + SORT ───────────────────────────────────────────────────────────
// BUG FIX (2026-07-27): older BW/XY-era EX cards are named with a literal
// hyphen (e.g. "Mew-EX", "Mewtwo-EX" — how they were actually printed and
// how the underlying data correctly stores them), but users naturally type
// a space when searching ("mew ex"). Plain substring search failed on this
// mismatch. Rather than alter the real card names (would break historical
// accuracy, image URLs, price-history keys, etc.), normalize hyphens to
// spaces on BOTH the query and the haystack before comparing — search-only,
// doesn't touch anything displayed or stored.
const normalizeSearchText = s => (s || '').toLowerCase().replace(/-/g, ' ');

function getFiltered() {
  const q = normalizeSearchText(document.getElementById('search').value);
  const era = document.getElementById('eraFilter').value;
  const rarity = document.getElementById('rarityFilter').value;
  const sort = document.getElementById('sortBy').value;

  // Rarity filter value is a pipe-separated set of raw-rarity/bucket tokens
  // (see populateFilters) — a card matches if any token applies to it.
  const rarityTokens = rarity ? rarity.split('|') : null;

  let cards = ALL_CARDS.filter(c => {
    if (showOwnedOnly && !isOwned(c)) return false;
    if (era && c.series !== era) return false;
    if (rarityTokens) {
      const matches = rarityTokens.some(tok => {
        // BUG FIX (2026-07-31): the __TG__ bucket only matched cards whose
        // raw rarity was one of the four strings in TG_RARITY_STRINGS — but
        // full-art Trainer-supertype cards inside these same Trainer Gallery
        // subsets (Allister, Bea, Boss's Orders, etc., numbered TG24-TG30)
        // carry raw rarity "Rare Ultra" instead, which isn't in that set (by
        // design — Rare Ultra is also used for ordinary non-TG Full Art
        // EX/GX cards elsewhere, which must NOT get bucketed as Trainer
        // Gallery). The TG\d+ card-number prefix is the structural signal
        // that actually identifies "this card lives in a Trainer Gallery
        // subset," independent of its raw rarity string — same fix applied
        // to shortRarity() above, mirrored here so the filter dropdown and
        // the pill label always agree on which cards count as TG.
        if (tok === '__TG__') return /^TG\d+$/i.test((c.num || '').trim());
        if (tok === '__GX__' || tok === '__EX__' || tok === '__FA_POKEMON__' || tok === '__FA_TRAINER__') {
          return c.rarity === 'Rare Ultra' && !/^TG\d+$/i.test((c.num || '').trim())
              && rareUltraBucket(c) === tok;
        }
        return c.rarity === tok;
      });
      if (!matches) return false;
    }
    if (q) {
      const haystack = normalizeSearchText(`${c.name} ${c.set} ${c.series} ${c.rarity}`);
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // Parses prefixed card numbers like TG01, GG30, SWSH123 numerically, so
  // ties (e.g. same release date) break in card-number order instead of
  // whatever order ALL_CARDS happened to have them in. Oldest First ties
  // ascend by number (lowest first); Newest First ties descend (highest first).
  const parseNum = n => { const m = (n || '').match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; };

  // BUG FIX (2026-07-27): when two DIFFERENT sets share an exact release
  // date (e.g. Black Bolt / White Flare, both 2025/07/18), the old tiebreak
  // sorted every card from both sets together by card number, interleaving
  // them instead of keeping each set as its own block. Now, on a same-date
  // tie, group by setCode first (falls back to set name if setCode is also
  // tied — true for "main set" + "Trainer Gallery"/"Shiny Vault" pairs that
  // share one set code, e.g. "Brilliant Stars" + "Brilliant Stars Trainer
  // Gallery" are both "BRS" — alphabetical naturally puts the main set
  // first since its name is always a prefix of the sub-collection's name),
  // THEN by card number within each set's block.
  const setGroupKey = c => (c.setCode || c.set || '');

  cards.sort((a, b) => {
    if (sort === 'date-asc') {
      return (a.date || '').localeCompare(b.date || '')
        || setGroupKey(a).localeCompare(setGroupKey(b))
        || (a.set || '').localeCompare(b.set || '')
        || parseNum(a.num) - parseNum(b.num);
    }
    if (sort === 'date-desc') {
      return (b.date || '').localeCompare(a.date || '')
        || setGroupKey(a).localeCompare(setGroupKey(b))
        || (a.set || '').localeCompare(b.set || '')
        || parseNum(b.num) - parseNum(a.num);
    }
    if (sort === 'price-desc') return priceVal(b.price) - priceVal(a.price);
    if (sort === 'price-asc') {
      const av = priceVal(a.price), bv = priceVal(b.price);
      if (av < 0 && bv < 0) return 0;
      if (av < 0) return 1;
      if (bv < 0) return -1;
      return av - bv;
    }
    if (sort === 'recent-purchase') {
      // Most-recently-marked-owned first. Unowned cards (addedAt 0) sort to
      // the very end — this view is only meaningful for owned cards, but we
      // don't hard-filter to owned-only here so it still composes normally
      // with the existing "Owned" stat-box filter and other filters/search.
      return ownedAddedAt(b) - ownedAddedAt(a);
    }
    return 0;
  });

  return cards;
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
  };
  return map[r] || '#8b8fa3';
}

// Track which set is currently open in detail view (null = overview)
let _activeSet = null; // { era, set } or null
let _trendMode = null; // 'gainers' | 'drops' | null

// "Now" button on mobile — toggles gainers panel (shows both gainers and drops as a combined view)
// On desktop the dedicated Gainers/Drops buttons are used instead
function toggleNow() {
  // On mobile "Now" cycles: off → gainers → drops → off
  if (!_trendMode) {
    setTrend('gainers');
  } else if (_trendMode === 'gainers') {
    setTrend('drops');
  } else {
    setTrend(null);
  }
}

function updateNowBtn() {
  ['btnNow','btnNowDesktop'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (_trendMode === 'gainers') {
      btn.textContent = '📈 Gainers';
      btn.classList.add('active-gainers');
      btn.classList.remove('active-drops');
    } else if (_trendMode === 'drops') {
      btn.textContent = '📉 Losers';
      btn.classList.add('active-drops');
      btn.classList.remove('active-gainers');
    } else {
      btn.textContent = '⚡ Now';
      btn.classList.remove('active-gainers','active-drops');
    }
  });
}

function setTrend(mode) {
  if (mode === null || _trendMode === mode) {
    _trendMode = null;
    ['btnGainers','btnDrops','btnGainersM','btnDropsM'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active-gainers','active-drops');
    });
  } else {
    _trendMode = mode;
    _activeSet = null;
    // Gainers/Losers is a list-style view — if the user triggers it while in
    // grid mode, drop back to list so it actually renders instead of showing
    // the grid's "search or filter to explore" placeholder.
    if (currentView === 'grid') applyViewState('list');
    ['btnGainers','btnGainersM'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('active-gainers', mode==='gainers');
      el.classList.remove('active-drops');
    });
    ['btnDrops','btnDropsM'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('active-drops', mode==='drops');
      el.classList.remove('active-gainers');
    });
  }
  updateNowBtn();
  render();
}

function renderTrend(el) {
  // Require both prices to be real values, and a minimum price to filter out bulk noise
  const MIN_PRICE = 2.00; // ignore cards under $2 — they create misleading % swings
  const withChange = ALL_CARDS
    .filter(c => {
      const cv = priceVal(c.price), pv = priceVal(c.prevPrice);
      return cv > 0 && pv > 0 && Math.max(cv, pv) >= MIN_PRICE;
    })
    .map(c => {
      const cv = priceVal(c.price), pv = priceVal(c.prevPrice);
      const delta = cv - pv;
      const pct = (delta / pv) * 100;
      return { ...c, _delta: delta, _pct: pct, _cv: cv, _pv: pv };
    });

  if (withChange.length === 0) {
    el.innerHTML = `<div class="empty"><div class="display">No price changes yet</div><p>Run the collector on two separate days to see price movement.</p></div>`;
    return;
  }

  const TOP_N = 25;
  let sorted, title, titleColor, subtitle;

  if (_trendMode === 'gainers') {
    // Sort by dollar gain first (meaningful moves), then break ties by %
    sorted = [...withChange]
      .filter(c => c._delta > 0)
      .sort((a,b) => b._delta - a._delta || b._pct - a._pct)
      .slice(0, TOP_N);
    title = '📈 Top Gainers';
    titleColor = '#4ade80';
    subtitle = `Top ${sorted.length} biggest price increases (min $${MIN_PRICE} card)`;
  } else {
    // Sort by dollar drop first, then break ties by %
    sorted = [...withChange]
      .filter(c => c._delta < 0)
      .sort((a,b) => a._delta - b._delta || a._pct - b._pct)
      .slice(0, TOP_N);
    title = '📉 Top Losers';
    titleColor = '#f87171';
    subtitle = `Top ${sorted.length} biggest price decreases (min $${MIN_PRICE} card)`;
  }

  if (sorted.length === 0) {
    el.innerHTML = `<div class="empty"><div class="display">${_trendMode === 'gainers' ? 'No gainers yet' : 'No losers yet'}</div><p>Run the collector on two separate days to see price movement.</p></div>`;
    return;
  }

  let html = `<div class="trend-section">
    <div class="trend-header">
      <div class="trend-title" style="color:${titleColor};">${title}</div>
      <div class="trend-sub">${subtitle}</div>
    </div>`;

  sorted.forEach((c, i) => {
    const owned = isOwned(c);
    const cdata = JSON.stringify(c).replace(/'/g,'&#39;');
    const key = cardKey(c).replace(/[^a-z0-9]/gi,'_');
    const sign = c._delta >= 0 ? '+' : '';
    const cls = c._delta >= 0 ? 'price-up' : 'price-down';
    const arrow = c._delta >= 0 ? '↑' : '↓';
    const badge = `<span class="price-change ${cls}">${arrow} ${sign}$${Math.abs(c._delta).toFixed(2)} (${sign}${c._pct.toFixed(1)}%)</span>`;
    const thumbHtml = c.pic && c.pic !== 'N/A'
      ? `<img class="crow-thumb" src="${c.pic}" alt="${c.name||''}" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="crow-thumb-empty">?</div>`;

    html += `<div class="card-row${owned?' owned':''}" id="row-${key}" onclick='openModal(${cdata})'>
      <span class="trend-rank">${i+1}</span>
      <div class="crow-check${owned?' owned':''}" onclick='event.stopPropagation();handleToggle(${cdata})'>${owned?'✓':''}</div>
      ${thumbHtml}
      <div style="flex:1;min-width:0;">
        <div class="crow-name">${c.name||'—'}</div>
        <div class="crow-set">${c.set}</div>
      </div>
      <div class="crow-price-wrap">
        <span class="crow-price">${c.price!=='N/A'?c.price:'—'}</span>
        <div style="font-size:10px;color:var(--dim);text-align:right;">was ${c.prevPrice}</div>
        ${badge}
        ${seventyPercentBadgeHtml(c)}
      </div>
    </div>`;
  });

  html += `</div>`;
  el.innerHTML = html;
}

// FEATURE (2026-07-30): flat, ungrouped list view — used for "Recent
// Purchases" and the price sorts. These sorts are inherently about a single
// global ordering (most recently bought, or highest/lowest price) that
// spans every set; grouping by era/set (like the default overview does)
// would chop that ordering back up into per-set blocks and defeat the
// purpose. Modeled directly on renderTrend()'s flat card-row list, just
// without the gainers/losers-specific delta badge.
function renderFlatList(cards, el, title) {
  let html = `<div class="trend-section">
    <div class="trend-header">
      <div class="trend-title">${title}</div>
      <div class="trend-sub">${cards.length} card${cards.length !== 1 ? 's' : ''}</div>
    </div>`;

  cards.forEach((c, i) => {
    const owned = isOwned(c);
    const cdata = JSON.stringify(c).replace(/'/g,'&#39;');
    const key = cardKey(c).replace(/[^a-z0-9]/gi,'_');
    const thumbHtml = c.pic && c.pic !== 'N/A'
      ? `<img class="crow-thumb" src="${c.pic}" alt="${c.name||''}" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="crow-thumb-empty">?</div>`;

    html += `<div class="card-row${owned?' owned':''}" id="row-${key}" onclick='openModal(${cdata})'>
      <span class="trend-rank">${i+1}</span>
      <div class="crow-check${owned?' owned':''}" onclick='event.stopPropagation();handleToggle(${cdata})'>${owned?'✓':''}</div>
      ${thumbHtml}
      <div style="flex:1;min-width:0;">
        <div class="crow-name">${c.name||'—'}</div>
        <div class="crow-set">${c.set}</div>
      </div>
      <div class="crow-price-wrap">
        <span class="crow-price">${c.price!=='N/A'?c.price:'—'}</span>
        ${seventyPercentBadgeHtml(c)}
      </div>
    </div>`;
  });

  html += `</div>`;
  el.innerHTML = html;
}

let _renderPending = false;
let _lastRenderedSet = null; // tracks which set is currently rendered in the DOM
function render() {
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(_doRender);
}
function _doRender() {
  _renderPending = false;
  updateResetBtn();
  const cards = getFiltered();
  const el = document.getElementById('cardView');
  if (cards.length === 0) {
    el.innerHTML = `<div class="empty"><div class="display">No cards found</div><p>Try adjusting your search or filters.</p></div>`;
    _activeSet = null;
    _lastRenderedSet = null;
    return;
  }
  if (currentView === 'grid') {
    // Leaving set-detail view — _setDetailOrder no longer reflects what's
    // on screen, so fall back to the global getFiltered() order for the modal.
    _setDetailOrder = null;
    if (_activeSet) {
      // Inside a set — always render (small card count, no perf issue)
      const gridCards = cards.filter(c => c.series === _activeSet.era && c.set === _activeSet.set);
      _lastRenderedSet = null;
      renderGrid(gridCards.length > 0 ? gridCards : cards, el);
    } else {
      // Main page grid — only render if user has typed a search query OR applied a filter
      const q = document.getElementById('search').value.trim();
      const eraSel = document.getElementById('eraFilter').value;
      const raritySel = document.getElementById('rarityFilter').value;
      const hasFilter = !!q || !!eraSel || !!raritySel || showOwnedOnly;
      if (!hasFilter) {
        el.innerHTML = `<div class="empty"><div class="display">Search to explore</div><p>Type a card name, Pokémon, or set — or apply a filter — to see results in grid view.</p></div>`;
      } else {
        _lastRenderedSet = null;
        const sortValueGrid = document.getElementById('sortBy').value;
        if (FLAT_SORTS.has(sortValueGrid)) {
          renderGridFlat(cards, el, FLAT_SORT_TITLES[sortValueGrid]);
        } else {
          renderGrid(cards, el);
        }
      }
    }
    return;
  }
  // Trend view takes priority over set detail / overview
  if (_trendMode) { _setDetailOrder = null; _lastRenderedSet = null; renderTrend(el); return; }
  // FEATURE (2026-07-30): "Recent Purchases" and the price sorts are a single
  // global ordering across every set — grouping them into the normal
  // era/set overview would immediately chop that ordering back into
  // per-set blocks, defeating the point of the sort. Skip the grouped
  // overview/set-detail entirely for these and render one flat list instead
  // (same treatment as the Gainers/Losers trend view), UNLESS the user has
  // actually drilled into a specific set — browsing one set's cards in
  // price/recent order still makes sense grouped by that set alone via the
  // normal set-detail view.
  const sortValue = document.getElementById('sortBy').value;
  if (FLAT_SORTS.has(sortValue) && !_activeSet) {
    _setDetailOrder = null;
    _lastRenderedSet = null;
    renderFlatList(cards, el, FLAT_SORT_TITLES[sortValue]);
    return;
  }
  // If a set is active and still has cards in filtered result, show detail
  if (_activeSet) {
    const setCards = cards.filter(c => c.series === _activeSet.era && c.set === _activeSet.set);
    if (setCards.length > 0) {
      // If the same set is already rendered, do a cheap hide/show pass instead of full rebuild
      const setKey = _activeSet.era + '|' + _activeSet.set;
      if (_lastRenderedSet === setKey) {
        filterSetDetailInPlace(setCards);
      } else {
        _lastRenderedSet = setKey;
        renderSetDetail(setCards, el);
      }
      return;
    } else {
      _activeSet = null;
      _lastRenderedSet = null;
      _setDetailOrder = null;
    }
  }
  _lastRenderedSet = null;
  _setDetailOrder = null;
  renderSetOverview(cards, el);
} // end _doRender

// Hide/show existing card-row elements in the set detail view without rebuilding the DOM.
// Much cheaper on mobile when the user is just typing a search within a set.
function filterSetDetailInPlace(visibleCards) {
  const visibleKeys = new Set(visibleCards.map(c => cardKey(c).replace(/[^a-z0-9]/gi,'_')));
  const el = document.getElementById('cardView');
  // Toggle visibility on each row
  el.querySelectorAll('.card-row[id^="row-"]').forEach(row => {
    const key = row.id.slice(4); // strip 'row-' prefix
    row.style.display = visibleKeys.has(key) ? '' : 'none';
  });
  // Hide rarity-group sections that have no visible rows
  el.querySelectorAll('.rarity-group').forEach(group => {
    const hasVisible = [...group.querySelectorAll('.card-row')].some(r => r.style.display !== 'none');
    group.style.display = hasVisible ? '' : 'none';
  });
}

function buildSetGroups(cards) {
  // Returns { eraOrder, setOrderByEra, byEra }
  // byEra[era][set][rarity] = cards[]
  const byEra = {}, eraOrder = [], setOrderByEra = {};
  for (const c of cards) {
    const era = c.series || 'Unknown Era';
    const set = c.set || 'Unknown Set';
    if (!byEra[era]) { byEra[era] = {}; eraOrder.push(era); setOrderByEra[era] = []; }
    if (!byEra[era][set]) { byEra[era][set] = {}; setOrderByEra[era].push(set); }
    const r = c.rarity || 'Unknown';
    if (!byEra[era][set][r]) byEra[era][set][r] = [];
    byEra[era][set][r].push(c);
  }
  return { byEra, eraOrder, setOrderByEra };
}

function renderSetOverview(cards, el) {
  const { byEra, eraOrder, setOrderByEra } = buildSetGroups(cards);
  let html = '';
  for (const era of eraOrder) {
    const eraTotal = cards.filter(c => (c.series||'Unknown Era') === era).length;
    html += `<div class="era-section">
      <div class="era-header">
        <div class="era-title">${era}</div>
        <div class="era-count">${eraTotal} card${eraTotal!==1?'s':''}</div>
      </div>
      <div class="set-overview-grid">`;

    for (const set of setOrderByEra[era]) {
      const setData = byEra[era][set];
      const firstCard = Object.values(setData)[0][0];
      const setTotal = Object.values(setData).reduce((a,b) => a+b.length, 0);
      const setYear = firstCard.date ? firstCard.date.slice(0,4) : '';
      // Re-bucket by number prefix for accurate pill counts
      const ovBuckets = {};
      for (const [r, cards] of Object.entries(setData)) {
        for (const c of cards) {
          const prefix = (c.num || '').match(/^([A-Z]+)/)?.[1] || '';
          let bucket;
          if (prefix === 'TG') bucket = '__TG__';
          else if (r === 'Rare Ultra') {
            if (c.name && c.name.includes('&')) bucket = r; // Tag Team — already normalized
            else bucket = rareUltraBucket(c);
          } else bucket = r;
          if (!ovBuckets[bucket]) ovBuckets[bucket] = 0;
          ovBuckets[bucket]++;
        }
      }
      const OV_RANK = { '__TG__': rarityRank('Trainer Gallery Rare Holo'), '__GX__': rarityRank('Rare Ultra'), '__EX__': rarityRank('Rare Ultra') + 0.1, '__FA_POKEMON__': rarityRank('Rare Ultra') + 0.15, '__FA_TRAINER__': rarityRank('Rare Ultra') + 0.2 };
      const OV_LABEL = { '__TG__':'TG', '__GX__':'GX', '__EX__':'EX', '__FA_POKEMON__':'Full Art', '__FA_TRAINER__':'FA Trainer' };
      const OV_COLOR = { '__TG__':'Trainer Gallery Rare Holo', '__GX__':'Rare Ultra', '__EX__':'Rare Ultra', '__FA_POKEMON__':'Rare Ultra', '__FA_TRAINER__':'Rare Ultra' };
      const rarities = Object.keys(ovBuckets).sort((a,b) => (OV_RANK[a] ?? rarityRank(a)) - (OV_RANK[b] ?? rarityRank(b)));
      const pillsHtml = rarities.map(r => {
        const cnt = ovBuckets[r];
        const label = OV_LABEL[r] ?? shortRarity(r);
        const color = rarityColor(OV_COLOR[r] ?? r);
        return `<span class="set-ov-pill" style="background:${color}22;color:${color};">${cnt} ${label}</span>`;
      }).join('');

      const eraEnc = encodeURIComponent(era), setEnc = encodeURIComponent(set);
      const symbolUrl = firstCard?.setSymbol || '';
      // Symbol icons are drawn dark-on-transparent (meant for light backgrounds),
      // so instead of inverting the icon's own colors, give it a small light
      // "chip" to sit on — reads naturally without distorting any icon color.
      const symbolHtml = symbolUrl && symbolUrl !== 'N/A'
        ? `<span class="symbol-chip"><img class="set-ov-symbol" src="${symbolUrl}" alt="" loading="lazy"></span>`
        : '';
      // JP symbol now takes the wordmark logo's place on the overview card —
      // shown large (matching the old logo's footprint) instead of as a tiny
      // corner badge. Falls back to nothing if no JP equivalent is confirmed
      // (Emerald, Chaos Rising — wait, Chaos Rising has one — and the two
      // Black Star Promos sets, which were intentionally left unmapped).
      const jpSymbols = jpSymbolsFor(set);
      const jpLogoHtml = jpSymbols
        ? `<span class="jp-ov-logo-wrap">${jpSymbols.map(jp => `<img class="jp-ov-logo" src="${jp.symbol}" alt="${jp.name}" title="${jp.name}" loading="lazy" onerror="this.style.display='none'">`).join('')}</span>`
        : '';
      html += `<div class="set-ov-card" onclick="openSetDetail('${eraEnc}','${setEnc}')">
        <div class="set-ov-top">
          <div class="set-ov-left">
            ${symbolHtml}
            ${jpLogoHtml}
          </div>
          <span class="set-ov-year">${setYear}</span>
        </div>
        <div class="set-ov-name">${shortSetName(set)}</div>
        <div class="set-ov-total">${setTotal} card${setTotal!==1?'s':''}</div>
        <div class="set-ov-pills">${pillsHtml}</div>
      </div>`;
    }
    html += `</div></div>`; // set-overview-grid + era-section
  }
  el.innerHTML = html;
}

function openSetDetail(eraEnc, setEnc) {
  sessionStorage.setItem('overviewScroll', window.scrollY); // save overview position separately
  history.pushState({ setDetail: true }, '');
  _lastRenderedSet = null; // force full rebuild for new set
  _activeSet = { era: decodeURIComponent(eraEnc), set: decodeURIComponent(setEnc) };
  render();
  window.scrollTo(0, 0);
}

function renderSetDetail(cards, el) {
  const { byEra } = buildSetGroups(cards);
  const era = _activeSet.era, set = _activeSet.set;
  const setData = byEra[era]?.[set] || {};
  const firstCard = cards[0];
  // Set symbol (small icon, e.g. "PBL") instead of the full wordmark logo —
  // matches the compact style of the back button beside it. Wrapped in a
  // light chip since the icon is drawn dark-on-transparent for light backgrounds.
  const symbolHtml = firstCard.setSymbol && firstCard.setSymbol !== 'N/A'
    ? `<span class="symbol-chip symbol-chip-lg"><img class="set-detail-symbol" src="${firstCard.setSymbol}" alt="" onerror="this.style.display='none'"></span>`
    : '';
  const jpSymbolsDetail = jpSymbolsFor(set);
  const jpBadgesDetailHtml = jpSymbolsDetail
    ? `<span class="jp-badges">${jpSymbolsDetail.map(jp => `<img class="jp-symbol-mini" src="${jp.symbol}" alt="${jp.name}" title="${jp.name}" loading="lazy" onerror="this.style.display='none'">`).join('')}</span>`
    : '';
  const setYear = firstCard.date ? firstCard.date.slice(0,4) : '';
  // Sort helper: parse prefixed card numbers like TG01, GG30, SWSH123 numerically
  function cardNumSort(a, b) {
    const parse = n => { const m = (n||'').match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; };
    return parse(a.num) - parse(b.num);
  }

  // Re-bucket all cards in this set by number-prefix and card type.
  // TG prefix → '__TG__'
  // Rare Ultra → classified by rareUltraBucket() (subtypes-based, with
  // name-matching fallback) into GX / EX / plain Full Art Pokémon / Trainer.
  // Everything else → keep original rarity string
  const rebucketed = {};
  for (const [r, cards] of Object.entries(setData)) {
    for (const c of cards) {
      const prefix = (c.num || '').match(/^([A-Z]+)/)?.[1] || '';
      let bucket;
      if (prefix === 'TG') {
        bucket = '__TG__';
      } else if (r === 'Rare Ultra') {
        if (c.name && c.name.includes('&')) bucket = r; // Tag Team — already normalized
        else bucket = rareUltraBucket(c);
      } else {
        bucket = r;
      }
      if (!rebucketed[bucket]) rebucketed[bucket] = [];
      rebucketed[bucket].push(c);
    }
  }

  const BUCKET_RANK = {
    '__TG__':         rarityRank('Trainer Gallery Rare Holo'),
    '__GX__':         rarityRank('Rare Ultra'),
    '__EX__':         rarityRank('Rare Ultra') + 0.1,
    '__FA_POKEMON__': rarityRank('Rare Ultra') + 0.15,
    '__FA_TRAINER__': rarityRank('Rare Ultra') + 0.2,
  };
  const bucketOrder = Object.keys(rebucketed).sort((a, b) => {
    const rankA = BUCKET_RANK[a] ?? rarityRank(a);
    const rankB = BUCKET_RANK[b] ?? rarityRank(b);
    return rankA - rankB;
  });

  let html = `<div class="set-detail-header">
    <button class="set-detail-back" onclick="history.back()">← All Sets</button>
    ${symbolHtml}
    ${jpBadgesDetailHtml}
    <div class="set-detail-info">
      <div class="set-detail-era">${era} · ${setYear}</div>
      <div class="set-detail-name">${set}</div>
    </div>
  </div>`;

  const BUCKET_LABEL = { '__TG__':'TG', '__GX__':'GX', '__EX__':'EX', '__FA_POKEMON__':'Full Art', '__FA_TRAINER__':'FA Trainer' };
  const BUCKET_COLOR_KEY = { '__TG__':'Trainer Gallery Rare Holo', '__GX__':'Rare Ultra', '__EX__':'Rare Ultra', '__FA_POKEMON__':'Rare Ultra', '__FA_TRAINER__':'Rare Ultra' };

  // Flattened on-screen order, in the exact sequence cards are about to be
  // rendered below — feeds _setDetailOrder so the modal's Prev/Next matches
  // what's visually on screen (see _setDetailOrder comment for why).
  const onScreenOrder = [];

  for (const bucket of bucketOrder) {
    const rarCards = [...rebucketed[bucket]].sort(cardNumSort);
    const displayLabel = BUCKET_LABEL[bucket] ?? shortRarity(bucket);
    const color = rarityColor(BUCKET_COLOR_KEY[bucket] ?? bucket);

    html += `<div class="rarity-group">
      <div class="rarity-group-header">
        <span class="rarity-group-label" style="color:${color};">${displayLabel}</span>
        <span class="rarity-group-count">(${rarCards.length})</span>
      </div>
      <div class="detail-card-grid">`;

    for (const c of rarCards) {
      onScreenOrder.push(c);
      const owned = isOwned(c);
      const cdata = JSON.stringify(c).replace(/'/g,'&#39;');
      const key = cardKey(c).replace(/[^a-z0-9]/gi,'_');
      const changeBadge = priceChangeBadge(c.price, c.prevPrice);
      const thumbHtml = c.pic && c.pic !== 'N/A'
        ? `<img class="crow-thumb" src="${c.pic}" alt="${c.name||''}" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="crow-thumb-empty">?</div>`;
      html += `<div class="card-row${owned?' owned':''}" id="row-${key}" onclick='openModal(${cdata})'>
        <div class="crow-check${owned?' owned':''}" onclick='event.stopPropagation();handleToggle(${cdata})'>${owned?'✓':''}</div>
        ${thumbHtml}
        <span class="crow-num">#${c.num||'—'}</span>
        <span class="crow-name">${c.name||'—'}</span>
        <div class="crow-price-wrap">
          <span class="crow-price">${c.price!=='N/A'?c.price:'—'}</span>${changeBadge}
          ${seventyPercentBadgeHtml(c)}
        </div>
      </div>`;
    }
    html += `</div></div>`; // detail-card-grid + rarity-group
  }
  _setDetailOrder = onScreenOrder;
  el.innerHTML = html;
}

// FEATURE (2026-07-30): flat (ungrouped-by-era) grid — companion to
// renderFlatList() for list view. Same reasoning: "Recent Purchases" and the
// price sorts are one global ordering across every set, and renderGrid()'s
// era-section bucketing would otherwise scatter that order back across
// separate sections (e.g. your most-recent purchase could land in a section
// far down the page while an older buy in a "newer" era shows first).
function renderGridFlat(cards, el, title) {
  let html = `<div class="era-section">
      <div class="era-header">
        <div class="era-title">${title}</div>
        <div class="era-count">${cards.length} card${cards.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="card-grid">`;
  for (const c of cards) {
    const cls = rarityClass(c.rarity, c.name, c.num);
    const short = shortRarity(c.rarity, c.name, c.num, c.subtypes, c.supertype);
    const owned = isOwned(c);
    const cdata = JSON.stringify(c).replace(/'/g, '&#39;');
    const key = cardKey(c).replace(/[^a-z0-9]/gi,'_');
    const changeBadge = priceChangeBadge(c.price, c.prevPrice);
    const imgSrc = c.pic && c.pic !== 'N/A' ? c.pic : '';
    const imgTag = imgSrc
      ? `<img src="${imgSrc}" alt="${c.name||''}" loading="lazy" onerror="this.style.background='var(--panel2)';this.removeAttribute('src')">`
      : `<div style="aspect-ratio:2.5/3.5;background:var(--panel2);display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:12px;">No Image</div>`;
    html += `<div class="card-tile${owned?' owned':''}" id="tile-${key}" onclick='openModal(${cdata})'>
      ${imgTag}
      <div class="tile-check" onclick='event.stopPropagation();handleToggle(${cdata})'>${owned?'✓':''}</div>
      <div class="tile-info">
        <div class="tile-name" title="${c.name||''}">${c.name||'—'}</div>
        <div class="tile-set" title="${c.set}">${c.set}</div>
        <div class="tile-footer">
          <div class="tile-price-row"><span class="tile-price">${c.price!=='N/A'?c.price:'—'}</span>${seventyPercentBadgeHtml(c)}${changeBadge}</div>
          <span class="pill ${cls}">${short}</span>
        </div>
      </div>
    </div>`;
  }
  html += `</div></div>`;
  el.innerHTML = html;
}

function renderGrid(cards, el) {
  const byEra = {};
  const eraOrder = [];
  for (const c of cards) {
    const era = c.series || 'Unknown Era';
    if (!byEra[era]) { byEra[era] = []; eraOrder.push(era); }
    byEra[era].push(c);
  }
  let html = '';
  for (const era of eraOrder) {
    const eraCards = byEra[era];
    html += `<div class="era-section">
      <div class="era-header">
        <div class="era-title">${era}</div>
        <div class="era-count">${eraCards.length} card${eraCards.length !== 1 ? 's' : ''}</div>
      </div>
      <div class="card-grid">`;
    for (const c of eraCards) {
      const cls = rarityClass(c.rarity, c.name, c.num);
      const short = shortRarity(c.rarity, c.name, c.num, c.subtypes, c.supertype);
      const owned = isOwned(c);
      const cdata = JSON.stringify(c).replace(/'/g, '&#39;');
      const key = cardKey(c).replace(/[^a-z0-9]/gi,'_');
      const changeBadge = priceChangeBadge(c.price, c.prevPrice);
      const imgSrc = c.pic && c.pic !== 'N/A' ? c.pic : '';
      const imgTag = imgSrc
        ? `<img src="${imgSrc}" alt="${c.name||''}" loading="lazy" onerror="this.style.background='var(--panel2)';this.removeAttribute('src')">`
        : `<div style="aspect-ratio:2.5/3.5;background:var(--panel2);display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:12px;">No Image</div>`;
      html += `<div class="card-tile${owned?' owned':''}" id="tile-${key}" onclick='openModal(${cdata})'>
        ${imgTag}
        <div class="tile-check" onclick='event.stopPropagation();handleToggle(${cdata})'>${owned?'✓':''}</div>
        <div class="tile-info">
          <div class="tile-name" title="${c.name||''}">${c.name||'—'}</div>
          <div class="tile-set" title="${c.set}">${c.set}</div>
          <div class="tile-footer">
            <div class="tile-price-row"><span class="tile-price">${c.price!=='N/A'?c.price:'—'}</span>${seventyPercentBadgeHtml(c)}${changeBadge}</div>
            <span class="pill ${cls}">${short}</span>
          </div>
        </div>
      </div>`;
    }
    html += `</div></div>`;
  }
  el.innerHTML = html;
}

function handleToggle(c) {
  const justAdded = toggleOwned(c);
  const key = cardKey(c).replace(/[^a-z0-9]/gi,'_');
  const owned = isOwned(c);
  // List row
  const row = document.getElementById('row-' + key);
  if (row) {
    row.classList.toggle('owned', owned);
    const chk = row.querySelector('.crow-check');
    if (chk) { chk.textContent = owned ? '✓' : ''; chk.classList.toggle('owned', owned); }
  }
  // Grid tile
  const tile = document.getElementById('tile-' + key);
  if (tile) {
    tile.classList.toggle('owned', owned);
    const chk = tile.querySelector('.tile-check');
    if (chk) chk.textContent = owned ? '✓' : '';
  }
  // FEATURE (2026-07-29): checking a card owned from the list/grid (not just
  // the in-modal button) also opens the modal with the purchase-price
  // prompt, per the same flow as clicking "Mark as Owned" inside an already-
  // open modal. Never triggered on un-owning (justAdded is false then).
  if (justAdded) {
    openModal(c);
    showPurchasePrompt();
  }
}

// ─── VIEW SWITCH (no-op — kept for filter drawer mobile sync compat) ─────────

// ─── MODAL ───────────────────────────────────────────────────────────────────
let _modalCard = null;
let _modalList = [];   // current filtered card list for prev/next navigation
let _modalIdx  = -1;   // index of open card within _modalList

// Flattened, on-screen order for the currently-rendered set detail page
// (bucket order, then cardNumSort within each bucket — see renderSetDetail).
// BUG FIX (2026-07-27): openModal() used to always rebuild _modalList from
// getFiltered() (the global search/sort list), even when a card was opened
// from the set-detail view — which displays cards in a totally different
// order (grouped by rarity bucket, ascending card number within each). That
// mismatch made Prev/Next silently jump through the wrong list, so the
// buttons could visually appear to move backward relative to the numbers
// on screen. Populated by renderSetDetail(); cleared elsewhere so the
// global list is used everywhere else (main grid, price-movers, etc.).
let _setDetailOrder = null;

function modalNav(dir) {
  const next = _modalIdx + dir;
  if (next < 0 || next >= _modalList.length) return;
  _modalIdx = next;
  openModal(_modalList[_modalIdx], false);
}

function updateNavState() {
  const prev = document.getElementById('mNavPrev');
  const next = document.getElementById('mNavNext');
  const counter = document.getElementById('mNavCounter');
  if (prev) prev.classList.toggle('disabled', _modalIdx <= 0);
  if (next) next.classList.toggle('disabled', _modalIdx >= _modalList.length - 1);
  if (counter && _modalList.length > 1) {
    counter.textContent = `${_modalIdx + 1} / ${_modalList.length}`;
  } else if (counter) {
    counter.textContent = '';
  }
}

function openModal(c, updateList = true) {
  _modalCard = c;
  // Always start with the purchase-price prompt hidden — it's only shown
  // explicitly via showPurchasePrompt() right after marking a NEW card
  // owned, never left over from whatever card was open before.
  const promptEl = document.getElementById('mPurchasePrompt');
  if (promptEl) promptEl.style.display = 'none';
  if (updateList) {
    // Use the set-detail page's own on-screen order (bucket + card-number
    // order) when opened from there, instead of the unrelated global
    // search/sort list — see _setDetailOrder comment above for why.
    _modalList = _setDetailOrder || getFiltered();
    _modalIdx = _modalList.findIndex(x => x.cardId === c.cardId && x.num === c.num && x.set === c.set);
    if (_modalIdx === -1) _modalIdx = 0;
    // Save scroll position and push a history entry so back button closes modal
    sessionStorage.setItem('binderScroll', window.scrollY);
    history.pushState({ modal: true }, '');
  }
  updateNavState();
  const nameStr = c.name || '(Unknown)';
  document.getElementById('mName').textContent = nameStr;
  // Rarity pill
  const rarityPill = document.getElementById('mRarityPill');
  if (rarityPill) {
    const pillCls = rarityClass(c.rarity, c.name, c.num);
    const pillLabel = shortRarity(c.rarity, c.name, c.num, c.subtypes, c.supertype);
    rarityPill.className = `pill ${pillCls}`;
    rarityPill.textContent = pillLabel;
  }
  // Card number under image — show as #num/total if total available
  const cardNumEl = document.getElementById('mCardNum');
  if (cardNumEl) {
    if (c.num) {
      cardNumEl.textContent = c.setTotal ? `#${c.num} / ${c.setTotal}` : `#${c.num}`;
    } else {
      cardNumEl.textContent = '';
    }
  }
  // Condensed to one line (set · series · date) instead of three stacked lines,
  // to free up vertical space for the card image and price chart.
  document.getElementById('mMeta').innerHTML =
    [c.set, c.series, formatDateDisplay(c.date)].filter(Boolean).join(' <span class="meta-dot">·</span> ');
  // Price with change indicator in modal
  const cv = priceVal(c.price), pv = priceVal(c.prevPrice);
  let priceHtml = c.price && c.price !== 'N/A' ? c.price : 'Price N/A';
  // FEATURE (2026-08-02): price-change % hidden entirely in read-only share view.
  if (!READ_ONLY_SHARE && cv >= 0 && pv >= 0 && pv > 0) {
    const delta = cv - pv;
    const pct = (delta / pv * 100).toFixed(1);
    const sign = delta >= 0 ? '+' : '';
    const cls = delta >= 0 ? 'price-up' : 'price-down';
    const arrow = delta >= 0 ? '↑' : '↓';
    priceHtml += ` <span class="price-change ${cls}" style="font-size:13px;">${arrow} ${sign}${pct}%</span>`;
  }
  const staleBadge = stalePriceBadge(c);
  if (staleBadge) priceHtml += ' ' + staleBadge;
  // FEATURE (2026-08-02): both the 70%-of-market guidance and the recorded
  // "Paid" price are hidden entirely in read-only share view — neither is
  // useful or appropriate to show a visitor browsing someone else's collection.
  if (!READ_ONLY_SHARE) {
    const seventyLabel = seventyPercentLabel(c);
    if (seventyLabel) {
      priceHtml += `<div class="modal-70pct" title="70% of market price">70%: ${seventyLabel}</div>`;
    }
    // FEATURE (2026-07-29): show what was actually paid, but ONLY if a real
    // purchase price was recorded (Skip leaves it unset — never show "$0.00"
    // or fabricate a value for older cards added before this feature).
    const purchasePrice = ownedPurchasePrice(c);
    if (purchasePrice !== null && purchasePrice > 0) {
      priceHtml += `<div class="modal-purchase-price">Paid: $${purchasePrice.toFixed(2)}</div>`;
    }
  }
  document.getElementById('mPrice').innerHTML = priceHtml;

  const img = document.getElementById('mImg');
  const fallback = document.getElementById('mFallback');
  if (c.pic && c.pic !== 'N/A') {
    img.src = c.pic;
    img.style.display = '';
    fallback.style.display = 'none';
  } else {
    img.src = '';
    img.style.display = 'none';
    fallback.style.display = 'block';
  }

  // Map API set names → TCGplayer set names where they differ
  const SET_NAME_MAP = {
    'Base':                   'Base Set',
    'Jungle':                 'Jungle',
    'Fossil':                 'Fossil',
    'Base Set 2':             'Base Set 2',
    'Team Rocket':            'Team Rocket',
    'Gym Heroes':             'Gym Heroes',
    'Gym Challenge':          'Gym Challenge',
    'Neo Genesis':            'Neo Genesis',
    'Neo Discovery':          'Neo Discovery',
    'Neo Revelation':         'Neo Revelation',
    'Neo Destiny':            'Neo Destiny',
    'Legendary Collection':   'Legendary Collection',
    'Expedition Base Set':    'Expedition',
    'Aquapolis':              'Aquapolis',
    'Skyridge':               'Skyridge',
    'EX Ruby & Sapphire':     'EX Ruby & Sapphire',
    'EX Sandstorm':           'EX Sandstorm',
    'EX Dragon':              'EX Dragon',
    'EX Team Magma vs Team Aqua': 'EX Team Magma vs Team Aqua',
    'EX Hidden Legends':      'EX Hidden Legends',
    'EX FireRed & LeafGreen': 'EX FireRed & LeafGreen',
    'EX Team Rocket Returns': 'EX Team Rocket Returns',
    'EX Deoxys':              'EX Deoxys',
    'EX Emerald':             'EX Emerald',
    'EX Unseen Forces':       'EX Unseen Forces',
    'EX Delta Species':       'EX Delta Species',
    'EX Legend Maker':        'EX Legend Maker',
    'EX Holon Phantoms':      'EX Holon Phantoms',
    'EX Crystal Guardians':   'EX Crystal Guardians',
    'EX Dragon Frontiers':    'EX Dragon Frontiers',
    'EX Power Keepers':       'EX Power Keepers',
  };
  const tcgSet = SET_NAME_MAP[c.set] || c.set;
  const tcgQuery = encodeURIComponent(`${nameStr} ${tcgSet}`);
  document.getElementById('mBuy').href =
    `https://www.tcgplayer.com/search/pokemon/product?q=${tcgQuery}&view=grid`;

  // Update own button state (hidden entirely in read-only share view — see
  // body.read-only-share CSS rules — but keep textContent harmless either way)
  const ownBtn = document.getElementById('mOwn');
  const owned = isOwned(c);
  ownBtn.textContent = owned ? 'Owned' : '＋ Mark as Owned';
  ownBtn.classList.toggle('owned', owned);

  // FEATURE (2026-08-02): read-only share modal is trimmed to just image,
  // name, rarity/set/series/date, price, and the TCGPlayer link — no price
  // history chart (also hidden via CSS, this just skips the Chart.js work).
  if (!READ_ONLY_SHARE) {
    renderPriceChart(c.cardId || '');
  }

  document.getElementById('modalBackdrop').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function toggleFromModal() {
  if (!_modalCard) return;
  const c = _modalCard;
  const justAdded = toggleOwned(c);
  const owned = isOwned(c);
  const ownBtn = document.getElementById('mOwn');
  ownBtn.textContent = owned ? 'Owned' : '＋ Mark as Owned';
  ownBtn.classList.toggle('owned', owned);
  // Also sync any visible list/grid row for this card, same as handleToggle()
  // does — the modal can be reached from either view, and closing back out
  // shouldn't reveal a stale (un-updated) checkmark underneath.
  const key = cardKey(c).replace(/[^a-z0-9]/gi,'_');
  const row = document.getElementById('row-' + key);
  if (row) {
    row.classList.toggle('owned', owned);
    const chk = row.querySelector('.crow-check');
    if (chk) { chk.textContent = owned ? '✓' : ''; chk.classList.toggle('owned', owned); }
  }
  const tile = document.getElementById('tile-' + key);
  if (tile) {
    tile.classList.toggle('owned', owned);
    const chk = tile.querySelector('.tile-check');
    if (chk) chk.textContent = owned ? '✓' : '';
  }
  // FEATURE (2026-07-29): show the purchase-price prompt right in this
  // already-open modal when this action just marked the card owned (never
  // on un-owning). No need to re-open the modal — we're already looking at it.
  if (justAdded) showPurchasePrompt();
}

// ─── PURCHASE PRICE PROMPT ──────────────────────────────────────────────────
// Shown after marking a card owned (from either the list/grid checkbox via
// handleToggle(), or the in-modal button via toggleFromModal() above).
// Purely optional — Skip leaves purchasePrice unset, same as any card added
// before this feature existed.
function showPurchasePrompt() {
  const promptEl = document.getElementById('mPurchasePrompt');
  const input = document.getElementById('mPurchaseInput');
  if (!promptEl || !input) return;
  input.value = '';
  promptEl.style.display = '';
  // Focus for quick typing, but don't fight the modal's own open animation —
  // a microtask delay is enough for the display change above to take effect.
  setTimeout(() => input.focus(), 0);
}
function hidePurchasePrompt() {
  const promptEl = document.getElementById('mPurchasePrompt');
  if (promptEl) promptEl.style.display = 'none';
}
function savePurchasePrice() {
  if (!_modalCard) { hidePurchasePrompt(); return; }
  const input = document.getElementById('mPurchaseInput');
  const raw = input ? input.value.trim() : '';
  const val = parseFloat(raw);
  if (raw && !isNaN(val) && val >= 0) {
    setPurchasePrice(_modalCard, val);
  }
  hidePurchasePrompt();
}
function skipPurchasePrice() {
  hidePurchasePrompt();
}

function closeModal(restoreScroll = true) {
  document.getElementById('modalBackdrop').classList.remove('active');
  document.body.style.overflow = '';
  if (_priceChart) { _priceChart.destroy(); _priceChart = null; }
  if (restoreScroll) {
    const y = parseInt(sessionStorage.getItem('binderScroll') || '0', 10);
    // Restore after paint — modal CSS transition briefly holds layout,
    // so we wait two frames to ensure the scroll lands correctly
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.scrollTo({ top: y, behavior: 'instant' });
    }));
  }
}

document.getElementById('modalBackdrop').addEventListener('click', function(e) {
  if (e.target === this) {
    // User clicked backdrop — go back in history (which triggers popstate → closeModal)
    history.back();
  }
});

// Back button / mouse button 4 / swipe-back: intercept and handle in-app
window.addEventListener('popstate', function(e) {
  const isModalOpen = document.getElementById('modalBackdrop').classList.contains('active');
  if (isModalOpen) {
    closeModal(true);
    return;
  }
  if (_activeSet) {
    _activeSet = null;
    _lastRenderedSet = null;
    _trendMode = null;
    // Back out of a set always lands on the main overview in list view — if the
    // user had switched to grid while inside the set, grid mode would otherwise
    // carry over to the main overview, which needs a search/filter to show
    // anything and would look like the app just lost all its cards.
    if (currentView === 'grid') applyViewState('list');
    const y = parseInt(sessionStorage.getItem('overviewScroll') || '0', 10);
    render();
    // Restore after the rAF render paints — two frames to be safe on mobile
    requestAnimationFrame(() => requestAnimationFrame(() => {
      window.scrollTo({ top: y, behavior: 'instant' });
    }));
    return;
  }
  if (_trendMode) {
    _trendMode = null;
    ['btnGainers','btnGainersM','btnDrops','btnDropsM'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active-gainers','active-drops');
    });
    render();
  }
});

// Restore scroll position when returning to page (e.g. after following TCGplayer link)
window.addEventListener('pageshow', function() {
  const y = parseInt(sessionStorage.getItem('binderScroll') || '0', 10);
  if (y > 0) window.scrollTo({ top: y, behavior: 'instant' });
});

document.addEventListener('keydown', e => {
  const open = document.getElementById('modalBackdrop').classList.contains('active');
  if (e.key === 'Escape') { history.back(); return; }
  if (open && e.key === 'ArrowRight') { e.preventDefault(); modalNav(1); }
  if (open && e.key === 'ArrowLeft')  { e.preventDefault(); modalNav(-1); }
});

// Modal swipe left/right to navigate cards; swipe DOWN to close modal
(function() {
  const backdrop = document.getElementById('modalBackdrop');
  let _mx = null, _my = null;
  const SWIPE_MIN = 50, SWIPE_RATIO = 1.5;
  const SWIPE_DOWN_MIN = 80; // px downward to dismiss
  backdrop.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { _mx = null; return; }
    _mx = e.touches[0].clientX;
    _my = e.touches[0].clientY;
  }, { passive: true });
  backdrop.addEventListener('touchend', e => {
    if (_mx === null) return;
    const dx = e.changedTouches[0].clientX - _mx;
    const dy = e.changedTouches[0].clientY - _my;
    _mx = null;
    // Swipe down to dismiss modal
    if (dy > SWIPE_DOWN_MIN && Math.abs(dy) > Math.abs(dx)) {
      history.back(); // triggers popstate → closeModal
      return;
    }
    // Swipe left/right to navigate cards
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) / (Math.abs(dy) || 1) < SWIPE_RATIO) return;
    if (dx < 0) modalNav(1);   // swipe left → next card
    else         modalNav(-1); // swipe right → prev card
  }, { passive: true });
})();

// ─── SEARCH / FILTER EVENTS ──────────────────────────────────────────────────
let _searchDebounce = null;
document.getElementById('search').addEventListener('input', function() {
  document.getElementById('searchWrap').classList.toggle('has-text', !!this.value);
  clearTimeout(_searchDebounce);
  // Yield to browser paint so the typed character appears instantly,
  // then start the debounce timer
  const val = this.value;
  setTimeout(() => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(render, 300);
  }, 0);
});
document.getElementById('clearSearch').addEventListener('click', function() {
  document.getElementById('search').value = '';
  document.getElementById('searchWrap').classList.remove('has-text');
  render();
});
['eraFilter','rarityFilter'].forEach(id =>
  document.getElementById(id).addEventListener('change', render)
);
document.getElementById('sortBy').addEventListener('change', handleSortChange);

// FEATURE (2026-07-30): "Recent Purchases" only makes sense for owned cards
// (unowned cards have no purchase date, they'd all pile up at the bottom) —
// so selecting it auto-enables the "Owned" filter instead of making the
// user turn it on separately every time. Only turns it ON; switching away
// from Recent Purchases deliberately does NOT turn Owned back off, since the
// user may have wanted it on anyway (e.g. they came from Owned+Price sort).
function handleSortChange() {
  const sortValue = document.getElementById('sortBy').value;
  if (sortValue === 'recent-purchase' && !showOwnedOnly) {
    showOwnedOnly = true;
    document.getElementById('statOwnedBox').classList.toggle('active', true);
  }
  render();
}

// ─── MOBILE FILTER DRAWER ────────────────────────────────────────────────────
function toggleFilterDrawer() {
  const drawer = document.getElementById('filterDrawer');
  const btn = document.getElementById('filterToggleBtn');
  const open = drawer.classList.toggle('open');
  btn.classList.toggle('active', open);
  btn.textContent = open ? '✕ Close' : '⚙ Filters';
}

// Sync mobile selects ↔ desktop selects
function syncMobileFilters() {
  const eras = [...new Set(ALL_CARDS.map(c => c.series).filter(Boolean))].sort();
  document.getElementById('eraFilterM').innerHTML =
    '<option value="">All Eras</option>' + eras.map(e => `<option value="${e}">${e}</option>`).join('');
  // Mirror the desktop rarity dropdown (already built with TG collapsing)
  const desktopRar = document.getElementById('rarityFilter');
  document.getElementById('rarityFilterM').innerHTML = desktopRar ? desktopRar.innerHTML : '';
}

// Mobile selects mirror desktop and vice versa
[['eraFilter','eraFilterM'],['rarityFilter','rarityFilterM'],['sortBy','sortByM']].forEach(([desk, mob]) => {
  document.getElementById(mob).addEventListener('change', function() {
    document.getElementById(desk).value = this.value;
    // sortBy needs the Recent-Purchases-auto-enables-Owned logic (see
    // handleSortChange) — other filters just re-render directly.
    if (desk === 'sortBy') handleSortChange();
    else render();
  });
  document.getElementById(desk).addEventListener('change', function() {
    document.getElementById(mob).value = this.value;
  });
});

// Updates currentView + the list/grid toggle button highlighting only —
// does NOT touch trend mode or trigger a render. Shared by setView() and
// any code path that needs to force list view without clobbering trend state
// it's in the middle of setting (e.g. setTrend() activating Gainers/Drops).
function applyViewState(v) {
  currentView = v;
  ['btnList','btnGrid','btnListM','btnGridM','btnListQ','btnGridQ'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id.startsWith(v === 'list' ? 'btnList' : 'btnGrid'));
  });
}

function setView(v) {
  // Don't clear _activeSet — grid should show the same set you were just in
  // Switching view clears trend mode
  _trendMode = null;
  applyViewState(v);
  updateNowBtn();
  const gEl = document.getElementById('btnGainers');
  const dEl = document.getElementById('btnDrops');
  if (gEl) gEl.classList.remove('active-gainers');
  if (dEl) dEl.classList.remove('active-drops');
  render();
}

// ─── CSV UPLOAD ──────────────────────────────────────────────────────────────
document.getElementById('csvFile').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const cards = parseCSV(ev.target.result);
    if (cards.length > 0) loadCards(cards);
    else alert('Could not parse CSV — make sure it has a header row and card data.');
  };
  reader.readAsText(file, 'utf-8');
});

// Drag-and-drop
const dz = document.getElementById('dropZone');
dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.borderColor = 'var(--gold)'; });
dz.addEventListener('dragleave', () => { dz.style.borderColor = ''; });
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.style.borderColor = '';
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const cards = parseCSV(ev.target.result);
    if (cards.length > 0) loadCards(cards);
  };
  reader.readAsText(file, 'utf-8');
});

// ─── PRICE HISTORY CHART ─────────────────────────────────────────────────────
function renderPriceChart(cardId) {
  const canvas = document.getElementById('priceChart');
  const emptyMsg = document.getElementById('mChartEmpty');

  // Destroy existing chart instance
  if (_priceChart) { _priceChart.destroy(); _priceChart = null; }

  const history = PRICE_HISTORY[cardId] || [];

  if (history.length < 2) {
    canvas.style.display = 'none';
    emptyMsg.style.display = '';
    return;
  }

  canvas.style.display = '';
  emptyMsg.style.display = 'none';

  const labels = history.map(e => e.d);
  const prices = history.map(e => e.p);

  const first = prices[0], last = prices[prices.length - 1];
  const trending = last >= first ? '#4ade80' : '#f87171';

  _priceChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: prices,
        borderColor: trending,
        backgroundColor: trending + '18',
        borderWidth: 2,
        pointRadius: history.length <= 30 ? 3 : 0,
        pointBackgroundColor: trending,
        fill: true,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: ctx => formatDateDisplay(ctx[0]?.label || ''),
            label: ctx => `$${ctx.parsed.y.toFixed(2)}`,
          },
          backgroundColor: '#1f2330',
          borderColor: '#2b2f3d',
          borderWidth: 1,
          titleColor: '#8b8fa3',
          bodyColor: '#eae7dd',
          padding: 8,
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#8b8fa3', font: { size: 9 }, maxTicksLimit: 6,
            callback: function(value) {
              const label = this.getLabelForValue(value);
              return formatDateDisplay(label);
            },
          },
          grid: { color: '#2b2f3d' },
        },
        y: {
          ticks: {
            color: '#8b8fa3',
            font: { size: 9 },
            callback: v => '$' + v.toFixed(0),
          },
          grid: { color: '#2b2f3d' },
        }
      }
    }
  });
}

// ─── AUTO-LOAD: try fetching CSV from same directory ─────────────────────────
async function tryAutoLoad() {
  const bust = `?v=${Date.now()}`;

  // Also try to load price history JSON
  try {
    const histResp = await fetch('card-price-history.json' + bust);
    if (histResp.ok) {
      PRICE_HISTORY = await histResp.json();
    }
  } catch(e) {}

  // Try to fetch the CSV from the same folder (works when served via HTTP)
  const candidates = [
    'cards.csv',
    'POKEMON_RARITY_COLLECTION.csv',
    'pokemon_rarities_collection.csv',
  ];
  for (const name of candidates) {
    try {
      const resp = await fetch(name + bust);
      const ct = resp.headers.get('content-type') || '';
      if (resp.ok && !ct.includes('text/html')) {
        const text = await resp.text();
        const cards = parseCSV(text);
        if (cards.length > 0) {
          loadCards(cards);
          return;
        }
      }
    } catch(e) {}
  }
  // No CSV found — show upload UI
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('noDataState').style.display = 'block';
}

tryAutoLoad();

// ─── NAVIGATION: mouse button 4 (desktop back button) ────────────────────────
// All back navigation flows through history.back() → popstate handler above
document.addEventListener('mouseup', e => {
  if (e.button === 3) { e.preventDefault(); history.back(); }
});
document.addEventListener('mousedown', e => {
  if (e.button === 3) e.preventDefault();
});

// Swipe right (mobile) — track touch start/end on the main content area
(function() {
  let _tx = null, _ty = null;
  let _lastModalClose = 0; // timestamp of last modal close, to prevent accidental back swipe
  const SWIPE_MIN = 60;    // px horizontal travel
  const SWIPE_RATIO = 1.5; // must be more horizontal than vertical
  const EDGE_MAX = 40;     // px from left edge — require edge start to avoid false triggers
  const MODAL_COOLDOWN = 400; // ms to ignore swipe after modal closes

  // Track when modal closes so we can ignore the next swipe
  const origClose = window.closeModal;
  // Hook into popstate to track modal-close timing
  const origPopstate = window.onpopstate;

  document.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { _tx = null; return; }
    // Only register swipe if it starts near the left edge (like iOS back gesture)
    if (e.touches[0].clientX > EDGE_MAX) { _tx = null; return; }
    _tx = e.touches[0].clientX;
    _ty = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (_tx === null) return;
    const dx = e.changedTouches[0].clientX - _tx;
    const dy = Math.abs(e.changedTouches[0].clientY - _ty);
    _tx = null;
    // Don't fire page-back swipe when modal is open — modal has its own swipe handler
    if (document.getElementById('modalBackdrop').classList.contains('active')) return;
    // Ignore swipe briefly after modal closed (prevents double-back)
    if (Date.now() - _lastModalClose < MODAL_COOLDOWN) return;
    if (dx > SWIPE_MIN && Math.abs(dx) / (dy || 1) > SWIPE_RATIO) {
      history.back();
    }
  }, { passive: true });

  // Set cooldown timestamp when modal closes via popstate
  window.addEventListener('popstate', () => {
    const wasModalOpen = document.getElementById('modalBackdrop').classList.contains('active');
    // If popstate fires while modal was active, record the close time
    // (closeModal runs synchronously before this, so check after a tick)
    if (wasModalOpen) _lastModalClose = Date.now();
    else setTimeout(() => {
      if (!document.getElementById('modalBackdrop').classList.contains('active')) {
        _lastModalClose = Date.now();
      }
    }, 0);
  }, { capture: true }); // capture phase so this fires before the main popstate handler
})();
