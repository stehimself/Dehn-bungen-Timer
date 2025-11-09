// /app.js
// Basierend auf deiner bisherigen HTML-Datei, in eine externe JS-Datei verschoben,
// damit der Service Worker sauber cachen kann. (Originallogik uebernommen)  

// ===================== Zustand =====================
let running = false;          // laeuft der Timer?
let paused = false;           // ist der Timer pausiert?
let customSelected = null;    // vom Nutzer gesetzte freie Sekunden (oder null)
let rafId = null;             // requestAnimationFrame ID
let endTime = 0;              // Zielzeitpunkt in ms
let lastWhole = null;         // Letzter gesprochener ganzzahliger Wert
let warmedUpTTS = false;      // TTS vorgewarmt?
let deVoice = null;           // ausgewaehlte deutsche Stimme
let wakeLock = null;          // Screen Wake Lock Handle

const timerEl = document.getElementById('timer');   // Anzeige: Sekunden
const statusEl = document.getElementById('status'); // Anzeige: Status

// Aktuell gewaehlte Sekunden auslesen
function getSelectedSeconds(){
  if (typeof customSelected === 'number' && customSelected > 0) return customSelected;
  const active = document.querySelector('.opt[aria-checked="true"]');
  return Number(active?.dataset.seconds || 45);
}

// Deutsche Stimme waehlen
function pickGermanVoice(){
  const voices = speechSynthesis.getVoices();
  deVoice = voices.find(v => /de(-|_)?(CH|DE|AT)/i.test(v.lang)) || voices.find(v=>/de/i.test(v.lang)) || null;
}

// TTS vorwaermen (Workaround gegen Verzoegerung)
function warmupTTS(){
  if (warmedUpTTS) return;
  pickGermanVoice();
  const u = new SpeechSynthesisUtterance('.');
  u.volume = 0;
  if (deVoice) u.voice = deVoice;
  speechSynthesis.speak(u);
  warmedUpTTS = true;
}

// Zahl ansagen
function speakNow(text){
  try { speechSynthesis.cancel(); } catch(e){}
  const u = new SpeechSynthesisUtterance(String(text));
  if (deVoice) u.voice = deVoice;
  u.lang = (deVoice?.lang) || 'de-DE';
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  speechSynthesis.speak(u);
}

// Kleiner Dreiklang-Gong als Abschluss
let audioCtx;
function playTriGong(){
  return new Promise(resolve => {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(()=>{});
    }
    const hit = (frequency, delayMs) => {
      const t0 = audioCtx.currentTime + (delayMs/1000);
      const osc = audioCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, t0);
      const gain = audioCtx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.6, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);

      const osc2 = audioCtx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(frequency*2.01, t0);
      const gain2 = audioCtx.createGain();
      gain2.gain.setValueAtTime(0.0001, t0);
      gain2.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02);
      gain2.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.0);

      osc.connect(gain).connect(audioCtx.destination);
      osc2.connect(gain2).connect(audioCtx.destination);
      osc.start(t0); osc.stop(t0 + 1.3);
      osc2.start(t0); osc2.stop(t0 + 1.1);
    };
    hit(660,   0);
    hit(784, 250);
    hit(988, 500);
    setTimeout(resolve, 1600);
  });
}

// ===================== Wake Lock (Bildschirm an) =====================
async function requestWakeLock(){
  if (!('wakeLock' in navigator)) return;
  try {
    if (wakeLock && wakeLock.released === false) {
      try { await wakeLock.release(); } catch(_){}
    }
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      // no-op; bei Sichtbarkeitswechsel neu anfordern
    });
  } catch (_) {
    // still akzeptieren (OS/Browser kann blockieren)
  }
}

async function releaseWakeLock(){
  if (wakeLock) {
    try { await wakeLock.release(); } catch(_){/* noop */}
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) {
    requestWakeLock();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(()=>{});
    }
  }
});

// ===================== Media Session (OS-Integration) =====================
function setMediaSessionPlaying(){
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Dehnuebungen Timer',
      artist: 'Timer',
      album: 'Session',
      artwork: [
        { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    });
    navigator.mediaSession.playbackState = 'playing';
  } catch(_){/* noop */}
}

function setMediaSessionPaused(){
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = 'paused'; } catch(_){/* noop */}
}

function setMediaActionHandlers(){
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler('play', () => {
      if (paused) {
        const remain = Math.max(0, Number(timerEl.textContent)||0);
        startCountdown(remain);
      } else if (!running) {
        startCountdown(getSelectedSeconds());
      }
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (running && !paused) {
        document.getElementById('pauseBtn').click();
      }
    });
    const noop = ()=>{};
    ;['stop','seekbackward','seekforward','seekto','previoustrack','nexttrack'].forEach(a => {
      try { navigator.mediaSession.setActionHandler(a, noop); } catch(_){/* noop */}
    });
  } catch(_){/* noop */}
}

