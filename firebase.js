import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, updateDoc, getDoc, onSnapshot, deleteField }
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
  // collection — and show the read-only banner (wrapped with the version tag
  // in #readOnlyRow — see POKEMON_RARITY_BINDER.html and applyReadOnlyShareUI
  // in rarity-binder.js, which fills in #appVersionReadOnly's text).
  const authBtn = document.getElementById('authBtn');
  const shareBtn = document.getElementById('shareBtn');
  const readOnlyRow = document.getElementById('readOnlyRow');
  if (authBtn) authBtn.style.display = 'none';
  if (shareBtn) shareBtn.style.display = 'none';
  if (readOnlyRow) readOnlyRow.style.display = '';

  // Hides the header button row / Now button in read-only view. Lives in
  // rarity-binder.js (applyReadOnlyShareUI) since it also has to coordinate
  // with loadCards()'s default grid+owned view — that script may not have
  // run yet, so retry briefly rather than silently no-op-ing.
  const tryApplyReadOnlyUI = () => {
    if (typeof window.applyReadOnlyShareUI === 'function') window.applyReadOnlyShareUI();
    else setTimeout(tryApplyReadOnlyUI, 50);
  };
  tryApplyReadOnlyUI();

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
  // BUG FIX (2026-07-29): this used to always UNION local + remote data on
  // every load ("owned on either side stays owned") — which has no way to
  // represent a removal, so un-owning a card and refreshing would bring it
  // right back (whichever side still had it would win, forever). Firestore
  // is now treated as the single source of truth once it exists: on load,
  // local storage is simply replaced with whatever Firestore says, full
  // stop — no merging. The ONE exception is a brand-new user who has never
  // synced before (no Firestore doc exists yet) but already has local-only
  // data from using the app before signing in — that data would otherwise
  // be silently lost, so in that specific case we push it up instead of
  // discarding it. After that first sync, Firestore is authoritative.
  try {
    console.log('[Firebase] mergeFirestoreToLocal start, uid=', uid);
    const snap = await getDoc(ownedDocRef(uid));
    console.log('[Firebase] snap.exists=', snap.exists());
    if (snap.exists()) {
      const data = snap.data();
      const remote = toPlainObject(data.owned ?? data.keys ?? []);
      localStorage.setItem('pokemon-rarity-binder-owned', JSON.stringify(remote));
      console.log('[Firebase] replaced local with remote, count=', Object.keys(remote).length);
    } else {
      const local = toPlainObject(JSON.parse(localStorage.getItem('pokemon-rarity-binder-owned') || '{}'));
      if (Object.keys(local).length > 0) {
        console.log('[Firebase] No Firestore doc yet — first sync, uploading existing local data, count=', Object.keys(local).length);
        await setDoc(ownedDocRef(uid), { owned: local }, { merge: true });
      } else {
        console.log('[Firebase] No Firestore doc found for this user, and no local data to upload');
      }
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

// BUG FIX (2026-07-30): writes ONLY the single card's field that changed,
// using dot-notation ("owned.<key>") so Firestore merges it into the nested
// map without touching any other key, and deleteField() to remove a key
// cleanly. This replaces the old approach of re-sending the ENTIRE owned
// object on every toggle.
//
// Root cause of "un-owned card reappears after refresh": with a full-object
// write, ANY client that still had a stale in-memory copy of `owned` (e.g. a
// backgrounded tab, or a second device like a phone left open) would, upon
// firing its own write for an unrelated reason, silently resurrect every
// card it still thought was owned — because its stale full snapshot
// overwrote the entire field, including the removal you just made elsewhere.
// The app's own success logs looked correct because THAT write really did
// succeed and really did contain the right (shrinking) data; a DIFFERENT,
// later write from a stale client is what clobbered it afterward, and that
// second write never appeared in the tab you were watching.
//
// Per-key delta writes make every write commutative and order-independent:
// no client can ever undo another client's change to a different key, and
// even a very stale client re-sending an old ADD for a key you removed
// elsewhere only affects that one key (still not perfect for true
// last-write-wins conflicts on the SAME key from two clients, but that's a
// far narrower, far rarer race than "any write from any stale tab wipes
// everything").
async function pushOwnedDelta(key, action, meta) {
  console.log('[Firebase] pushOwnedDelta called, uid=', _currentUid, 'key=', key, 'action=', action);
  if (!_currentUid) {
    console.warn('[Firebase] pushOwnedDelta: no _currentUid, write SKIPPED.');
    return;
  }
  const fieldPath = 'owned.' + key;
  const value = action === 'remove' ? deleteField() : meta;
  try {
    // BUG FIX (2026-07-30 v2): use updateDoc, not setDoc(...,{merge:true}).
    // deleteField() + a dynamic dot-notation key is the OFFICIALLY documented
    // pattern for updateDoc (Firebase's own docs only ever show deleteField()
    // paired with updateDoc — never setDoc/merge). setDoc with merge:true and
    // a computed 'owned.<key>' key is NOT documented anywhere and evidently
    // does not reliably delete the nested field in practice (confirmed: the
    // write resolved with no error, yet the field was still present on the
    // very next read) — likely because merge:true's own field-mask semantics
    // don't compose the way a literal dot-path assumes. updateDoc guarantees
    // correct nested dot-path semantics, including deleteField().
    // updateDoc fails on a doc that doesn't exist, so fall back to creating
    // it first (first-ever write for a brand-new user).
    try {
      await updateDoc(ownedDocRef(_currentUid), { [fieldPath]: value });
    } catch (inner) {
      // Doc doesn't exist yet — only meaningful for an ADD (a REMOVE on a
      // nonexistent doc is a no-op, there's nothing to delete).
      if (inner.code === 'not-found' && action !== 'remove') {
        await setDoc(ownedDocRef(_currentUid), { owned: { [key]: meta } }, { merge: true });
      } else if (inner.code !== 'not-found') {
        throw inner;
      }
    }
    console.log('[Firebase] delta write to ownedDocRef succeeded');
    // Keep the public share doc (if one exists) live too.
    if (_currentShareId) {
      try {
        await updateDoc(shareDocRef(_currentShareId), { ownerUid: _currentUid, [fieldPath]: value });
      } catch (inner) {
        if (inner.code === 'not-found' && action !== 'remove') {
          await setDoc(shareDocRef(_currentShareId), { ownerUid: _currentUid, owned: { [key]: meta } }, { merge: true });
        } else if (inner.code !== 'not-found') {
          throw inner;
        }
      }
      console.log('[Firebase] delta write to shareDocRef succeeded');
    }
    // VERIFY (2026-07-30): force a fresh server read right after the write so
    // the console tells us definitively whether the change actually landed,
    // instead of inferring it from the write call resolving without error.
    const verifySnap = await getDoc(ownedDocRef(_currentUid));
    const verifyOwned = verifySnap.exists() ? (verifySnap.data().owned || {}) : {};
    console.log('[Firebase] VERIFY after write — key still present?', Object.prototype.hasOwnProperty.call(verifyOwned, key), '| total keys=', Object.keys(verifyOwned).length);
  } catch(e) { console.warn('[Firebase] delta write FAILED', e); }
}

// ── Listen for owned-changed events from the main script ────────────────────
window.addEventListener('owned-changed', e => {
  const { key, action, meta } = e.detail;
  if (key && action) {
    pushOwnedDelta(key, action, meta);
  }
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
