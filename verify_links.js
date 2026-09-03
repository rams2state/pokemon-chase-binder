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
// active-Buy-It-Now scope the backend's own eBay calls use.
//
// BUG FIX (2026-08-24): this used to append
// "-psa -bgs -cgc -sgc -tag -graded -slab" to try to exclude graded slabs —
// Jordan found live that this exclusion string returns 0 results ("i
// noticed that the ... on the end of the search string was returning
// nothing"). Root cause: eBay's keyword matcher AND's every required term
// together, and for cards whose real inventory is mostly graded (true of
// most valuable vintage/Japanese cards), a 7-term exclusion list on top of
// an already-specific name/set/condition query collapses matches to zero.
// Per Jordan, dropping the exclusions entirely and filtering the (mixed
// graded+raw) results by hand is an acceptable tradeoff — restored to that.
function buildEbayVerifyUrl(c, conditionKey) {
  const searchText = buildVerifySearchText(c, conditionKey);
  const params = new URLSearchParams({
    _nkw: searchText,
    _sacat: '183454', // Pokémon Individual Cards — same category ebay_pricing.py scopes to
    LH_BIN: '1',       // Buy It Now only, matching the backend's active-listing model
  });
  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

// eBay PSA 10: opens a live search for graded PSA 10 copies of this card —
// same query shape ebay_pricing.py itself uses server-side to produce the
// PSA10 Slab Price shown on the card (is_slab=True), so clicking this
// reproduces the actual comps behind that price. No condition label (a
// graded slab has no separate raw condition — PSA's grade IS the
// condition; confirmed live that adding one, e.g. "Near Mint", zeroes out
// real PSA 10 results). Used by the new always-visible PSA10 price box in
// the modal (2026-08-24) — clickable whether or not a PSA10 price is known
// yet for this card, so Jordan can always check eBay directly.
//
// SIMPLIFIED (2026-09-02): dropped the other-grade/other-grader/junk
// exclusion list (-"PSA 9" -"PSA 8" ... -bgs -cgc -sgc -tag -proxy -replica
// -digital, 11 terms). Jordan: "I think ebay query should go something
// like '{first edition (if not dont include)} + {cardname} + {set} +
// {holo (if not dont include)} psa 10'" — no exclusions at all, matching
// the exact same lesson this codebase already learned twice before (see
// ebay_pricing.py's _PSA_GRADES_BELOW_10 trim and the 2026-08-24 raw-NM
// bug fix): eBay's Browse/search matcher effectively ANDs every excluded
// term in with the required ones, so a long exclusion list on top of an
// already-specific name+set+grade query collapses real matches to almost
// nothing. Query is now just: [1st Edition] name [Japanese] set [Holo]
// "PSA 10" — nothing subtracted.
function buildEbayPsa10VerifyUrl(c) {
  // WORD ORDER (2026-09-02): "Japanese" moved right after the optional
  // 1st-Edition marker, ahead of the card name — Jordan: "I think ebay
  // query should go something like '{first edition (if not dont include)}
  // + {cardname} + {set} + {holo (if not dont include)} psa 10'" followed
  // by "throw japanese(if not dont include) to the front of that". Mirrors
  // the same reorder made in ebay_pricing.py's PRINTING_JAPANESE_VINTAGE /
  // PRINTING_JAPANESE_1ST_ED branches, so this button's query matches what
  // the backend collector actually searches for.
  const name = c.name || '';
  let searchText;
  if (_verifyIsJapanese(c)) {
    const cleanSet = _verifyCleanSet(c);
    const parts = [];
    if (_verifyIsJapanese1stEdition(c)) parts.push('1st Edition');
    parts.push('Japanese', name, cleanSet, 'Holo');
    searchText = parts.filter(Boolean).join(' ');
  } else {
    const cleanSet = c.set || '';
    const parts = [];
    if (_verifyIs1stEdition(c)) parts.push('1st Edition');
    parts.push(name, cleanSet);
    if (_verifyIsVintageRareHolo(c) || _verifyIs1stEdition(c)) parts.push('Holo');
    searchText = parts.filter(Boolean).join(' ');
  }
  searchText += ' "PSA 10"';
  const params = new URLSearchParams({
    _nkw: searchText,
    _sacat: '183454',
    LH_BIN: '1',
  });
  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

// PriceCharting: shows BOTH ungraded and every graded tier (PSA 9, PSA 10,
// etc.) on one page, sourced from actual sold listings rather than eBay's
// current-active-listings-only model — added 2026-09-02 to replace the
// "Find on eBay" raw-card button. Jordan: "i like the idea of swapping find
// on ebay button with pricecharting button instead that way we can see
// ungraded and graded prices" / "in the mean time keep everything ebay,
// but just replace the find on ebay button with pricecharting button. we
// can still click on the psa10 button to go to ebay" — so ONLY this
// general-purpose button changes; the PSA10 box (buildEbayPsa10VerifyUrl
// above) still goes to eBay, untouched.
//
// Uses PriceCharting's search page (no API key needed — this is a plain
// browser link, not the paid Prices/Marketplace API) rather than trying to
// guess a direct product-page slug: PriceCharting's game-page URLs are
// slugified per-console/per-card in ways not worth reverse-engineering
// client-side, and their search results page reliably surfaces the right
// card near the top for a specific-enough query, same tradeoff the
// existing buildTcgplayerVerifyUrl() above already makes.
function buildPriceChartingVerifyUrl(c) {
  const name = c.name || '';
  const num = (c.num || '').toString().trim();
  const cleanSet = _verifyCleanSet(c) || c.set || '';
  const parts = [];
  if (_verifyIsJapanese(c)) {
    if (_verifyIsJapanese1stEdition(c)) parts.push('1st Edition');
    parts.push(name, 'Japanese', cleanSet);
  } else {
    if (_verifyIs1stEdition(c)) parts.push('1st Edition');
    parts.push(name, cleanSet);
    if (_verifyIsVintageRareHolo(c) || _verifyIs1stEdition(c)) parts.push('Holo');
  }
  if (num) parts.push(num);
  const q = parts.filter(Boolean).join(' ');
  const params = new URLSearchParams({ q, type: 'prices' });
  return `https://www.pricecharting.com/search-products?${params.toString()}`;
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
