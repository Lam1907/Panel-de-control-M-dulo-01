/**
 * =========================================================================
 * CONTROL PANEL — Danzad Malditos
 * control-panel.js
 *
 * CORRECCIONES APLICADAS vs version anterior:
 *   [BUG1] Firebase version 12.13.0 NO EXISTE -> corregido a 10.12.2
 *   [BUG2] textContent con HTML entities -> corregido a innerHTML donde aplica
 *   [BUG3] ensureDefaults sin try/catch propio -> ahora tiene su propio guard
 *   [BUG4] class names actualizados para coincidir con nuevo CSS
 *
 * Rutas Firebase (sync con modulo Vote):
 *   /state          — flags globales
 *   /participants   — datos de los 10 participantes
 *   /votaciones     — votos (escribe Vote)
 *   /results/pairs  — parejas consolidadas
 *   /history        — historial de rondas
 *
 * Reglas:
 *   - NUNCA set() sobre /state — siempre update()
 *   - Listeners unicos (guardados en _unsubs)
 *   - Un solo reset: fullResetState()
 *   - Render post-votacion solo cuando participants + results esten cargados
 *   - Nombres e imagenes siempre desde state.participants
 * =========================================================================
 */

/* =========================================================================
   [BUG1 FIXED] — Firebase 10.12.2 (version real, verificada en CDN)
   La version 12.13.0 NO existe en gstatic.com y causaba fallo silencioso
   de todo el modulo al no poder importar.
========================================================================= */
import { initializeApp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, set, update, remove, onValue, get }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

