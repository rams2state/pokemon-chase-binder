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
  const cv = priceVal(c.price);
  let priceHtml = c.price && c.price !== 'N/A' ? c.price : 'Price N/A';
  // FEATURE (2026-08-08): now compares against the price from 7 days ago
  // (via PRICE_HISTORY, see getPriceNDaysAgo() in rarity.js) instead of
  // yesterday's "Previous Price" — same 7-day window used everywhere else in
  // the app (list rows, grid tiles). FEATURE (2026-08-02): still hidden
  // entirely in read-only share view.
  const pv7 = getPriceNDaysAgo(c.cardId, 7);
  if (!READ_ONLY_SHARE && cv >= 0 && pv7 !== null && pv7 > 0) {
    const delta = cv - pv7;
    const pct = (delta / pv7 * 100).toFixed(1);
    const sign = delta >= 0 ? '+' : '';
    const cls = delta >= 0 ? 'price-up' : 'price-down';
    const arrow = delta >= 0 ? '↑' : '↓';
    priceHtml += ` <span class="price-change ${cls}" style="font-size:13px;"><span class="price-change-period">7D</span> ${arrow} ${sign}${pct}%</span>`;
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

  // FEATURE (2026-08-12): condition-tiered pricing (NM/LP/MP/HP/DMG), modal
  // only — see conditionPrices()/CONDITION_TIERS in rarity.js for the
  // formula and reasoning. Hidden in read-only share view, same as the 70%
  // guidance and Paid price above — not useful or appropriate to show a
  // visitor browsing someone else's collection.
  //
  // FEATURE (2026-08-13): now shows BOTH the real market price AND the 70%
  // vendor-offer price per condition, stacked in one cell — previously only
  // the 70% number was shown. Jordan (buying as a vendor, planning to flip
  // at real value) needs the real number visible without having to reverse
  // the 70% math in his head at the table. Market price is the larger/
  // primary figure since that's the number with real-world resale meaning;
  // the 70% offer price sits underneath as the smaller secondary figure.
  const condEl = document.getElementById('mConditionPrices');
  if (condEl) {
    if (!READ_ONLY_SHARE) {
      const tiers = conditionPrices(c);
      if (tiers) {
        // FEATURE (2026-08-13, revised same day): source is now PER CELL,
        // not one banner for the whole row — a triggered card can
        // legitimately be mixed-source (e.g. NM/LP from eBay, MP/HP/DMG
        // from JustTCG, if eBay came back too thin for the latter three).
        // A small colored dot + tooltip on each cell shows its actual
        // source instead of one row-wide claim that would be wrong for a
        // mixed row. 'formula' (fallback estimate, no real data at all)
        // still gets the row-wide banner below since in that case EVERY
        // cell is the same estimate, not a per-cell mix.
        const allFormula = tiers.every(t => t.source === 'formula');
        const sourceNote = allFormula
          ? '<div class="cond-source cond-source--estimate">Estimated (% of market)</div>'
          : '';
        // REDESIGN (2026-08-18): eBay's number is an ACTIVE-listing
        // asking-price floor (cheapest 3 current Buy-It-Now listings,
        // averaged), not a sold-listing average — the tooltip is worded to
        // reflect that ("active listings", not "sold listings"). See
        // ebay_pricing.py's module docstring for why the earlier
        // sold-listing design never actually worked against this app's API
        // access.
        condEl.innerHTML = sourceNote + tiers.map(t => {
          const dotClass = t.source === 'ebay' ? 'cond-dot--ebay'
            : t.source === 'justtcg' ? 'cond-dot--justtcg' : '';
          const dotTitle = t.source === 'ebay' ? 'eBay (lowest active listings)'
            : t.source === 'justtcg' ? 'JustTCG' : '';
          const dot = dotClass ? `<span class="cond-dot ${dotClass}" title="${dotTitle}"></span>` : '';
          return `
            <div class="cond-row">
              <span class="cond-key" title="${t.label}">${t.key}${dot}</span>
              <span class="cond-val" title="Market price">$${t.marketValue.toFixed(2)}</span>
              <span class="cond-val-70" title="70% (vendor offer price)">70%: $${t.value.toFixed(2)}</span>
            </div>
          `;
        }).join('');
        condEl.style.display = '';
      } else {
        condEl.innerHTML = '';
        condEl.style.display = 'none';
      }
    } else {
      condEl.innerHTML = '';
      condEl.style.display = 'none';
    }
  }

  // FEATURE (2026-08-13): eBay verification fields — eBay NM (renamed from
  // Verified eBay Price; raw/ungraded, only populated when the price-gap
  // variance trigger fired AND eBay's own NM search cleared 3+ active
  // listings — same NM figure already shown in the condition grid above
  // when sourceNM is 'ebay') and TAG Slab Price (TAG-10 only, fully
  // automatic for every card via an alternating-THIRDS schedule — changed
  // from halves 2026-08-13, no allowlist; may be blank on a given day
  // simply because this card's third didn't run today, or because TAG-10
  // active listings are genuinely thin for that card). See
  // ebay_daily_runner.py for the pacing logic. Both shown ALONGSIDE the
  // TCGplayer price above, never replacing it — a gap between the numbers
  // is the useful signal. Hidden in read-only share view, same as
  // condition prices/70% guidance/Paid price.
  //
  // REDESIGN (2026-08-18): both values are the average of the 3 CHEAPEST
  // currently-ACTIVE Buy-It-Now listings — an asking-price floor, i.e.
  // "what would this cost me on eBay right now" — NOT an average of recent
  // sold listings. eBay's Browse API (the only Buy API this app's
  // Production keyset has access to) can only search active listings, not
  // sold/historical ones; see ebay_pricing.py's module docstring for the
  // full story of why the original sold-listing design never actually
  // worked in production. Labels below say "active listings" and "asking",
  // never "sold", to keep this distinction clear to Jordan when reading
  // these numbers for a real buy/flip decision.
  const ebayEl = document.getElementById('mEbayPrices');
  if (ebayEl) {
    if (!READ_ONLY_SHARE && (c.ebayNM || c.tagSlabPrice)) {
      let rows = '';
      if (c.ebayNM) {
        rows += `<div class="ebay-row">
          <span class="ebay-label" title="Average of the 3 cheapest currently-active raw Near Mint Buy It Now listings on eBay — an asking-price floor, not a sold price — triggered because TCGplayer's active inventory looked thin">eBay NM (ask)</span>
          <span class="ebay-val">${c.ebayNM}</span>
        </div>`;
      }
      if (c.tagSlabPrice) {
        rows += `<div class="ebay-row">
          <span class="ebay-label" title="Average of the 3 cheapest currently-active TAG 10-graded (Technical Authentication Guaranty) Buy It Now listings on eBay — an asking-price floor, not a sold price">TAG Slab (ask)</span>
          <span class="ebay-val ebay-val--slab">${c.tagSlabPrice}</span>
        </div>`;
      }
      ebayEl.innerHTML = rows;
      ebayEl.style.display = '';
    } else {
      ebayEl.innerHTML = '';
      ebayEl.style.display = 'none';
    }
  }

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

  // BUG FIX (2026-08-08): Chart.js's default auto-scaling picks "nice round"
  // tick steps (e.g. $1 increments) based on the overall axis range it
  // decides to show, not the actual min/max of the data — so a card that
  // holds flat at $121 for weeks then dips to $120.50 got stretched across
  // gridlines spanning a much wider band than the real price ever moved,
  // making a totally ordinary $0.50-$1 move look like a cliff-edge crash.
  // Fix: explicitly bound the y-axis to the REAL min/max of this card's own
  // price history, with a small padding so points don't sit flush against
  // the top/bottom edge. A flat/near-flat line (min === max, or a razor-thin
  // range) gets a minimum $1 window so the axis doesn't collapse to zero
  // height and the line doesn't look artificially jumpy from sub-cent noise.
  const dataMin = Math.min(...prices);
  const dataMax = Math.max(...prices);
  const dataRange = dataMax - dataMin;
  // Pad by 10% of the range on each side, but never less than $0.50 total
  // padding so a genuinely flat price still renders with visible headroom.
  const pad = Math.max(dataRange * 0.1, 0.5);
  let yMin = dataMin - pad;
  let yMax = dataMax + pad;
  // Guard against a razor-thin or perfectly flat range collapsing the axis —
  // enforce at least a $1 total window so gridlines/labels stay legible.
  if (yMax - yMin < 1) {
    const mid = (yMax + yMin) / 2;
    yMin = mid - 0.5;
    yMax = mid + 0.5;
  }
  // Prices are never negative — don't let padding push the floor below $0.
  yMin = Math.max(yMin, 0);

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
          // BUG FIX (2026-08-08): explicit min/max tied to this card's real
          // price range (computed above) instead of Chart.js's auto-scaled
          // "nice round number" default — see comment above for the full
          // reasoning (a $0.50 move was rendering as a visual cliff).
          min: yMin,
          max: yMax,
          // BUG FIX (2026-08-12): without a tick cap, Chart.js fills a
          // narrow min/max window (e.g. the $1 fallback window for a
          // perfectly flat price) with as many "nice" sub-ticks as fit —
          // for a $1 range that's 10-cent steps, printing 11 near-identical
          // gridlines like $9999.50, $9999.60, $9999.70... for a card that
          // never actually moved. Capped to match the x-axis's own
          // maxTicksLimit:6 so a flat/near-flat card shows a small, readable
          // handful of labels instead of a wall of clutter.
          ticks: {
            color: '#8b8fa3',
            font: { size: 9 },
            maxTicksLimit: 6,
            // Show cents only when the axis window is narrow AND there are
            // few enough ticks that each one needs sub-dollar precision to
            // stay distinguishable from its neighbors — otherwise a $1
            // window with only ~4 ticks (after the cap above) would still
            // show identical whole-dollar labels. Rounds to whichever
            // precision keeps adjacent tick labels visually distinct without
            // over-specifying cents on a card that moved by whole dollars.
            callback: v => (yMax - yMin) < 10 ? '$' + v.toFixed(2) : '$' + v.toFixed(0),
          },
          grid: { color: '#2b2f3d' },
        }
      }
    }
  });
}
