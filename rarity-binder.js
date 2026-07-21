// ─── DATA ────────────────────────────────────────────────────────────────────
let ALL_CARDS = [];
let PRICE_HISTORY = {};  // card_id -> [{d: 'YYYY-MM-DD', p: 1.23}, ...]
let currentView = 'list';  // default to list view
let showOwnedOnly = false;
const STORAGE_KEY = 'pokemon-rarity-binder-owned';
let _priceChart = null;  // Chart.js instance

// ─── OWNED COLLECTION (persisted to localStorage) ────────────────────────────
function cardKey(c) {
  return `${c.set}||${c.num}||${c.name}`;
}
function getOwned() {
  try { return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); }
  catch(e) { return new Set(); }
}
function setOwned(owned) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...owned]));
}
function toggleOwned(c) {
  const owned = getOwned();
  const key = cardKey(c);
  if (owned.has(key)) owned.delete(key);
  else owned.add(key);
  setOwned(owned);
  // Sync to Firestore via event (module script listens for this)
  window.dispatchEvent(new CustomEvent('owned-changed', { detail: { owned } }));
  updateCollectionValue();
}
function isOwned(c) {
  return getOwned().has(cardKey(c));
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
  // Tag Team synthetic rarity — already rewritten in normalizeCard
  if (r === 'Tag Team') return isFull ? 'FA Tag Team' : 'Tag Team';
  // Rare Ultra: Full Art if beyond set total; otherwise defer to rareUltraBucket()
  // — the SAME classifier the rarity filter dropdown uses — so the pill shown
  // on a card always agrees with which filter bucket it falls into.
  if (r === 'Rare Ultra') {
    if (isFull) return 'Full Art';
    const bucket = rareUltraBucket({ name, subtypes, supertype });
    if (bucket === '__GX__') return 'GX';
    if (bucket === '__EX__') return 'EX';
    if (bucket === '__FA_POKEMON__') return 'Full Art';
    return 'FA Trainer';
  }
  // Rare Rainbow: Full Art if beyond set total
  if (r === 'Rare Rainbow') {
    if (isFull) return 'Full Art';
  }
  const map = {
    'MEGA_ATTACK_RARE':          'MAR',
    'Mega Attack Rare':          'MAR',
    'Hyper Rare':                'Hyper Rare',
    'Special Illustration Rare': 'SIR',
    'Shiny Ultra Rare':          'Shiny UR',
    'Rainbow Rare':              'Rainbow Rare',
    'Rare Rainbow':              'Rainbow Rare',
    'Galarian Gallery':          'GG',
    'Trainer Gallery Rare Holo': 'TG',
    'ACE SPEC Rare':             'ACE SPEC',
    'Classic Collection':        'Classic',
    'Rare Shiny GX':             'Shiny GX',
    'Rare Shiny':                'Shiny',
    'Shiny Rare':                'Shiny R',
    'Amazing Rare':              'Amazing Rare',
    'Radiant Rare':              'Radiant Rare',
    'Rare Secret':               'Secret Rare',
    'Secret Rare':               'Secret Rare',
    'Tag Team':                  'Tag Team GX',
    'Rare Ultra':                'EX/GX',
    'Illustration Rare':         'IR',
    'Double Rare':               'Double Rare',
    'Gold Star':                 '★',
    'Rare Shining':              'Shining',
    'LEGEND':                    'LEGEND',
    'LV.X':                      'LV.X',
    'Rare Prime':                'Prime',
    'Rare BREAK':                'BREAK',
    'Rare Holo Star':            'Holo ★',
    'Rare Holo':                 'Rare Holo',
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
  const price = raw.price || 'N/A';
  const prevPrice = raw.previous_price || raw['previous_price'] || 'N/A';
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
  if (name.includes('&') && (rarity === 'Rare Ultra' || rarity === 'Rare Rainbow')) {
    rarity = 'Tag Team';
  }
  // Synthetic "Galarian Gallery" rarity — Crown Zenith Galarian Gallery subset
  // The GG set uses several rarity strings; normalize them all to "Galarian Gallery"
  if (set === 'Crown Zenith Galarian Gallery') {
    rarity = 'Galarian Gallery';
  }
  // "Hyper Rare" in the API means SWSH Rainbow Rare (gold rainbow treatment).
  // Normalize to "Rainbow Rare" so it's distinct from SV's gold "Hyper Rare" cards.
  if (rarity === 'Hyper Rare') {
    rarity = 'Rainbow Rare';
  }
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

// Returns HTML badge string for price change, or ''
function priceChangeBadge(current, prev) {
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
  setView('list'); // default to list view on load
}

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
  'Tag Team':                 'Tag Team GX',
  'Rainbow Rare':             'Rainbow Rare',
  'Rare Rainbow':             'Rainbow Rare',
  'Galarian Gallery':         'Galarian Gallery',
  'Trainer Gallery Rare Holo':'Trainer Gallery',
  'ACE SPEC Rare':            'ACE SPEC Rare',
  'Classic Collection':       'Classic Collection',
  'Rare Shiny GX':            'Rare Shiny GX',
  'Amazing Rare':             'Amazing Rare',
  'Radiant Rare':             'Radiant Rare',
  'Double Rare':              'Double Rare',
  'Rare Secret':              'Secret Rare',
  'Rare Ultra':               'Full Art (ex / GX)',
  'Gold Star':                'Gold Star',
  'LEGEND':                   'Legend',
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

  const ULTRA_LABELS = {
    '__GX__':         'Full Art GX',
    '__EX__':         'Full Art EX',
    '__FA_POKEMON__': 'Full Art Pokémon',
    '__FA_TRAINER__': 'Full Art Trainer',
  };
  for (const bucket of ['__GX__', '__EX__', '__FA_POKEMON__', '__FA_TRAINER__']) {
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
  render();
}

// ─── FILTER + SORT ───────────────────────────────────────────────────────────
function getFiltered() {
  const q = document.getElementById('search').value.toLowerCase();
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
        if (tok === '__TG__') return TG_RARITY_STRINGS.has(c.rarity);
        if (tok === '__GX__' || tok === '__EX__' || tok === '__FA_POKEMON__' || tok === '__FA_TRAINER__') {
          return c.rarity === 'Rare Ultra' && rareUltraBucket(c) === tok;
        }
        return c.rarity === tok;
      });
      if (!matches) return false;
    }
    if (q) {
      const haystack = `${c.name} ${c.set} ${c.series} ${c.rarity}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  cards.sort((a, b) => {
    if (sort === 'date-asc') return (a.date || '').localeCompare(b.date || '');
    if (sort === 'date-desc') return (b.date || '').localeCompare(a.date || '');
    if (sort === 'price-desc') return priceVal(b.price) - priceVal(a.price);
    if (sort === 'price-asc') {
      const av = priceVal(a.price), bv = priceVal(b.price);
      if (av < 0 && bv < 0) return 0;
      if (av < 0) return 1;
      if (bv < 0) return -1;
      return av - bv;
    }
    if (sort === 'name-asc') return (a.name || '').localeCompare(b.name || '');
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
  'Double Rare',               // SV Pokémon ex
  // ── Sword & Shield era ───────────────────────────────────────────────────
  'Galarian Gallery',          // Crown Zenith GG (synthetic rarity)
  'Rare Holo VMAX',            // TG VMAX sub-tier
  'Rare Holo VSTAR',           // TG VSTAR sub-tier
  'Rare Holo V',               // TG V sub-tier
  'Trainer Gallery Rare Holo', // TG base holo sub-tier
  'Rainbow Rare',              // SWSH Rainbow Rare
  'Rare Rainbow',              // SM Rainbow Rare
  'Rare Shiny GX',             // Shiny Vault GX (Hidden/Shining Fates)
  'Rare Shiny',                // Shiny Vault base (Hidden/Shining Fates)
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
        renderGrid(cards, el);
      }
    }
    return;
  }
  // Trend view takes priority over set detail / overview
  if (_trendMode) { _lastRenderedSet = null; renderTrend(el); return; }
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
    }
  }
  _lastRenderedSet = null;
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
      const logoHtml = firstCard.setLogo && firstCard.setLogo !== 'N/A'
        ? `<img class="set-ov-logo" src="${firstCard.setLogo}" alt="" onerror="this.style.display='none'">`
        : '';
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
      html += `<div class="set-ov-card" onclick="openSetDetail('${eraEnc}','${setEnc}')">
        <div class="set-ov-top">
          <div class="set-ov-left">
            ${symbolHtml}
            ${logoHtml}
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
    <div class="set-detail-info">
      <div class="set-detail-era">${era} · ${setYear}</div>
      <div class="set-detail-name">${set}</div>
    </div>
  </div>`;

  const BUCKET_LABEL = { '__TG__':'TG', '__GX__':'GX', '__EX__':'EX', '__FA_POKEMON__':'Full Art', '__FA_TRAINER__':'FA Trainer' };
  const BUCKET_COLOR_KEY = { '__TG__':'Trainer Gallery Rare Holo', '__GX__':'Rare Ultra', '__EX__':'Rare Ultra', '__FA_POKEMON__':'Rare Ultra', '__FA_TRAINER__':'Rare Ultra' };

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
        </div>
      </div>`;
    }
    html += `</div></div>`; // detail-card-grid + rarity-group
  }
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
            <div class="tile-price-row"><span class="tile-price">${c.price!=='N/A'?c.price:'—'}</span>${changeBadge}</div>
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
  toggleOwned(c);
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
}

