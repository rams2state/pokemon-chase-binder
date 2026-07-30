import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, onSnapshot }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const firebaseConfig = {
  apiKey: "AIzaSyDH73IiryicsIWJ56KUa9RLvNozQKg5wfA",
  authDomain: "pokemon-rarity-binder.firebaseapp.com",
  projectId: "pokemon-rarity-binder",
  storageBucket: "pokemon-rarity-binder.firebasestorage.app",
  messagingSenderId: "491998939309",
  appId: "1:491998939309:web:0d1f4bf43694cd29dd1e24"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let _firestoreUnsub = null;
let _currentUid = null;
let _currentShareId = null;

// Read directly from the URL rather than relying on rarity-binder.js globals —
// this module script's execution order relative to that plain <script> tag
// isn't guaranteed, so SHARE_ID must not depend on it having run first.
const _shareIdParam = new URLSearchParams(window.location.search).get('share');

// ── Auth state ──────────────────────────────────────────────────────────────
if (_shareIdParam) {
  // Viewing someone else's shared collection: skip auth entirely, no sign-in
  // possible/relevant, just load their public share doc read-only and keep
  // it live.
  initReadOnlyShareView(_shareIdParam);
} else {
  onAuthStateChanged(auth, async user => {
    _currentUid = user ? user.uid : null;
    updateAuthUI(user);
    if (user) {
      // Pull Firestore data, merge with localStorage, start live listener
      await mergeFirestoreToLocal(user.uid);
      startFirestoreListener(user.uid);
      await loadExistingShareId(user.uid);
    } else {
      if (_firestoreUnsub) { _firestoreUnsub(); _firestoreUnsub = null; }
      _currentShareId = null;
      updateShareBtnVisibility();
    }
    // Re-render so owned badges reflect current state
    if (typeof updateCollectionValue === 'function') updateCollectionValue();
    if (typeof render === 'function') render();
  });
}

// ── Read-only shared-collection view ──────────────────────────────────────────
function initReadOnlyShareView(shareId) {
  // Hide auth/share controls — neither makes sense when viewing someone else's
  // collection — and show the read-only banner.
  const authBtn = document.getElementById('authBtn');
  const shareBtn = document.getElementById('shareBtn');
  const banner = document.getElementById('readOnlyBanner');
  if (authBtn) authBtn.style.display = 'none';
  if (shareBtn) shareBtn.style.display = 'none';
  if (banner) banner.style.display = '';

  const applySnapshot = snap => {
    // FEATURE (2026-07-29): "owned" data is now { [key]: {addedAt} } rather
    // than a plain array of keys (see cardKey/normalizeOwnedData in
    // rarity-binder.js) — pass whatever's in the doc's "owned" field through
    // as-is and let setSharedOwned()'s normalizeOwnedData() call handle
    // both the new object format and any older plain-array data.
    const raw = snap.exists() ? (snap.data().owned ?? snap.data().keys ?? []) : [];
    // setSharedOwned lives in rarity-binder.js. That script may not have run
    // yet (module scripts can execute before/after plain scripts), so retry
    // briefly rather than silently dropping the first snapshot.
    const tryApply = () => {
      if (typeof window.setSharedOwned === 'function') window.setSharedOwned(raw);
      else if (typeof setSharedOwned === 'function') setSharedOwned(raw);
      else { setTimeout(tryApply, 50); return; }
    };
    tryApply();
  };

  // Live listener — public read, no auth required (see Firestore rules).
  onSnapshot(shareDocRef(shareId), applySnapshot, e => {
    console.warn('[Firebase] Shared collection listener failed', e);
  });
}

function updateAuthUI(user) {
  const btn = document.getElementById('authBtn');
  if (!btn) return;
  if (user) {
    btn.textContent = '⬡ ' + (user.displayName ? user.displayName.split(' ')[0] : 'Signed in');
    btn.title = 'Click to sign out (' + user.email + ')';
    btn.classList.add('signed-in');
  } else {
    btn.textContent = '⬡ Sign in';
    btn.title = 'Sign in with Google to sync across devices';
    btn.classList.remove('signed-in');
  }
}

// ── Firestore read/write ────────────────────────────────────────────────────
function ownedDocRef(uid) {
  return doc(db, 'users', uid, 'data', 'owned');
}

// FEATURE (2026-07-29): owned data moved from a plain array of keys to
// { [key]: {addedAt} } (see cardKey/normalizeOwnedData/getOwned in
// rarity-binder.js). Firestore docs now store this under an "owned" field
// (object), while "keys" (array) is kept ONLY as a read fallback for any
// doc written before this change — new writes always use "owned".
function toPlainObject(raw) {
  // Accepts either the old array-of-keys format or the new object format
  // (as read back from Firestore, which is already a plain object/array —
  // no need for the Map machinery that lives in rarity-binder.js here).
  if (Array.isArray(raw)) {
    const now = Date.now();
    const obj = {};
    for (const key of raw) obj[key] = { addedAt: now };
    return obj;
  }
  return raw && typeof raw === 'object' ? raw : {};
}

async function mergeFirestoreToLocal(uid) {
  try {
    console.log('[Firebase] mergeFirestoreToLocal start, uid=', uid);
    const snap = await getDoc(ownedDocRef(uid));
    console.log('[Firebase] snap.exists=', snap.exists());
    if (snap.exists()) {
      const data = snap.data();
      const remote = toPlainObject(data.owned ?? data.keys ?? []);
      console.log('[Firebase] remote keys count=', Object.keys(remote).length);
      const local = toPlainObject(JSON.parse(localStorage.getItem('pokemon-rarity-binder-owned') || '{}'));
      // Merge: a card owned on either side stays owned. If both sides have
      // it, keep whichever addedAt is EARLIER (the more likely true
      // original add time — the other side's timestamp is just whenever
      // that device happened to last write/migrate the record).
      const merged = { ...remote };
      for (const [key, meta] of Object.entries(local)) {
        if (!merged[key] || (meta.addedAt && meta.addedAt < merged[key].addedAt)) {
          merged[key] = meta;
        }
      }
      localStorage.setItem('pokemon-rarity-binder-owned', JSON.stringify(merged));
      console.log('[Firebase] merged count=', Object.keys(merged).length);
    } else {
      console.log('[Firebase] No Firestore doc found for this user');
    }
  } catch(e) { console.warn('[Firebase] merge failed', e); }
}

function startFirestoreListener(uid) {
  if (_firestoreUnsub) _firestoreUnsub();
  _firestoreUnsub = onSnapshot(ownedDocRef(uid), snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    const remote = toPlainObject(data.owned ?? data.keys ?? []);
    localStorage.setItem('pokemon-rarity-binder-owned', JSON.stringify(remote));
    // Only update UI if cards are already loaded — loadCards() will pick up
    // the correct localStorage state on its own if it runs after this
    if (typeof updateCollectionValue === 'function') updateCollectionValue();
    // Don't call render() here — it may run before ALL_CARDS is populated
    // and wipe the visible list. The owned badges update via isOwned() on next render.
  });
}

