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

// ── Auth state ──────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async user => {
  _currentUid = user ? user.uid : null;
  updateAuthUI(user);
  if (user) {
    // Pull Firestore data, merge with localStorage, start live listener
    await mergeFirestoreToLocal(user.uid);
    startFirestoreListener(user.uid);
  } else {
    if (_firestoreUnsub) { _firestoreUnsub(); _firestoreUnsub = null; }
  }
  // Re-render so owned badges reflect current state
  if (typeof updateCollectionValue === 'function') updateCollectionValue();
  if (typeof render === 'function') render();
});

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

async function mergeFirestoreToLocal(uid) {
  try {
    console.log('[Firebase] mergeFirestoreToLocal start, uid=', uid);
    const snap = await getDoc(ownedDocRef(uid));
    console.log('[Firebase] snap.exists=', snap.exists());
    if (snap.exists()) {
      const remote = snap.data().keys || [];
      console.log('[Firebase] remote keys count=', remote.length);
      const local = JSON.parse(localStorage.getItem('pokemon-rarity-binder-owned') || '[]');
      const merged = [...new Set([...local, ...remote])];
      localStorage.setItem('pokemon-rarity-binder-owned', JSON.stringify(merged));
      console.log('[Firebase] merged count=', merged.length);
    } else {
      console.log('[Firebase] No Firestore doc found for this user');
    }
  } catch(e) { console.warn('[Firebase] merge failed', e); }
}

function startFirestoreListener(uid) {
  if (_firestoreUnsub) _firestoreUnsub();
  _firestoreUnsub = onSnapshot(ownedDocRef(uid), snap => {
    if (!snap.exists()) return;
    const remote = snap.data().keys || [];
    localStorage.setItem('pokemon-rarity-binder-owned', JSON.stringify(remote));
    // Only update UI if cards are already loaded — loadCards() will pick up
    // the correct localStorage state on its own if it runs after this
    if (typeof updateCollectionValue === 'function') updateCollectionValue();
    // Don't call render() here — it may run before ALL_CARDS is populated
    // and wipe the visible list. The owned badges update via isOwned() on next render.
  });
}

async function pushOwnedToFirestore(ownedSet) {
  if (!_currentUid) return;
  try {
    await setDoc(ownedDocRef(_currentUid), { keys: [...ownedSet] });
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
