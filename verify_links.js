// verify_links.js — builds "verify this price" links for a card's per-
// condition cells (NM/LP/MP/HP/DMG), so clicking a condition in the modal
// opens the SAME kind of search the daily collector itself runs against
// eBay, plus a matching TCGplayer search, pre-filled with the card name,
// set, condition, and (where it matters) print/edition — instead of
// leaving Jordan to build the search by hand to spot-check a price.
//
// ADDED 2026-08-22, per Jordan: "is there a way that if a condition is
// clicked it can go to the site (either tcgplayer or ebay) and have the
// parameters passed in to confirm price?" — a direct response to the
// eBay-vs-JustTCG mismatch worry from the prior fix (the query-precision
// fix + the price-sanity-check fallback both reduce bad data automatically,
// but Jordan also wants a manual one-click way to eyeball any single cell
// himself, any time).
//
// DELIBERATELY MIRRORS ebay_pricing.py's query-building logic (condition
// phrasing, "Holo" keyword, card number, 1st-Edition detection, Japanese
// era phrasing) so the link a user clicks matches what the backend itself
// actually searched for — not a separately-invented, possibly-inconsistent
// query. Kept in plain, dependency-free JS since this runs client-side in
// the browser, no build step.

const CONDITION_EBAY_LABEL = {
  NM:  'Near Mint',
  LP:  'Lightly Played',
  MP:  'Moderately Played',
  HP:  'Heavily Played',
  DMG: 'Damaged',
};

// Same vintage-era series list used server-side (ebay_daily_runner.py's
// _VINTAGE_HOLO_SERIES) to decide whether a card is old enough that a bare
// "Holo" + card number query is the right shape, vs. a modern card where a
// generic name+set search is safer.
const VERIFY_VINTAGE_HOLO_SERIES = new Set(['Base', 'Gym', 'Neo', 'Legendary', 'E-Card']);

function _verifyIsJapanese(c) {
  // Japanese synthetic cards carry the app-internal "(Japanese)" suffix on
  // their set name (see japanese_cards.py) — same signal used to detect
  // them anywhere else in the frontend (no dedicated boolean field exists
  // on the CSV-sourced card object).
  return typeof c.set === 'string' && c.set.includes('(Japanese)');
}

function _verifyCleanSet(c) {
  return (c.set || '').replace(' (Japanese)', '').trim();
}

function _verifyIsVintageRareHolo(c) {
  const rarity = (c.rarity || '').toLowerCase();
  return VERIFY_VINTAGE_HOLO_SERIES.has(c.series) && rarity.includes('rare holo');
}

function _verifyIs1stEdition(c) {
  // Mirrors ebay_daily_runner.py's _infer_printing_type(): only claim "1st
  // Edition" when THIS card's own data actually indicates that print —
  // c._is1stEditionHolofoil (English cards — see data.js, POKEMON_
  // RARITY_COLLECTOR.py's "Is 1st Edition" column, checks the real
  // tcgplayer.prices["1stEditionHolofoil"] key). Falling back to false (no
  // edition claim) is always the SAFE default per Jordan's original
  // concern: never guess "1st Edition" without real per-card evidence.
  return c._is1stEditionHolofoil === true;
}

// BUG FIX (2026-08-22): "worried about japanese cards, they should also
// include first edition in the query shape" — Japanese vintage cards from
// the 1st_edition_holo era (2001-2016, per japanese_cards_data.py) ARE real
// 1st Edition prints, and the BACKEND's own eBay query for these cards
// already reflects that (ebay_pricing.japanese_ebay_printing_type() routes
// them through PRINTING_JAPANESE_1ST_ED — see ebay_pricing.py). This click-
// to-verify link builder had no equivalent check and always used the
// generic Japanese phrasing, regardless of era — a real gap, not a design
// tradeoff. Fixed using a signal already in the CSV today: japanese_cards.py
// writes rarity as the literal string "Rare Holo 1st Edition" (not just
// "Rare Holo") specifically for 1st_edition_holo-era cards — see
// japanese_cards.py's synthetic card builder — so this needs no new column,
// just checking for that string, same "real per-card evidence, never
// guessed" principle as the English check above.
function _verifyIsJapanese1stEdition(c) {
  return _verifyIsJapanese(c) && (c.rarity || '').includes('1st Edition');
}

// Builds the eBay Browse-API-style search text (same phrasing family as
// ebay_pricing.py's generate_ebay_search_string) for one condition cell.
function buildVerifySearchText(c, conditionKey) {
  const name = c.name || '';
  const num = (c.num || '').toString().trim();
  const condLabel = CONDITION_EBAY_LABEL[conditionKey] || 'Near Mint';

  if (_verifyIsJapanese(c)) {
    const cleanSet = _verifyCleanSet(c);
    // BUG FIX (2026-08-22): now adds "1st Edition" for Japanese cards whose
    // own rarity string confirms that era/print (see
    // _verifyIsJapanese1stEdition above) — mirrors ebay_pricing.py's
    // PRINTING_JAPANESE_1ST_ED branch. Classic Collection (2023 reprint)
    // and no-rarity-era (1996-98) Japanese cards aren't 1st Edition prints,
    // so they correctly stay on the plain form below.
    const parts = [];
    if (_verifyIsJapanese1stEdition(c)) parts.push('1st Edition');
    parts.push(name, 'Japanese', cleanSet, 'Holo', condLabel);
    return parts.filter(Boolean).join(' ');
  }

  const cleanSet = c.set || '';
  const parts = [];
  if (_verifyIs1stEdition(c)) parts.push('1st Edition');
  parts.push(name, cleanSet);
  if (_verifyIsVintageRareHolo(c) || _verifyIs1stEdition(c)) parts.push('Holo');
  if (num) parts.push(num);
  parts.push(condLabel);
  return parts.filter(Boolean).join(' ');
}

// eBay: opens a live search filtered to the condition, using the same
// active-Buy-It-Now scope the backend's own eBay calls use (raw cards only
// — graded slabs excluded via "-psa -bgs -cgc -sgc -tag -graded -slab", same
// exclusion list ebay_pricing.py applies server-side) so what Jordan sees
// matches what fed the price.
function buildEbayVerifyUrl(c, conditionKey) {
  const searchText = buildVerifySearchText(c, conditionKey) +
    ' -psa -bgs -cgc -sgc -tag -graded -slab';
  const params = new URLSearchParams({
    _nkw: searchText,
    _sacat: '183454', // Pokémon Individual Cards — same category ebay_pricing.py scopes to
    LH_BIN: '1',       // Buy It Now only, matching the backend's active-listing model
  });
  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

// TCGplayer: no per-condition filter in TCGplayer's URL scheme the way
// eBay has one, but the search can still be scoped to the right card/set/
// print so the condition just needs a glance at the listing grid.
function buildTcgplayerVerifyUrl(c, conditionKey) {
  const name = c.name || '';
  const set = _verifyCleanSet(c) || c.set || '';
  // BUG FIX (2026-08-22): now also checks the Japanese 1st-edition-era
  // signal (_verifyIsJapanese1stEdition), not just the English one — same
  // gap as the eBay query above.
  const is1st = _verifyIs1stEdition(c) || _verifyIsJapanese1stEdition(c);
  const editionTag = is1st ? ' 1st Edition' : '';
  const japaneseTag = _verifyIsJapanese(c) ? ' Japanese' : '';
  const q = `${name} ${set}${japaneseTag}${editionTag}`;
  const params = new URLSearchParams({ q, view: 'grid' });
  return `https://www.tcgplayer.com/search/pokemon/product?${params.toString()}`;
}
