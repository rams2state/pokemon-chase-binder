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
  // FEATURE (2026-08-02): the header-row version tag is hidden along with
  // the rest of headerBtnRow above, so a second copy lives next to the
  // read-only banner instead (#appVersionReadOnly, in #readOnlyRow).
  const versionReadOnly = document.getElementById('appVersionReadOnly');
  if (versionReadOnly) versionReadOnly.textContent = 'v' + APP_VERSION;
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
  // FEATURE (2026-08-13): default sort is now Oldest First (date-asc) — see
  // resetFilters() / the <option> order in POKEMON_RARITY_BINDER.html.
  return search || era || rarity || sort !== 'date-asc' || showOwnedOnly || !!_trendMode;
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
  // FEATURE (2026-08-13): default sort changed from Newest First to Oldest
  // First per Jordan's request — Reset must restore to the same default the
  // app now loads with (see the <option> order in POKEMON_RARITY_BINDER.html,
  // which is what actually determines the pre-JS default on first page load).
  document.getElementById('sortBy').value = 'date-asc';
  // Sync mobile
  ['eraFilterM','rarityFilterM','sortByM'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'sortByM' ? 'date-asc' : '';
  });
  // FEATURE (2026-08-02): read-only share view is permanently locked to the
  // owned-only grid — Reset must not turn either of those off (toggleOwnedFilter()
  // itself also guards against this, but skip the call entirely here too).
  if (showOwnedOnly && !READ_ONLY_SHARE) toggleOwnedFilter();
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
  // the empty "search to explore" placeholder. Read-only share view is the
  // one exception: it's permanently locked to grid (see loadCards()).
  if (currentView === 'grid' && !READ_ONLY_SHARE) applyViewState('list');
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
  // FEATURE (2026-08-08): Gainers/Losers now compares against the price from
  // 7 days ago (via getPriceNDaysAgo(), same PRICE_HISTORY lookup used by
  // priceChangeBadge() everywhere else in the app) instead of yesterday's
  // single "Previous Price" value — a one-day move isn't a meaningful trend,
  // and this keeps every price-change display in the app using the same
  // window.
  const withChange = ALL_CARDS
    .map(c => {
      const cv = priceVal(c.price), pv = getPriceNDaysAgo(c.cardId, 7);
      return { ...c, _pv7: pv, _cv: cv };
    })
    .filter(c => c._cv > 0 && c._pv7 !== null && c._pv7 > 0 && Math.max(c._cv, c._pv7) >= MIN_PRICE)
    .map(c => {
      const delta = c._cv - c._pv7;
      const pct = (delta / c._pv7) * 100;
      return { ...c, _delta: delta, _pct: pct, _pv: c._pv7 };
    });

  if (withChange.length === 0) {
    el.innerHTML = `<div class="empty"><div class="display">No price changes yet</div><p>Run the collector daily for at least 7 days to see price movement.</p></div>`;
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
    el.innerHTML = `<div class="empty"><div class="display">${_trendMode === 'gainers' ? 'No gainers yet' : 'No losers yet'}</div><p>Run the collector daily for at least 7 days to see price movement.</p></div>`;
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
    const badge = `<span class="price-change ${cls}"><span class="price-change-period">7D</span> ${arrow} ${sign}$${Math.abs(c._delta).toFixed(2)} (${sign}${c._pct.toFixed(1)}%)</span>`;
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
        <span class="crow-price">${c.price!=='N/A'?c.price:'—'}</span>${staleWarningIcon(c)}${priceVolatileIcon(c)}
        <div style="font-size:10px;color:var(--dim);text-align:right;">was $${c._pv.toFixed(2)} (7d ago)</div>
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
        <span class="crow-price">${c.price!=='N/A'?c.price:'—'}</span>${staleWarningIcon(c)}${priceVolatileIcon(c)}
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
  // English sets that now have a real Japanese tile grouped under them —
  // their old decorative JP badge is suppressed in favor of the new tile
  // (see jpSymbolsFor()/jpTileFor() in data.js).
  const jpSuppressed = englishSetsWithJpTile(cards);
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

      // BUG FIX (2026-08-22): "cant open some sets ... Leader's Stadium,
      // Pt1: Galactic". Root cause: encodeURIComponent() deliberately
      // leaves apostrophes (') un-escaped per the JS spec (it's one of the
      // "always safe" characters), but the result is embedded here inside a
      // SINGLE-quoted onclick="openSetDetail('...','...')" JS string
      // literal — any set name with a real apostrophe (Leaders' Stadium,
      // Pt1: Galactic's Conquest, both genuine Japanese set names) breaks
      // the string right at the apostrophe, leaving the rest as invalid
      // trailing JS tokens: SyntaxError: Invalid or unexpected token —
      // exactly what showed up in the console. Pre-existing bug, not
      // introduced this session — just newly exposed because these two
      // Japanese sets (real apostrophes in their names) are recent
      // additions. Fixed by also percent-encoding any apostrophe left
      // behind; decodeURIComponent() in openSetDetail() below still
      // correctly reconstructs the original string from %27, so nothing
      // downstream needs to change.
      const eraEnc = encodeURIComponent(era).replace(/'/g, '%27'),
            setEnc = encodeURIComponent(set).replace(/'/g, '%27');
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
      // Suppressed when a real Japanese tile now exists for this English set
      // (jpSuppressed) — the badge moves to live on that tile instead (below).
      const jpSymbols = jpSymbolsFor(set, jpSuppressed);
      const jpLogoHtml = jpSymbols
        ? `<span class="jp-ov-logo-wrap">${jpSymbols.map(jp => `<img class="jp-ov-logo" src="${jp.symbol}" alt="${jp.name}" title="${jp.name}" loading="lazy" onerror="this.style.display='none'">`).join('')}</span>`
        : '';
      // If THIS tile is itself a real Japanese-card tile, show its own
      // single confirmed JP symbol here — the specific one for this exact
      // Japanese product, not the full array of JP alternatives.
      const ownJpTile = jpTileFor(set);
      const ownJpLogoHtml = ownJpTile
        ? `<span class="jp-ov-logo-wrap"><img class="jp-ov-logo" src="${ownJpTile.symbol}" alt="${ownJpTile.name}" title="${ownJpTile.name}" loading="lazy" onerror="this.style.display='none'"></span>`
        : '';
      html += `<div class="set-ov-card" onclick="openSetDetail('${eraEnc}','${setEnc}')">
        <div class="set-ov-top">
          <div class="set-ov-left">
            ${symbolHtml}
            ${jpLogoHtml}
            ${ownJpLogoHtml}
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
  // Suppressed here too when a real Japanese tile now exists for this
  // English set (see renderSetOverview's jpSuppressed for the same logic).
  const jpSuppressedDetail = englishSetsWithJpTile(cards);
  const jpSymbolsDetail = jpSymbolsFor(set, jpSuppressedDetail);
  const jpBadgesDetailHtml = jpSymbolsDetail
    ? `<span class="jp-badges">${jpSymbolsDetail.map(jp => `<img class="jp-symbol-mini" src="${jp.symbol}" alt="${jp.name}" title="${jp.name}" loading="lazy" onerror="this.style.display='none'">`).join('')}</span>`
    : '';
  // If this set IS a real Japanese tile, show its own single confirmed
  // symbol here instead (same pattern as renderSetOverview's ownJpLogoHtml).
  const ownJpTileDetail = jpTileFor(set);
  const ownJpBadgeDetailHtml = ownJpTileDetail
    ? `<span class="jp-badges"><img class="jp-symbol-mini" src="${ownJpTileDetail.symbol}" alt="${ownJpTileDetail.name}" title="${ownJpTileDetail.name}" loading="lazy" onerror="this.style.display='none'"></span>`
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
    ${ownJpBadgeDetailHtml}
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
      const changeBadge = priceChangeBadge(c.price, c.cardId);
      const thumbHtml = c.pic && c.pic !== 'N/A'
        ? `<img class="crow-thumb" src="${c.pic}" alt="${c.name||''}" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="crow-thumb-empty">?</div>`;
      html += `<div class="card-row${owned?' owned':''}" id="row-${key}" onclick='openModal(${cdata})'>
        <div class="crow-check${owned?' owned':''}" onclick='event.stopPropagation();handleToggle(${cdata})'>${owned?'✓':''}</div>
        ${thumbHtml}
        <span class="crow-num">#${c.num||'—'}</span>
        <span class="crow-name">${c.name||'—'}</span>
        <div class="crow-price-wrap">
          <span class="crow-price">${c.price!=='N/A'?c.price:'—'}</span>${staleWarningIcon(c)}${priceVolatileIcon(c)}${changeBadge}
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
          <div class="tile-price-row"><span class="tile-price">${c.price!=='N/A'?c.price:'—'}</span>${priceVolatileIcon(c)}${seventyPercentBadgeHtml(c)}${changeBadge}</div>
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
      const changeBadge = priceChangeBadge(c.price, c.cardId);
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
            <div class="tile-price-row"><span class="tile-price">${c.price!=='N/A'?c.price:'—'}</span>${staleWarningIcon(c)}${priceVolatileIcon(c)}${seventyPercentBadgeHtml(c)}${changeBadge}</div>
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
