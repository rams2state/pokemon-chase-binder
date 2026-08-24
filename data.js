// ─── APP VERSION ─────────────────────────────────────────────────────────────
// FEATURE (2026-08-02): single source of truth for the version number shown
// in the footer, so it's always obvious (without hard-refreshing) whether a
// push actually landed. Bumped ONLY when explicitly asked to "bump the
// version number" — patch (last number) for normal fixes/tweaks, can climb
// into the hundreds; minor/major bumped only if asked. History:
//   1.0.0 — 2026-08-02 — initial version number introduced.
//   1.0.1 — 2026-08-02 — bumped per request.
const APP_VERSION = '1.0.1';

// Render the version tag as soon as the DOM element exists — doesn't need to
// wait for card data to load, so it's set immediately rather than inside
// loadCards().
(function initVersionTag() {
  const el = document.getElementById('appVersion');
  if (el) el.textContent = 'v' + APP_VERSION;
})();

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
  // FEATURE (2026-08-02): read-only share view is permanently locked to the
  // owned-only grid (see loadCards()) — clicking the Owned stat box, or
  // Reset, must not be able to turn it back off.
  if (READ_ONLY_SHARE && showOwnedOnly) return;
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
  // REMOVED (2026-08-24): the entire per-condition (NM/LP/MP/HP/DMG) price
  // + per-condition source parsing that used to live here (priceNM/priceLP/
  // priceMP/priceHP/priceDMG, sourceNM/sourceLP/sourceMP/sourceHP/
  // sourceDMG). Jordan: "csv doesnt need the condition columns besides nm,
  // dont need the source columns, we should have just price or just price
  // nm." Investigating the live CSV first showed why dropping ALL of it
  // (not just LP/MP/HP/DMG) was the right call: 1,549 cards had both
  // "Price" and "Price NM" populated, and 1,526 of those had "Price NM"
  // sourced from the retired eBay raw-NM override — frozen/stale, and in
  // several cases badly wrong (e.g. Base Set Alakazam: Price $345.61 vs
  // Price NM $7.49, a 46x gap — almost certainly an eBay print-mismatch,
  // not a real price). The condition-tier UI itself was already fully
  // removed 2026-08-22 (see modal.js) — priceLP/MP/HP/DMG and their sources
  // had no consumer left even before this. Single "price"/"priceSource"
  // field below (from the CSV's "Price"/"Price Source" columns, unchanged)
  // is the only price now. The CSV writer (POKEMON_RARITY_COLLECTOR.py) no
  // longer writes these columns at all, so there's nothing left to parse.
  //
  // psa10Price (renamed 2026-08-22, was tagSlabPrice / "TAG Slab Price"):
  // an ACTIVE-LISTING asking-price floor (lowest 3 currently-active PSA-10
  // Buy It Now listings, averaged), not a sold-comp average — see
  // ebay_pricing.py's module docstring for why. REDESIGN (2026-08-24): now
  // fetched for EVERY card, EVERY collector run (no more day-alternating
  // with an NM check — see ebay_daily_runner.py's module docstring), so a
  // blank value here means PSA-10 is a genuinely thin active-listing market
  // for this specific card (a real, common outcome), not "wrong day/mode."
  // No JustTCG fallback (JustTCG doesn't track graded slabs), so this stays
  // blank if eBay can't clear MIN_LISTINGS_REQUIRED. Shown inline next to
  // the 70%-of-market price in the modal (see modal.js) — never in the
  // grid/list rows, only the modal and grid tiles (see tilePsa10Html() in
  // rarity.js).
  const psa10Price = raw.psa10_slab_price || raw['psa10_slab_price'] || raw.tag_slab_price || raw['tag_slab_price'] || '';
  // ADDED 2026-08-22: real per-card evidence of whether THIS card's own
  // stored price is drawn from a 1st Edition print — written by
  // POKEMON_RARITY_COLLECTOR.py (checks tcgplayer.prices for a
  // "1stEditionHolofoil" key, same check ebay_daily_runner.py's
  // _infer_printing_type() already does server-side to decide the eBay
  // query). Used by verify_links.js to build an accurate per-condition
  // "verify this price" link — only claims 1st Edition in the search text
  // when this is explicitly "true", never guessed. Blank/anything else
  // (including rows written before this column existed) means "don't know
  // — don't claim it," the same safe default used everywhere else in this
  // app when a signal is missing.
  const is1stEditionHolofoil = (raw.is_1st_edition || raw['is_1st_edition'] || '').toLowerCase() === 'true';
  // ADDED 2026-08-24: "Price Volatile" — Jordan: "since we have ebay
  // getting prices now no matter what, can we still have some sort of
  // symbol that lets me know if market price is within that previous 25%
  // trigger we had? that way i know to actually lookup the card and not
  // trust the market price from tcg even if there is no ebay price as
  // well?" True when TCGplayer's own cheapest active listing was >= market
  // price * 1.25 as of the last run that had a live pokemontcg.io fetch
  // for this card (the old price-gap trigger — see
  // POKEMON_RARITY_COLLECTOR.py / ebay_pricing.is_price_gap_triggered()) —
  // a signal TCGplayer's own active inventory looked thin/priced oddly
  // relative to its market snapshot, independent of whether an eBay check
  // happened to run for this card today. False/blank for Japanese cards
  // (no TCGplayer low-price field to compare) and for rows written before
  // this column existed — same "don't guess when there's no real data"
  // default used everywhere else in this app.
  const priceVolatile = (raw.price_volatile || raw['price_volatile'] || '').toLowerCase() === 'true';
  return { name, series, set, setCode, num, setTotal, rarity, price, prevPrice, cardId, pic, setLogo, setSymbol, date, lastChecked, lastPriced, supertype, subtypes, psa10Price, priceVolatile, _is1stEditionHolofoil: is1stEditionHolofoil };
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
  // ADDED 2026-08-21 (Japanese-cards feature): 7 sets confirmed via
  // Bulbapedia + pokesymbols.com that were missing from this table before
  // — real gaps, not naming variants, closed as part of grouping newly
  // added Japanese-market cards under their English set equivalents.
  "Diamond & Pearl": [{ name: "Space-Time Creation: Diamond Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/space-time-creation-diamond-collection.png" }, { name: "Pearl Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/pearl-collection.png" }],
  "Secret Wonders": [{ name: "Shining Darkness", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/shining-darkness.png" }],
  "Great Encounters": [{ name: "Moonlit Pursuit", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/moonlit-pursuit.png" }],
  "Majestic Dawn": [{ name: "Dawn Dash", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dawn-dash.png" }],
  "Legends Awakened": [{ name: "Cry from the Mysterious", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/cry-from-the-mysterious.png" }, { name: "Temple of Anger", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/temple-of-anger.png" }],
  "Arceus": [{ name: "Advent of Arceus", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/advent-of-arceus.png" }],
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

// Maps each real Japanese-card tile's display set name (the exact `c.set`
// string those synthetic cards carry, i.e. "{Set Name} (Japanese)") to the
// English set it should be grouped/badged with, plus the ONE specific
// JP_SET_SYMBOLS entry (name+symbol) that matches this exact Japanese
// product — as opposed to jpSymbolsFor()'s array of ALL JP equivalents for
// an English set, which is what's shown when no real JP tile exists yet.
// Built 2026-08-21 from JAPANESE_SET_ENGLISH_EQUIVALENT (see japanese_
// english_set_grouping.py) cross-referenced against JP_SET_SYMBOLS above.
// Sets absent here have no confirmed English equivalent and render as
// standalone Japanese-only tiles (Pokémon VS, Lost Link, Classic Collection,
// the two earliest no-rarity-era sets — see that Python module for why).
const JP_SET_TO_ENGLISH = {
  "ADV Expansion Pack (Japanese)": { englishSet: "Ruby & Sapphire", name: "ADV Expansion Pack", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/adv-expansion-pack.png" },
  "BW1: Black Collection (Japanese)": { englishSet: "Black & White", name: "Black Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/black-collection.png" },
  "BW1: White Collection (Japanese)": { englishSet: "Black & White", name: "White Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/white-collection.png" },
  "BW2: Red Collection (Japanese)": { englishSet: "Noble Victories", name: "Red Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/red-collection.png" },
  "BW3: Hail Blizzard (Japanese)": { englishSet: "Next Destinies", name: "Hail Blizzard", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/hail-blizzard.png" },
  "BW3: Psycho Drive (Japanese)": { englishSet: "Next Destinies", name: "Psycho Drive", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/psycho-drive.png" },
  "BW4: Dark Rush (Japanese)": { englishSet: "Dark Explorers", name: "Dark Rush", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dark-rush.png" },
  "BW5: Dragon Blade (Japanese)": { englishSet: "Dragons Exalted", name: "Dragon Blade", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dragon-blade.png" },
  "BW5: Dragon Blast (Japanese)": { englishSet: "Dragons Exalted", name: "Dragon Blast", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dragon-blast.png" },
  "BW6: Cold Flare (Japanese)": { englishSet: "Boundaries Crossed", name: "Cold Flare", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/cold-flare.png" },
  "BW6: Freeze Bolt (Japanese)": { englishSet: "Boundaries Crossed", name: "Freeze Bolt", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/freeze-bolt.png" },
  "BW7: Plasma Gale (Japanese)": { englishSet: "Plasma Storm", name: "Plasma Gale", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/plasma-gale.png" },
  "BW8: Spiral Force (Japanese)": { englishSet: "Plasma Freeze", name: "Spiral Force", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/spiral-force.png" },
  "BW8: Thunder Knuckle (Japanese)": { englishSet: "Plasma Freeze", name: "Thunder Knuckle", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/thunder-knuckle.png" },
  "BW9: Megalo Cannon (Japanese)": { englishSet: "Plasma Blast", name: "Megalo Cannon", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/megalo-cannon.png" },
  "Base Expansion Pack (Japanese)": { englishSet: "Expedition Base Set", name: "Base Expansion Pack", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/base-expansion-pack.png" },
  "Clash of the Blue Sky (Japanese)": { englishSet: "Deoxys", name: "Clash of the Blue Sky", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/clash-of-the-blue-sky.png" },
  "DP1: Space-Time Creation (Japanese)": { englishSet: "Diamond & Pearl", name: "Space-Time Creation: Diamond Collection", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/space-time-creation-diamond-collection.png" },
  "DP2: Secret of the Lakes (Japanese)": { englishSet: "Mysterious Treasures", name: "Secret of the Lakes", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/secret-of-the-lakes.png" },
  "DP3: Shining Darkness (Japanese)": { englishSet: "Secret Wonders", name: "Shining Darkness", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/shining-darkness.png" },
  "DP4: Dawn Dash (Japanese)": { englishSet: "Majestic Dawn", name: "Dawn Dash", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/dawn-dash.png" },
  "DP4: Moonlit Pursuit (Japanese)": { englishSet: "Great Encounters", name: "Moonlit Pursuit", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/moonlit-pursuit.png" },
  "DP5: Cry from the Mysterious (Japanese)": { englishSet: "Legends Awakened", name: "Cry from the Mysterious", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/cry-from-the-mysterious.png" },
  "DP5: Temple of Anger (Japanese)": { englishSet: "Legends Awakened", name: "Temple of Anger", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/temple-of-anger.png" },
  "EX Battle Boost (Japanese)": { englishSet: "Legendary Treasures", name: "EX Battle Boost", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/ex-battle-boost.png" },
  "Flight of Legends (Japanese)": { englishSet: "FireRed & LeafGreen", name: "Flight of Legends", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/flight-of-legends.png" },
  "Golden Sky, Silvery Ocean (Japanese)": { englishSet: "Unseen Forces", name: "Golden Sky, Silvery Ocean", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/golden-sky-silvery-ocean.png" },
  "Holon Phantom (Japanese)": { englishSet: "Holon Phantoms", name: "Holon Phantom", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/holon-phantom.png" },
  "Holon Research Tower (Japanese)": { englishSet: "Delta Species", name: "Holon Research Tower", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/holon-research-tower.png" },
  "Intense Fight in the Destroyed Sky (Japanese)": { englishSet: "Stormfront", name: "Intense Fight in the Destroyed Sky", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/intense-fight-in-the-destroyed-sky.png" },
  "L1: HeartGold Collection (Japanese)": { englishSet: "HeartGold & SoulSilver", name: "HeartGold Collection", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/heartgold-collection.png" },
  "L1: SoulSilver Collection (Japanese)": { englishSet: "HeartGold & SoulSilver", name: "SoulSilver Collection", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/soulsilver-collection.png" },
  "L2: Reviving Legends (Japanese)": { englishSet: "HS—Undaunted", name: "Reviving Legends", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/reviving-legends.png" },
  "L3: Clash at the Summit (Japanese)": { englishSet: "HS—Triumphant", name: "Clash at the Summit", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/clash-at-the-summit.png" },
  "Leaders' Stadium (Japanese)": { englishSet: "Gym Heroes", name: "Leaders' Stadium", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/leaders-stadium.png" },
  "Magma VS Aqua: Two Ambitions (Japanese)": { englishSet: "Team Magma vs Team Aqua", name: "Magma VS Aqua: Two Ambitions", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/magma-vs-aqua-two-ambitions.png" },
  "Miracle Crystal (Japanese)": { englishSet: "Crystal Guardians", name: "Miracle Crystal", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/miracle-crystal.png" },
  "Miracle of the Desert (Japanese)": { englishSet: "Sandstorm", name: "Miracle of the Desert", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/miracle-of-the-desert.png" },
  "Mirage Forest (Japanese)": { englishSet: "Legend Maker", name: "Mirage Forest", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/mirage-forest.png" },
  "Mysterious Mountains (Japanese)": { englishSet: "Skyridge", name: "Mysterious Mountains", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/mysterious-mountains.png" },
  "Mystery of the Fossils (Japanese)": { englishSet: "Fossil", name: "Mystery of the Fossils", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/mystery-of-the-fossils.png" },
  "Offense and Defense of the Furthest Ends (Japanese)": { englishSet: "Dragon Frontiers", name: "Offense and Defense of the Furthest Ends", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/offense-and-defense-of-the-furthest-ends.png" },
  "Pt1: Galactic's Conquest (Japanese)": { englishSet: "Platinum", name: "Galactic's Conquest", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/galactics-conquest.png" },
  "Pt2: Bonds to the End of Time (Japanese)": { englishSet: "Rising Rivals", name: "Bonds to the End of Time", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/bonds-to-the-end-of-time.png" },
  "Pt3: Beat of the Frontier (Japanese)": { englishSet: "Supreme Victors", name: "Beat of the Frontier", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/beat-of-the-frontier.png" },
  "Pt4: Advent of Arceus (Japanese)": { englishSet: "Arceus", name: "Advent of Arceus", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/advent-of-arceus.png" },
  "Rocket Gang (Japanese)": { englishSet: "Team Rocket", name: "Rocket Gang", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/rocket-gang.png" },
  "Rocket Gang Strikes Back (Japanese)": { englishSet: "Team Rocket Returns", name: "Rocket Gang Strikes Back", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rocket-gang-strikes-back.png" },
  "Rulers of the Heavens (Japanese)": { englishSet: "Dragon", name: "Rulers of the Heavens", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rulers-of-the-heavens.png" },
  "Split Earth (Japanese)": { englishSet: "Skyridge", name: "Split Earth", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/split-earth.png" },
  "The Town on No Map (Japanese)": { englishSet: "Aquapolis", name: "The Town on No Map", symbol: "https://pokesymbols.com/images/tcg/japanese-sets/symbols/the-town-on-no-map.png" },
  "Undone Seal (Japanese)": { englishSet: "Hidden Legends", name: "Undone Seal", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/undone-seal.png" },
  "Wind from the Sea (Japanese)": { englishSet: "Aquapolis", name: "Wind from the Sea", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/wind-from-the-sea.png" },
  "XY10: Awakening Psychic King (Japanese)": { englishSet: "Fates Collide", name: "Awakening Psychic King", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/awakening-psychic-king.png" },
  "XY11-Bb: Fever-Burst Fighter (Japanese)": { englishSet: "Steam Siege", name: "Fever-Burst Fighter", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/fever-burst-fighter.png" },
  "XY11-Br: Cruel Traitor (Japanese)": { englishSet: "Steam Siege", name: "Cruel Traitor", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/cruel-traitor.png" },
  "XY2: Wild Blaze (Japanese)": { englishSet: "Flashfire", name: "Wild Blaze", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/wild-blaze.png" },
  "XY3: Rising Fist (Japanese)": { englishSet: "Furious Fists", name: "Rising Fist", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rising-fist.png" },
  "XY4: Phantom Gate (Japanese)": { englishSet: "Phantom Forces", name: "Phantom Gate", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/phantom-gate.png" },
  "XY5-Bg: Gaia Volcano (Japanese)": { englishSet: "Primal Clash", name: "Gaia Volcano", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/gaia-volcano.png" },
  "XY5-Bt: Tidal Storm (Japanese)": { englishSet: "Primal Clash", name: "Tidal Storm", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/tidal-storm.png" },
  "XY6: Emerald Break (Japanese)": { englishSet: "Roaring Skies", name: "Emerald Break", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/emerald-break.png" },
  "XY7: Bandit Ring (Japanese)": { englishSet: "Ancient Origins", name: "Bandit Ring", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/bandit-ring.png" },
  "XY8-Bb: Blue Shock (Japanese)": { englishSet: "BREAKthrough", name: "Blue Shock", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/blue-shock.png" },
  "XY8-Br: Red Flash (Japanese)": { englishSet: "BREAKthrough", name: "Red Flash", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/red-flash.png" },
  "XY9: Rage of the Broken Heavens (Japanese)": { englishSet: "BREAKpoint", name: "Rage of the Broken Heavens", symbol: "https://pokesymbols.com/images/low-res/japanese-sets/symbols/rage-of-the-broken-heavens.png" },
};

// Returns { englishSet, name, symbol } if `setName` is a real Japanese-card
// tile with a confirmed English equivalent (i.e. a key in JP_SET_TO_ENGLISH),
// else null. Used to (a) render the correct single JP symbol ON the Japanese
// tile itself, and (b) let jpSymbolsFor() know to suppress the old decorative
// badge on the corresponding English tile, since a real, separately-
// clickable Japanese tile now exists in its place.
function jpTileFor(setName) {
  return JP_SET_TO_ENGLISH[setName] || null;
}

// Given the full loaded card list, returns a Set of English set names that
// currently have at least one real Japanese tile grouped under them (per
// JP_SET_TO_ENGLISH) — i.e. English sets whose decorative JP badge should be
// suppressed, because the actual Japanese cards now have their own tile.
function englishSetsWithJpTile(cards) {
  const result = new Set();
  for (const c of cards) {
    const tile = jpTileFor(c.set);
    if (tile) result.add(tile.englishSet);
  }
  return result;
}

// Returns the JP symbol image URL(s) for a given English set name, or null if
// no confirmed Japanese equivalent exists. Trainer Gallery / Shiny Vault /
// Galarian Gallery subsets fall back to their parent set name.
// `suppressedEnglishSets` (optional Set, from englishSetsWithJpTile()) —
// when the English set name (or its Trainer/Galarian Gallery parent) is in
// this set, the badge is suppressed here too: a real Japanese tile now
// exists for it, so showing the old decorative badge on the English tile
// would be a duplicate of information the new Japanese tile already conveys.
function jpSymbolsFor(setName, suppressedEnglishSets) {
  if (!setName) return null;
  if (JP_SYMBOL_VISUALLY_DUPLICATE.has(setName)) return null;
  if (suppressedEnglishSets && suppressedEnglishSets.has(setName)) return null;
  if (JP_SET_SYMBOLS[setName]) return JP_SET_SYMBOLS[setName];
  const parent = setName.replace(/ (Trainer Gallery|Galarian Gallery)$/, '');
  if (parent !== setName && JP_SYMBOL_VISUALLY_DUPLICATE.has(parent)) return null;
  if (parent !== setName && suppressedEnglishSets && suppressedEnglishSets.has(parent)) return null;
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