async function pushOwnedToFirestore(ownedMap) {
  if (!_currentUid) return;
  try {
    // ownedMap is the Map from rarity-binder.js's getOwned()/toggleOwned() —
    // serialize to a plain { [key]: {addedAt} } object for Firestore.
    const owned = {};
    for (const [key, meta] of ownedMap) owned[key] = meta;
    // merge:true — this doc may also carry a shareId field (see _fbShare below),
    // and a plain setDoc would silently wipe that out on every owned-card toggle.
    await setDoc(ownedDocRef(_currentUid), { owned }, { merge: true });
    // Keep the public share doc (if one exists) live too, so the shared link
    // always reflects current ownership rather than a frozen snapshot.
    if (_currentShareId) {
      await setDoc(shareDocRef(_currentShareId), { ownerUid: _currentUid, owned });
    }
  } catch(e) { console.warn('Firebase write failed', e); }
}

// ── Listen for owned-changed events from the main script ────────────────────
window.addEventListener('owned-changed', e => {
  pushOwnedToFirestore(e.detail.owned);
});

// ── Auth button handler ─────────────────────────────────────────────────────
window._fbSignIn = async () => {
  if (_currentUid) {
    await signOut(auth);
  } else {
    try { await signInWithPopup(auth, provider); }
    catch(e) { console.warn('Sign-in failed', e); }
  }
};

// ── Share link ───────────────────────────────────────────────────────────────
function shareDocRef(shareId) {
  return doc(db, 'shares', shareId);
}

// Loads (but does not create) the current user's existing shareId, if any,
// so a repeat "Share" click reuses the same link instead of minting a new one.
async function loadExistingShareId(uid) {
  try {
    const snap = await getDoc(ownedDocRef(uid));
    _currentShareId = snap.exists() ? (snap.data().shareId || null) : null;
  } catch(e) { console.warn('[Firebase] loadExistingShareId failed', e); _currentShareId = null; }
  updateShareBtnVisibility();
}

function updateShareBtnVisibility() {
  const btn = document.getElementById('shareBtn');
  if (!btn) return;
  // '' rather than a hardcoded display value — the button is a flex child of
  // .header-btn-row now, so let CSS control its display when visible instead
  // of fighting the flex layout with an inline style.
  btn.style.display = _currentUid ? '' : 'none';
}

function shareUrlFor(shareId) {
  const url = new URL(window.location.href);
  url.search = ''; // drop any existing query params (e.g. a ?share= link you opened yourself)
  url.searchParams.set('share', shareId);
  return url.toString();
}

window._fbShare = async () => {
  if (!_currentUid) return;
  const btn = document.getElementById('shareBtn');
  try {
    if (!_currentShareId) {
      _currentShareId = crypto.randomUUID();
      // Save the new shareId onto the user's own doc (merge — don't clobber `owned`).
      await setDoc(ownedDocRef(_currentUid), { shareId: _currentShareId }, { merge: true });
    }
    // Ensure the public share doc exists / is current before copying the link.
    const owned = toPlainObject(JSON.parse(localStorage.getItem('pokemon-rarity-binder-owned') || '{}'));
    await setDoc(shareDocRef(_currentShareId), { ownerUid: _currentUid, owned });

    const url = shareUrlFor(_currentShareId);
    await navigator.clipboard.writeText(url);
    if (btn) {
      const original = btn.textContent;
      btn.textContent = '✓ Link copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 2000);
    }
  } catch(e) {
    console.warn('[Firebase] Share failed', e);
    if (btn) { btn.textContent = '⚠ Share failed'; setTimeout(() => { btn.textContent = '🔗 Share'; }, 2000); }
  }
};