// ─── VIEW SWITCH (no-op — kept for filter drawer mobile sync compat) ─────────

// ─── MODAL ───────────────────────────────────────────────────────────────────
let _modalCard = null;
let _modalList = [];   // current filtered card list for prev/next navigation
let _modalIdx  = -1;   // index of open card within _modalList

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
  if (updateList) {
    _modalList = getFiltered();
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
  if (cv >= 0 && pv >= 0 && pv > 0) {
    const delta = cv - pv;
    const pct = (delta / pv * 100).toFixed(1);
    const sign = delta >= 0 ? '+' : '';
    const cls = delta >= 0 ? 'price-up' : 'price-down';
    const arrow = delta >= 0 ? '↑' : '↓';
    priceHtml += ` <span class="price-change ${cls}" style="font-size:13px;">${arrow} ${sign}${pct}%</span>`;
  }
  const staleBadge = stalePriceBadge(c);
  if (staleBadge) priceHtml += ' ' + staleBadge;
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

  // Update own button state
  const ownBtn = document.getElementById('mOwn');
  const owned = isOwned(c);
  ownBtn.textContent = owned ? 'Owned' : '＋ Mark as Owned';
  ownBtn.classList.toggle('owned', owned);

  // Render price history chart
  renderPriceChart(c.cardId || '');

  document.getElementById('modalBackdrop').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function toggleFromModal() {
  if (!_modalCard) return;
  handleToggle(_modalCard);
  const owned = isOwned(_modalCard);
  const ownBtn = document.getElementById('mOwn');
  ownBtn.textContent = owned ? 'Owned' : '＋ Mark as Owned';
  ownBtn.classList.toggle('owned', owned);
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
['eraFilter','rarityFilter','sortBy'].forEach(id =>
  document.getElementById(id).addEventListener('change', render)
);

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
    render();
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
