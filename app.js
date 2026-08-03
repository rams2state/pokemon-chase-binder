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