const firebaseConfig = {
  apiKey:            'AIzaSyCxd2sdNJZaQ0Rq_mF6Sn1wLQra4Eabp1U',
  authDomain:        'danzad-maldit0s.firebaseapp.com',
  databaseURL:       'https://danzad-maldit0s-default-rtdb.firebaseio.com',
  projectId:         'danzad-maldit0s',
  storageBucket:     'danzad-maldit0s.firebasestorage.app',
  messagingSenderId: '774607843671',
  appId:             '1:774607843671:web:ec64876ba81b6b50acce12',
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

/* =========================================================================
   CONSTANTES
========================================================================= */
const ADMIN_PASSWORD     = 'DanzadMalditos26';
const TOTAL_PARTICIPANTS = 10;
const TOTAL_PAIRS        = 5;

/* =========================================================================
   ESTADO LOCAL
========================================================================= */
let state = {
  fb: {
    votingOpen:   false,
    votingEnded:  false,
    waitingRoom:  true,
    currentRound: 1,
    timerEnd:     0,
  },
  participants: {},
  // "parejas" es la ruta real que escribe el modulo Vote
  // /parejas/pareja_X/participantes: [{id, nombre}, ...]
  // /parejas/pareja_X/votos/{combo}: count
  parejas:      {},
  pairs:        {},
  ready: {
    state:        false,
    participants: false,
    parejas:      false,
    results:      false,
  },
};

/* =========================================================================
   VARIABLES DE CONTROL
========================================================================= */
let timerInterval     = null;
let timerGuard        = false;
let pendingImgSlot    = null;
let pendingSwap       = null;

// Unsubscribers Firebase — garantizan un solo listener por ruta
const _unsubs = {
  connected:    null,
  state:        null,
  participants: null,
  parejas:      null,
  results:      null,
};

/* =========================================================================
   DOM — helpers
========================================================================= */
const $ = id => document.getElementById(id);

// Todos los elementos cacheados en un objeto — accedidos despues del DOM load
let UI = {};

function cacheUI() {
  UI = {
    dotFirebase:  $('dotFirebase'),
    lblFirebase:  $('labelFirebase'),
    displayRound: $('displayRound'),
    displayVotes: $('displayVotes'),
    displayTimer: $('displayTimer'),
    viewPre:      $('statePreVoting'),
    viewPost:     $('statePostVoting'),
    gridPart:     $('participantsGrid'),
    gridPairs:    $('pairsGrid'),
    inputDur:     $('inputDuration'),
    loadOverlay:  $('loadingOverlay'),
    loadText:     $('loadingText'),
    toasts:       $('toastContainer'),
  };
}

/* =========================================================================
   RESET CENTRALIZADO
   Unico punto de limpieza. Llamado por: reiniciar, borrar datos, fin ronda.
========================================================================= */
function fullResetState() {
  console.log('[CP] fullResetState()');

  stopTimer();
  timerGuard     = false;
  pendingImgSlot = null;
  pendingSwap    = null;

  ['modalSwap','modalImage','modalConfirm','modalPassword'].forEach(closeModal);

  state.pairs   = {};
  state.parejas = {};

  // Bajar flags — se reactivaran cuando Firebase responda
  state.ready.state   = false;
  state.ready.parejas = false;
  state.ready.results = false;

  if (UI.gridPairs)    UI.gridPairs.innerHTML      = '';
  if (UI.displayTimer) UI.displayTimer.textContent = '--:--';
  if (UI.displayVotes) UI.displayVotes.textContent = '000';

  showView('pre');

  // Limpiar storage del modulo
  try {
    ['localStorage','sessionStorage'].forEach(k => {
      const s = window[k];
      Object.keys(s).filter(x => x.startsWith('cp_')).forEach(x => s.removeItem(x));
    });
  } catch (_) {}

  console.log('[CP] fullResetState() completo');
}

/* =========================================================================
   UTILIDADES
========================================================================= */
function setLoading(on, text = 'ACTUALIZANDO...') {
  UI.loadText.textContent = text;
  UI.loadOverlay.classList.toggle('cp-loading--hidden', !on);
}

function lockUI(on) {
  document.querySelectorAll('.cp-btn:not([data-modal-btn])').forEach(b => {
    b.disabled = on;
  });
}

function toast(msg, type = 'info') {
  const icons = { success: '&#10003;', error: '&#10007;', info: '&#9673;', warning: '&#9888;' };
  const el = document.createElement('div');
  el.className = `cp-toast cp-toast--${type}`;
  el.innerHTML = `<span>${icons[type] || icons.info}</span><span>${esc(msg)}</span>`;
  UI.toasts.appendChild(el);
  setTimeout(() => {
    el.style.cssText += 'opacity:0;transform:translateX(24px);transition:all 280ms ease';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

function fmtTime(secs) {
  secs = Math.max(0, secs);
  return `${String(Math.floor(secs/60)).padStart(2,'0')}:${String(Math.floor(secs%60)).padStart(2,'0')}`;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function withLoading(fn, text = 'ACTUALIZANDO...') {
  setLoading(true, text);
  lockUI(true);
  try {
    await fn();
  } catch (err) {
    console.error('[CP] Error:', err);
    toast('Error: ' + (err.message || err), 'error');
  } finally {
    setLoading(false);
    lockUI(false);
  }
}

/* =========================================================================
   MODALES
========================================================================= */
function openModal(id)  { $(id)?.classList.add('is-open'); }
function closeModal(id) { $(id)?.classList.remove('is-open'); }

function confirmAction({
  title    = 'CONFIRMAR',
  body     = 'Estas seguro?',
  icon     = '&#9888;',
  yesLabel = 'SI, CONFIRMAR',
  yesClass = 'cp-btn--primary',
} = {}) {
  return new Promise(resolve => {
    // innerHTML para que las entidades se rendericen correctamente
    $('modalConfirmTitle').innerHTML = title;
    $('modalConfirmBody').textContent = body;
    $('modalConfirmIcon').innerHTML   = icon;
    openModal('modalConfirm');

    // Clonar botones — evita acumulacion de listeners
    const oy = $('modalConfirmYes');
    const on = $('modalConfirmNo');
    const y  = oy.cloneNode(true);
    const n  = on.cloneNode(true);
    y.innerHTML  = yesLabel;
    y.className  = `cp-btn ${yesClass}`;
    y.setAttribute('data-modal-btn', '1');
    n.setAttribute('data-modal-btn', '1');
    oy.replaceWith(y);
    on.replaceWith(n);

    const done = v => { closeModal('modalConfirm'); resolve(v); };
    y.addEventListener('click', () => done(true));
    n.addEventListener('click', () => done(false));
  });
}

/* =========================================================================
   VISTAS
========================================================================= */
function showView(which) {
  if (which === 'pre') {
    UI.viewPost.classList.add('cp-view--hidden');
    UI.viewPre.classList.remove('cp-view--hidden');
  } else {
    UI.viewPre.classList.add('cp-view--hidden');
    UI.viewPost.classList.remove('cp-view--hidden');
  }
}

/* =========================================================================
   CONEXION FIREBASE
========================================================================= */
function initConnection() {
  if (_unsubs.connected) return;

  _unsubs.connected = onValue(ref(db, '.info/connected'), snap => {
    const on = !!snap.val();
    UI.dotFirebase.className = `cp-dot ${on ? 'connected' : 'disconnected'}`;
    // [BUG2 FIXED] Usar innerHTML para que los simbolos Unicode se muestren bien
    UI.lblFirebase.innerHTML = on ? 'FIREBASE &#9679;' : 'FIREBASE &#9675;';
    console.log('[CP] Firebase:', on ? 'ONLINE' : 'OFFLINE');
  });

  window.addEventListener('online',  () => { UI.dotFirebase.className = 'cp-dot connected'; });
  window.addEventListener('offline', () => { UI.dotFirebase.className = 'cp-dot disconnected'; });
}

/* =========================================================================
   LISTENERS FIREBASE (una sola vez por ruta)
========================================================================= */
function setupListeners() {

  // /state
  if (!_unsubs.state) {
    _unsubs.state = onValue(ref(db, 'state'), snap => {
      const s = snap.val() || {};
      console.log('[CP] /state ->', JSON.stringify(s));

      state.fb = {
        votingOpen:   !!s.votingOpen,
        votingEnded:  !!s.votingEnded,
        waitingRoom:  s.waitingRoom !== false,
        currentRound: s.currentRound || 1,
        timerEnd:     s.timerEnd     || 0,
      };
      state.ready.state = true;

      UI.displayRound.textContent = String(state.fb.currentRound).padStart(2, '0');

      if (state.fb.votingEnded) {
        showView('post');
        stopTimer();
        timerGuard = false;
      } else if (state.fb.votingOpen) {
        showView('pre');
        startTimer();
      } else {
        showView('pre');
        stopTimer();
        UI.displayTimer.textContent = '--:--';
      }

      tryRender();
    });
  }

  // /participants
  if (!_unsubs.participants) {
    _unsubs.participants = onValue(ref(db, 'participants'), snap => {
      state.participants       = snap.val() || {};
      state.ready.participants = true;
      console.log('[CP] /participants ->', Object.keys(state.participants).length);
      renderParticipants();
      tryRender();
    });
  }

  // /parejas — ruta donde Vote guarda los votos reales
  if (!_unsubs.parejas) {
    _unsubs.parejas = onValue(ref(db, 'parejas'), snap => {
      state.parejas       = snap.val() || {};
      state.ready.parejas = true;
      console.log('[CP] /parejas ->', JSON.stringify(state.parejas));
      const total = countVotes(state.parejas);
      UI.displayVotes.textContent = String(total).padStart(3, '0');
      tryRender();
    });
  }

  // /results/pairs
  if (!_unsubs.results) {
    _unsubs.results = onValue(ref(db, 'results/pairs'), snap => {
      state.pairs        = snap.val() || {};
      state.ready.results = true;
      console.log('[CP] /results/pairs ->', Object.keys(state.pairs).length);
      tryRender();
    });
  }
}

/**
 * countVotes — lee la estructura real que escribe Vote:
 * /parejas/pareja_X/votos/{combo}: count
 * Suma todos los votos de todas las parejas.
 */
function countVotes(parejas) {
  let total = 0;
  Object.values(parejas || {}).forEach(pareja => {
    if (!pareja || typeof pareja !== 'object') return;
    const votos = pareja.votos || {};
    Object.values(votos).forEach(c => {
      if (typeof c === 'number') total += c;
    });
  });
  return total;
}

/* =========================================================================
   RENDER SINCRONIZADO — solo cuando ambos datasets estan listos
========================================================================= */
function tryRender() {
  if (state.fb.votingEnded && state.ready.participants && state.ready.results) {
    renderPairs();
  }
}

/* =========================================================================
   TEMPORIZADOR
========================================================================= */
function startTimer() {
  stopTimer();
  if (!state.fb.timerEnd) return;
  timerGuard = false;

  timerInterval = setInterval(() => {
    const rem = Math.max(0, (state.fb.timerEnd - Date.now()) / 1000);
    UI.displayTimer.textContent = fmtTime(rem);
    if (rem <= 0 && !timerGuard) {
      timerGuard = true;
      stopTimer();
      onTimerEnd();
    }
  }, 500);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

async function onTimerEnd() {
  if (!state.fb.votingOpen) {
    console.log('[CP] onTimerEnd: votingOpen ya false, skip');
    return;
  }
  console.log('[CP] Timer expirado -> Firebase...');
  try {
    await update(ref(db, 'state'), {
      votingOpen: false, votingEnded: true, waitingRoom: false,
    });
    console.log('[CP] votingEnded=true OK');
  } catch (e) {
    console.error('[CP] onTimerEnd error:', e);
    timerGuard = false;
  }
}

/* =========================================================================
   RENDER PARTICIPANTES
   Diff minimo: crea tarjeta una vez, actualiza datos despues.
========================================================================= */
function renderParticipants() {
  const grid = UI.gridPart;
  for (let i = 1; i <= TOTAL_PARTICIPANTS; i++) {
    const pid  = `participant_${i}`;
    const data = state.participants[pid] || { name: '', image: '', number: i };
    let card   = grid.querySelector(`[data-pid="${pid}"]`);
    if (!card) {
      card = makeParticipantCard(pid, data);
      grid.appendChild(card);
    } else {
      patchParticipantCard(card, data);
    }
  }
}

function makeParticipantCard(pid, data) {
  const card = document.createElement('div');
  card.className   = 'cp-pcard';
  card.dataset.pid = pid;
  card.innerHTML   = participantHTML(data);

  // Listener nombre (debounce 600ms)
  const inp = card.querySelector('.cp-pcard__name');
  let nt;
  inp.addEventListener('input', () => {
    clearTimeout(nt);
    nt = setTimeout(() => saveName(pid, inp.value), 600);
  });

  // Listener imagen
  card.querySelector('.cp-pcard__imgbox').addEventListener('click', () => openImgModal(pid));

  return card;
}

function patchParticipantCard(card, data) {
  const box   = card.querySelector('.cp-pcard__imgbox');
  const img   = box.querySelector('.cp-pcard__img');
  const noimg = box.querySelector('.cp-pcard__noimg');
  const inp   = card.querySelector('.cp-pcard__name');

  if (data.image) {
    if (img) {
      if (img.src !== data.image) img.src = data.image;
    } else {
      const ni = document.createElement('img');
      ni.className = 'cp-pcard__img';
      ni.src       = data.image;
      ni.alt       = data.name || '';
      ni.loading   = 'lazy';
      box.prepend(ni);
    }
    if (noimg) noimg.style.display = 'none';
  } else {
    if (img) img.remove();
    if (noimg) noimg.style.display = '';
  }

  if (document.activeElement !== inp) inp.value = data.name || '';
}

function participantHTML(data) {
  const num = String(data.number || '?').padStart(2, '0');
  const imgH = data.image
    ? `<img class="cp-pcard__img" src="${esc(data.image)}" alt="${esc(data.name)}" loading="lazy" />`
    : '';
  const noSt = data.image ? 'style="display:none"' : '';

  return `
    <div class="cp-pcard__num">#${num}</div>
    <div class="cp-pcard__imgbox">
      ${imgH}
      <div class="cp-pcard__noimg" ${noSt}>
        <span class="cp-pcard__noimg-icon">&#9675;</span>
        <span class="cp-pcard__noimg-txt">SIN IMAGEN</span>
      </div>
      <div class="cp-pcard__hover">&#9673; CAMBIAR</div>
    </div>
    <div class="cp-pcard__body">
      <input class="cp-pcard__name" type="text"
             placeholder="Nombre participante..."
             value="${esc(data.name || '')}" maxlength="40" />
    </div>
  `;
}

/* =========================================================================
   RENDER PAREJAS
   Solo llamado desde tryRender(). Datos de nombre/imagen desde state.participants.
========================================================================= */
function renderPairs() {
  const grid = UI.gridPairs;
  grid.innerHTML = '';
  for (let i = 1; i <= TOTAL_PAIRS; i++) {
    const pk = `pair_${i}`;
    grid.appendChild(makePairCard(pk, i, state.pairs[pk] || null));
  }
  console.log('[CP] renderPairs OK');
}

function makePairCard(pk, num, pdata) {
  const card = document.createElement('div');
  card.className = 'cp-pair';
  card.dataset.pair = num;

  const elim = pdata?.eliminated ?? false;
  const pts  = pdata?.participants || [null, null];
  if (elim) card.classList.add('cp-pair--elim');

  card.innerHTML = `
    <div class="cp-pair__hdr">
      <span class="cp-pair__title">PAREJA ${num}</span>
      <div class="cp-pair__actions">
        ${!elim ? `<button class="cp-btn cp-btn--danger cp-btn--sm"
            data-action="elim-pair" data-pair="${pk}">&#10005; ELIMINAR</button>` : ''}
      </div>
    </div>
    <div class="cp-pair__slots">
      ${makeSlot(pk, 0, pts[0])}
      ${makeSlot(pk, 1, pts[1])}
    </div>
  `;

  return card;
}

function makeSlot(pk, idx, num) {
  if (!num) {
    return `
      <div class="cp-slot cp-slot--empty" data-slot="${idx}" data-pair="${pk}">
        <div class="cp-slot__empty-lbl">&#8212; VACIO &#8212;</div>
      </div>
    `;
  }

  const pid  = `participant_${num}`;
  const data = state.participants[pid] || { name: `Participante ${num}`, image: '', number: num };
  const imgH = data.image
    ? `<img class="cp-slot__img" src="${esc(data.image)}" alt="${esc(data.name)}" loading="lazy" />`
    : `<div class="cp-slot__noimg">&#9675;</div>`;

  return `
    <div class="cp-slot" data-slot="${idx}" data-pair="${pk}" data-participant="${num}">
      ${imgH}
      <div class="cp-slot__num">#${String(num).padStart(2,'0')}</div>
      <div class="cp-slot__name">${esc(data.name || `Participante ${num}`)}</div>
      <div class="cp-slot__overlay">
        <button class="cp-btn cp-btn--warning cp-btn--sm"
          data-action="swap" data-pair="${pk}" data-slot="${idx}"
          data-participant="${num}">&#8644; MOVER</button>
        <button class="cp-btn cp-btn--danger cp-btn--sm"
          data-action="elim-slot" data-pair="${pk}" data-slot="${idx}"
          data-participant="${num}">&#10005; ELIMINAR</button>
      </div>
    </div>
  `;
}

// Event delegation — un listener permanente
UI.gridPairs = document.getElementById('pairsGrid');
UI.gridPairs.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  e.stopPropagation();
  const { action, pair, slot, participant } = btn.dataset;
  if (action === 'elim-pair') onEliminatePair(pair);
  if (action === 'elim-slot') onEliminateSlot(pair, parseInt(slot), parseInt(participant));
  if (action === 'swap')      onSwap(pair, parseInt(slot), parseInt(participant));
});

/* =========================================================================
   GUARDAR PARTICIPANTES
========================================================================= */
async function saveName(pid, name) {
  try {
    await update(ref(db, `participants/${pid}`), { name: name.trim() });
  } catch (e) {
    toast('Error guardando nombre', 'error');
  }
}

async function saveImage(pid, url) {
  await withLoading(async () => {
    await update(ref(db, `participants/${pid}`), { image: url });
    toast('Imagen actualizada', 'success');
  }, 'GUARDANDO IMAGEN...');
}

/* =========================================================================
   MODAL IMAGEN
========================================================================= */
function openImgModal(pid) {
  pendingImgSlot = pid;
  $('inputImageUrl').value = '';
  openModal('modalImage');
}

$('btnImageUpload').addEventListener('click', () => $('fileImageInput').click());

$('fileImageInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || !pendingImgSlot) return;
  const r = new FileReader();
  r.onload = async ev => {
    await saveImage(pendingImgSlot, ev.target.result);
    closeModal('modalImage');
    pendingImgSlot = null;
  };
  r.readAsDataURL(file);
  e.target.value = '';
});

$('btnImageUrl').addEventListener('click', async () => {
  const url = $('inputImageUrl').value.trim();
  if (!url)           { toast('Introduce una URL valida', 'warning'); return; }
  if (!pendingImgSlot) return;
  await saveImage(pendingImgSlot, url);
  closeModal('modalImage');
  pendingImgSlot = null;
});

$('btnImageRemove').addEventListener('click', async () => {
  if (!pendingImgSlot) return;
  const ok = await confirmAction({
    title: 'ELIMINAR IMAGEN',
    body:  'Eliminar la imagen de este participante?',
    icon:  '&#10005;', yesLabel: 'ELIMINAR', yesClass: 'cp-btn--danger',
  });
  if (!ok) return;
  await saveImage(pendingImgSlot, '');
  closeModal('modalImage');
  pendingImgSlot = null;
});

$('modalImageClose').addEventListener('click', () => closeModal('modalImage'));

/* =========================================================================
   INICIAR VOTACION
========================================================================= */
$('btnStartVoting').addEventListener('click', async () => {
  const ok = await confirmAction({
    title: 'INICIAR VOTACION',
    body:  'El temporizador comenzara inmediatamente. Estas seguro?',
    icon:  '&#9654;', yesLabel: 'SI, INICIAR', yesClass: 'cp-btn--primary',
  });
  if (!ok) return;

  const dur = parseInt(UI.inputDur.value) || 120;
  const end = Date.now() + dur * 1000;

  await withLoading(async () => {
    console.log('[CP] INICIAR VOTACION -> timerEnd =', end);
    await update(ref(db, 'state'), {
      votingOpen:  true,
      votingEnded: false,
      waitingRoom: false,
      timerEnd:    end,
    });
    console.log('[CP] votingOpen=true OK');
    toast('Votacion iniciada!', 'success');
  }, 'INICIANDO VOTACION...');
});

/* =========================================================================
   REINICIAR VOTACION
========================================================================= */
async function doRestartVoting() {
  const ok = await confirmAction({
    title: 'REINICIAR VOTACION',
    body:  'Se limpian votos y parejas. Participantes se mantienen.',
    icon:  '&#8634;', yesLabel: 'SI, REINICIAR', yesClass: 'cp-btn--warning',
  });
  if (!ok) return;

  await withLoading(async () => {
    fullResetState();
    await remove(ref(db, 'parejas'));
    await remove(ref(db, 'results/pairs'));
    console.log('[CP] REINICIAR VOTACION -> Firebase...');
    await update(ref(db, 'state'), {
      votingOpen:  false,
      votingEnded: false,
      waitingRoom: true,
      timerEnd:    0,
    });
    console.log('[CP] waitingRoom=true OK');
    toast('Votacion reiniciada', 'info');
  }, 'REINICIANDO...');
}

$('btnRestartVoting').addEventListener('click',  doRestartVoting);
$('btnRestartVoting2').addEventListener('click', doRestartVoting);

/* =========================================================================
   BORRAR DATOS
========================================================================= */
function doClearData() {
  $('inputPassword').value       = '';
  $('passwordError').textContent = '';
  openModal('modalPassword');
}

$('btnClearData').addEventListener( 'click', doClearData);
$('btnClearData2').addEventListener('click', doClearData);
$('modalPasswordNo').addEventListener('click', () => closeModal('modalPassword'));

$('modalPasswordYes').addEventListener('click', async () => {
  if ($('inputPassword').value !== ADMIN_PASSWORD) {
    $('passwordError').innerHTML = '&#10007; Contrasena incorrecta';
    $('inputPassword').style.borderColor = 'var(--danger)';
    setTimeout(() => { $('inputPassword').style.borderColor = ''; }, 2000);
    return;
  }
  closeModal('modalPassword');

  const ok = await confirmAction({
    title: 'BORRAR TODOS LOS DATOS',
    body:  'IRREVERSIBLE. Se borraran votos, parejas, rondas y estados.',
    icon:  '&#9940;', yesLabel: '&#9888; BORRAR TODO', yesClass: 'cp-btn--danger',
  });
  if (!ok) return;

  await withLoading(async () => {
    fullResetState();
    await remove(ref(db, 'parejas'));
    await remove(ref(db, 'results'));
    await remove(ref(db, 'history'));
    console.log('[CP] BORRAR DATOS -> Firebase...');
    await update(ref(db, 'state'), {
      votingOpen:   false,
      votingEnded:  false,
      waitingRoom:  true,
      currentRound: 1,
      timerEnd:     0,
    });
    console.log('[CP] State reset OK');
    toast('Todos los datos borrados', 'warning');
  }, 'BORRANDO DATOS...');
});

/* =========================================================================
   CONSOLIDAR PAREJAS
========================================================================= */
$('btnConsolidate').addEventListener('click', async () => {
  const ok = await confirmAction({
    title: 'CONSOLIDAR PAREJAS',
    body:  'Se calcularan las parejas ganadoras por cuadro. Continuar?',
    icon:  '&#8853;', yesLabel: 'CONSOLIDAR', yesClass: 'cp-btn--accent',
  });
  if (!ok) return;

  await withLoading(async () => {
    const pairs = calcPairs(state.parejas, state.fb.currentRound);
    if (!pairs) { toast('Sin votos suficientes', 'warning'); return; }
    await set(ref(db, 'results/pairs'), pairs);
    console.log('[CP] results/pairs escritos:', JSON.stringify(pairs));
    toast('Parejas consolidadas', 'success');
  }, 'CONSOLIDANDO...');
});

/**
 * Algoritmo greedy por cuadro independiente:
 * 1. Ranking de combos por cuadro
 * 2. Greedy sin repetir participantes
 * 3. Rellenar con sobrantes
 */
/**
 * calcPairs — lee la estructura REAL que escribe Vote:
 *
 *   /parejas/pareja_X/participantes: [ {id:"participant_1", nombre:"..."}, ... ]
 *   /parejas/pareja_X/votos/{id_participanteA}_{id_participanteB}: count
 *
 * Paso 1: Para cada cuadro (pareja_1..5) construimos el ranking de combos
 *         usando los votos guardados por Vote.
 * Paso 2: Greedy sin repetir participantes globalmente.
 * Paso 3: Rellenar con sobrantes si algun cuadro quedo sin asignar.
 */
function calcPairs(votaciones, round) {
  // "votaciones" aqui es state.parejas — se mantiene el param por compatibilidad
  const parejas = state.parejas;

  console.log('[CP] calcPairs — parejas raw:', JSON.stringify(parejas));

  // Paso 1: ranking por cuadro
  // Vote guarda el cuadro como "pareja_1", "pareja_2", etc.
  // Los combos en /votos usan IDs de participantes: "participant_1_participant_7"
  const ranked = {};
  for (let p = 1; p <= TOTAL_PAIRS; p++) {
    const pk      = `pair_${p}`;      // clave interna del panel
    const voteKey = `pareja_${p}`;    // clave en Firebase (segun Vote)
    const pareja  = parejas[voteKey] || {};
    const votos   = pareja.votos    || {};

    console.log(`[CP] ${voteKey} votos:`, JSON.stringify(votos));

    ranked[pk] = Object.entries(votos)
      .map(([combo, count]) => {
        // combo puede ser "participant_1_participant_7"
        // extraemos los numeros de los IDs
        const nums = combo.match(/\d+/g) || [];
        const a = parseInt(nums[0]);
        const b = parseInt(nums[1]);
        return { a, b, v: count || 0 };
      })
      .filter(x => !isNaN(x.a) && !isNaN(x.b))
      .sort((x, y) => y.v - x.v);

    console.log(`[CP] ${pk} ranking:`, JSON.stringify(ranked[pk]));
  }

  // Paso 2: greedy
  const used   = new Set();
  const result = {};

  for (let p = 1; p <= TOTAL_PAIRS; p++) {
    const pk = `pair_${p}`;
    let assigned = false;
    for (const { a, b } of ranked[pk]) {
      if (used.has(a) || used.has(b)) continue;
      used.add(a); used.add(b);
      result[pk] = { participants: [a, b], eliminated: false };
      console.log(`[CP] ${pk} -> [${a},${b}] votado`);
      assigned = true;
      break;
    }
    if (!assigned) result[pk] = null;
  }

  // Paso 3: rellenar sobrantes
  const avail = Array.from({ length: TOTAL_PARTICIPANTS }, (_, i) => i + 1)
    .filter(n => !used.has(n));

  for (let p = 1; p <= TOTAL_PAIRS; p++) {
    const pk = `pair_${p}`;
    if (result[pk] !== null) continue;
    const a = avail.shift() ?? null;
    const b = avail.shift() ?? null;
    result[pk] = { participants: [a, b], eliminated: false };
    console.log(`[CP] ${pk} -> [${a},${b}] relleno`);
  }

  return result;
}

/* =========================================================================
   ACCIONES SOBRE PAREJAS
========================================================================= */
async function syncPairs(newPairs, msg) {
  await update(ref(db, 'results/pairs'), newPairs);
  console.log('[CP] results/pairs synced');
  if (msg) toast(msg, 'info');
  checkWinner();
}

async function onEliminatePair(pk) {
  const ok = await confirmAction({
    title: 'ELIMINAR PAREJA',
    body:  `Eliminar ${pk.replace('_',' ').toUpperCase()}? Ambos participantes quedan fuera.`,
    icon:  '&#10005;', yesLabel: 'ELIMINAR PAREJA', yesClass: 'cp-btn--danger',
  });
  if (!ok) return;
  await withLoading(async () => {
    const upd = clonePairs();
    if (upd[pk]) upd[pk].eliminated = true;
    await syncPairs(upd, `${pk.replace('_',' ')} eliminada`);
  }, 'ELIMINANDO...');
}

async function onEliminateSlot(pk, si, num) {
  const name = state.participants[`participant_${num}`]?.name || `#${num}`;
  const ok = await confirmAction({
    title: 'ELIMINAR PARTICIPANTE',
    body:  `Eliminar a "${name}"? Su lugar quedara vacio.`,
    icon:  '&#10005;', yesLabel: 'ELIMINAR', yesClass: 'cp-btn--danger',
  });
  if (!ok) return;
  await withLoading(async () => {
    const upd = clonePairs();
    if (!upd[pk]) return;
    upd[pk].participants[si] = null;
    await syncPairs(upd, `${name} eliminado`);
  }, 'ACTUALIZANDO...');
}

async function onSwap(fromPk, fromSi, fromNum) {
  pendingSwap = { fromPk, fromSi, fromNum };
  const name = state.participants[`participant_${fromNum}`]?.name || `#${fromNum}`;
  $('modalSwapBody').textContent = `Mover a "${name}" - selecciona destino:`;

  const grid = $('swapGrid');
  grid.innerHTML = '';

  for (const [pk, pair] of Object.entries(state.pairs)) {
    if (!pair || pair.eliminated) continue;
    (pair.participants || [null, null]).forEach((num, si) => {
      if (pk === fromPk && si === fromSi) return;
      const td   = num ? (state.participants[`participant_${num}`] || {}) : null;
      const pNum = pk.split('_')[1];

      const item = document.createElement('div');
      item.className = 'cp-swap-item';
      item.innerHTML = `
        ${td?.image
          ? `<img class="cp-swap-item__img" src="${esc(td.image)}" alt="${esc(td.name||'')}" />`
          : `<div class="cp-swap-item__img" style="background:var(--srf3);display:flex;align-items:center;justify-content:center;font-size:1.5rem;color:var(--txt-dim)">&#9675;</div>`}
        <span class="cp-swap-item__name">${esc(td?.name || '- VACIO -')}</span>
        <span class="cp-swap-item__info">Pareja ${pNum} &bull; Slot ${si === 0 ? 'A' : 'B'}</span>
      `;
      item.addEventListener('click', () => {
        closeModal('modalSwap');
        doSwap(fromPk, fromSi, fromNum, pk, si, num);
      });
      grid.appendChild(item);
    });
  }

  $('modalSwapClose').onclick = () => { closeModal('modalSwap'); pendingSwap = null; };
  openModal('modalSwap');
}

async function doSwap(fromPk, fromSi, fromNum, toPk, toSi, toNum) {
  const ok = await confirmAction({
    title: 'INTERCAMBIAR',
    body:  `Intercambiar participantes entre ${fromPk} y ${toPk}?`,
    icon:  '&#8644;', yesLabel: 'INTERCAMBIAR', yesClass: 'cp-btn--primary',
  });
  if (!ok) { pendingSwap = null; return; }

  await withLoading(async () => {
    const upd = clonePairs();
    if (!upd[fromPk]) upd[fromPk] = { participants: [null,null], eliminated: false };
    if (!upd[toPk])   upd[toPk]   = { participants: [null,null], eliminated: false };
    while (upd[fromPk].participants.length < 2) upd[fromPk].participants.push(null);
    while (upd[toPk].participants.length   < 2) upd[toPk].participants.push(null);
    upd[fromPk].participants[fromSi] = toNum   ?? null;
    upd[toPk].participants[toSi]     = fromNum ?? null;
    await syncPairs(upd, null);
    toast('Intercambio realizado', 'success');
  }, 'INTERCAMBIANDO...');

  pendingSwap = null;
}

function clonePairs() {
  const c = {};
  for (const [k, v] of Object.entries(state.pairs)) {
    c[k] = v
      ? { eliminated: v.eliminated ?? false, participants: [...(v.participants || [null,null])] }
      : null;
  }
  return c;
}

/* =========================================================================
   GANADOR
   Activa = eliminated===false AND exactamente 2 participantes no-null
========================================================================= */
function checkWinner() {
  const active = Object.entries(state.pairs).filter(([, p]) => {
    if (!p || p.eliminated) return false;
    const pts = p.participants || [];
    return pts.length === 2 && pts[0] != null && pts[1] != null;
  });
  console.log('[CP] checkWinner: activas =', active.length);
  if (active.length === 1) {
    const [wk] = active[0];
    update(ref(db, 'results'), { winner: wk });
    toast(`GANADOR: ${wk.replace('_',' ').toUpperCase()}!`, 'success');
  }
}

/* =========================================================================
   FINALIZAR RONDA
========================================================================= */
$('btnFinalizeRound').addEventListener('click', async () => {
  const rnd = state.fb.currentRound;
  const ok  = await confirmAction({
    title: `FINALIZAR RONDA ${rnd}`,
    body:  `Finalizar la ronda ${rnd}? Se guardara historial y comenzara la siguiente.`,
    icon:  '&#9658;&#9658;', yesLabel: 'FINALIZAR RONDA', yesClass: 'cp-btn--primary',
  });
  if (!ok) return;

  await withLoading(async () => {
    const newRnd = rnd + 1;

    await set(ref(db, `history/round_${rnd}`), {
      parejas:   state.parejas,
      pairs:     state.pairs,
      timestamp: Date.now(),
      round:     rnd,
    });
    console.log(`[CP] history/round_${rnd} OK`);

    fullResetState();

    await remove(ref(db, 'parejas'));
    await remove(ref(db, 'results'));

    console.log(`[CP] Avanzando a ronda ${newRnd}...`);
    await update(ref(db, 'state'), {
      votingOpen:   false,
      votingEnded:  false,
      waitingRoom:  true,
      currentRound: newRnd,
      timerEnd:     0,
    });
    console.log(`[CP] currentRound=${newRnd} OK`);
    toast(`Ronda ${rnd} finalizada -> ronda ${newRnd}`, 'success');
  }, 'FINALIZANDO RONDA...');
});

/* =========================================================================
   NAVEGACION
========================================================================= */
$('btnBack').addEventListener('click', () => {
  window.location.href = 'admin.html';
});

/* =========================================================================
   INICIALIZACION
   [BUG3 FIXED] ensureDefaults tiene su propio try/catch para que un fallo
   ahi no bloquee setupListeners().
========================================================================= */
async function ensureDefaults() {
  try {
    const stSnap = await get(ref(db, 'state'));
    if (!stSnap.exists()) {
      console.log('[CP] /state no existe -> inicializando...');
      await update(ref(db, 'state'), {
        votingOpen:   false,
        votingEnded:  false,
        waitingRoom:  true,
        currentRound: 1,
        timerEnd:     0,
      });
      console.log('[CP] /state inicializado OK');
    }
  } catch (e) {
    console.warn('[CP] ensureDefaults /state error (no critico):', e.message);
  }

  try {
    const ptSnap = await get(ref(db, 'participants'));
    if (!ptSnap.exists()) {
      console.log('[CP] /participants no existe -> creando defaults...');
      const d = {};
      for (let i = 1; i <= TOTAL_PARTICIPANTS; i++)
        d[`participant_${i}`] = { name: `Participante ${i}`, image: '', number: i };
      await update(ref(db, 'participants'), d);
      console.log('[CP] /participants defaults OK');
    }
  } catch (e) {
    console.warn('[CP] ensureDefaults /participants error (no critico):', e.message);
  }
}

async function init() {
  // Cachear DOM primero
  cacheUI();

  // Adjuntar el listener de pairsGrid aqui (despues de cacheUI)
  UI.gridPairs.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const { action, pair, slot, participant } = btn.dataset;
    if (action === 'elim-pair') onEliminatePair(pair);
    if (action === 'elim-slot') onEliminateSlot(pair, parseInt(slot), parseInt(participant));
    if (action === 'swap')      onSwap(pair, parseInt(slot), parseInt(participant));
  });

  try {
    initConnection();
    await ensureDefaults();
    setupListeners();
    console.log('[CP] Control Panel inicializado OK');
  } catch (e) {
    console.error('[CP] Error en init:', e);
    toast('Error iniciando panel: ' + (e.message || e), 'error');
  }
}

init();