// Countdown starten
function startCountdown(sec){
  warmupTTS();                        // TTS frueh starten, damit synchron
  running = true; paused = false; lastWhole = null;
  endTime = performance.now() + sec * 1000;
  statusEl.textContent = 'Action';
  timerEl.textContent = sec;
  // Bildschirm anhalten und Media Session konfigurieren
  requestWakeLock();
  setMediaSessionPlaying();
  setMediaActionHandlers();
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(()=>{});
  }

  const loop = () => {
    if (!running || paused) return;
    const now = performance.now();
    const remainingMs = Math.max(0, endTime - now);
    const remainingWhole = Math.ceil(remainingMs / 1000);

    // Jede Sekunde aktualisieren & ansagen
    if (remainingWhole !== lastWhole){
      timerEl.textContent = remainingWhole;             // Anzeige sekundenaktuell
      // Regel: volle 10er Schritte (z.B. 60,50,40,30,20,10)
      // und Einzelzaehlung erst ab 5 (5,4,3,2,1)
      if (remainingWhole > 0){
        const isTenStep = (remainingWhole % 10 === 0);
        const isFinalFive = (remainingWhole <= 5);
        if (isTenStep || isFinalFive){
          speakNow(remainingWhole);                     // synchron zur Anzeige
        }
      }
      lastWhole = remainingWhole;
    }

    // Ende erreicht -> Gong und naechster Durchlauf mit gleicher Dauer
    if (remainingMs <= 0){
      running = false;
      timerEl.textContent = '0';
      statusEl.textContent = 'Gong…';
      playTriGong().then(() => {
        if (!paused){
          startCountdown(getSelectedSeconds());         // gleiche Auswahl erneut
        }
      });
      return;
    }
    rafId = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(loop);
}

// Auswahl-Buttons (30/45/60)
for (const btn of document.querySelectorAll('.opt')){
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.opt')) b.setAttribute('aria-checked','false');
    btn.setAttribute('aria-checked','true');
    customSelected = null; // Wechsel zu vordefinierter Option
    if (!running){
      timerEl.textContent = Number(btn.dataset.seconds);
      statusEl.textContent = 'Bereit';
    }
  });
}

// Freie Wahl: Sekundeneingabe uebernehmen
const customInput = document.getElementById('customSec');
const useCustomBtn = document.getElementById('useCustomBtn');

function applyCustomSeconds(){
  const val = Number(customInput?.value);
  if (!Number.isFinite(val) || val <= 0) {
    statusEl.textContent = 'Ungueltige Eingabe';
    return;
  }
  const sec = Math.min(600, Math.max(1, Math.floor(val)));
  customSelected = sec;
  for (const b of document.querySelectorAll('.opt')) b.setAttribute('aria-checked','false');
  if (!running){
    timerEl.textContent = sec;
    statusEl.textContent = 'Bereit';
  }
}

useCustomBtn?.addEventListener('click', applyCustomSeconds);
customInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyCustomSeconds();
});

// Start/Pause/Reset/Stop
document.getElementById('startBtn').addEventListener('click', () => {
  startCountdown(getSelectedSeconds());
});

document.getElementById('pauseBtn').addEventListener('click', () => {
  if (!running && !paused) return;
  if (!paused){
    paused = true; statusEl.textContent = 'Pausiert';
    cancelAnimationFrame(rafId);
    try{ speechSynthesis.cancel(); }catch(e){}
    setMediaSessionPaused();
  } else {
    const remain = Math.max(0, Number(timerEl.textContent)||0);
    startCountdown(remain);
  }
});

document.getElementById('resetBtn').addEventListener('click', () => {
  running = false; paused = false; cancelAnimationFrame(rafId);
  try{ speechSynthesis.cancel(); }catch(e){}
  timerEl.textContent = getSelectedSeconds();
  statusEl.textContent = 'Bereit';
  setMediaSessionPaused();
  releaseWakeLock();
});

document.getElementById('stopBtn').addEventListener('click', () => {
  running = false; paused = false; cancelAnimationFrame(rafId);
  try{ speechSynthesis.cancel(); }catch(e){}
  statusEl.textContent = 'Gestoppt';
  setMediaSessionPaused();
  releaseWakeLock();
});

// Stimmenliste kann spaet geladen werden
if (typeof speechSynthesis !== 'undefined'){
  speechSynthesis.onvoiceschanged = pickGermanVoice;
}

// ===================== Service Worker registrieren =====================
// Registriert den Service Worker, damit die App offline faehig ist.
// Nutzt relativen Pfad, funktioniert auch in Unterordnern.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { updateViaCache: 'none' })
      .then(reg => { try { reg.update(); } catch(_){} })
      .catch(err => console.error('SW Registrierung fehlgeschlagen:', err));
  });
}
