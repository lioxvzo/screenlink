'use strict';
/* global Peer */

// ---------- Konfiguration ----------
const ID_PREFIX = 'screenlink-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const QUALITY = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 },
  '1440p60': { width: 2560, height: 1440, fps: 60, bitrate: 16_000_000 },
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  myCode: $('myCode'), copyBtn: $('copyBtn'), myName: $('myName'),
  remoteCode: $('remoteCode'), connectBtn: $('connectBtn'),
  connectBox: $('connectBox'), connectedBox: $('connectedBox'),
  remoteName: $('remoteName'), disconnectBtn: $('disconnectBtn'),
  stage: $('stage'), remoteVideo: $('remoteVideo'), localVideo: $('localVideo'),
  placeholder: $('placeholder'), placeholderTitle: $('placeholderTitle'), placeholderText: $('placeholderText'),
  previewBox: $('previewBox'), stats: $('stats'),
  shareBtn: $('shareBtn'), stopBtn: $('stopBtn'), quality: $('quality'), mode: $('mode'),
  sendAudio: $('sendAudio'), volume: $('volume'), statsBtn: $('statsBtn'), fullscreenBtn: $('fullscreenBtn'),
  picker: $('picker'), pickerClose: $('pickerClose'), sourceGrid: $('sourceGrid'), toast: $('toast'),
  controlBtn: $('controlBtn'), revokeBtn: $('revokeBtn'), ctrlBadge: $('ctrlBadge'),
};

// ---------- Zustand ----------
let peer = null;
let myCode = null;
let conn = null;          // Datenverbindung zum Kollegen
let remoteLabel = '';
let outCall = null;       // mein ausgehender Stream
let inCall = null;        // eingehender Stream vom Kollegen
let localStream = null;
let statsVisible = false;
let opts = {};
let viewerCtrl = 'off';   // ich steuere den Kollegen: 'off' | 'pending' | 'on'
let hostCtrl = false;     // der Kollege steuert mich
let remoteVersion = null;

const log = (...a) => { console.log(...a); window.api.log(...a); };
window.addEventListener('error', (e) => log('JS-Fehler', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => log('Promise-Fehler', e.reason && (e.reason.stack || e.reason)));

function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; }
  return null;
}

function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.toast.classList.add('hidden'), ms);
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}
const peerIdFor = (code) => ID_PREFIX + code.toLowerCase();
const codeFromPeerId = (id) => id.slice(ID_PREFIX.length).toUpperCase();
const myName = () => el.myName.value.trim() || 'Unbekannt';

// ---------- SDP-Feinschliff: H.264 bevorzugen (Hardware-Encoder), Opus in Stereo mit hoher Bitrate ----------
function preferVideoCodec(sdp, codec) {
  const lines = sdp.split('\r\n');
  const m = lines.findIndex((l) => l.startsWith('m=video'));
  if (m < 0) return sdp;
  let end = lines.findIndex((l, i) => i > m && l.startsWith('m='));
  if (end < 0) end = lines.length;
  const pts = [];
  for (let i = m + 1; i < end; i++) {
    const r = lines[i].match(/^a=rtpmap:(\d+) ([\w-]+)\//);
    if (r && r[2].toUpperCase() === codec) pts.push(r[1]);
  }
  if (!pts.length) return sdp;
  const parts = lines[m].split(' ');
  lines[m] = [...parts.slice(0, 3), ...pts, ...parts.slice(3).filter((p) => !pts.includes(p))].join(' ');
  return lines.join('\r\n');
}

function tuneOpus(sdp) {
  const r = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!r) return sdp;
  const pt = r[1];
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params) => {
    let p = params;
    if (!/stereo=/.test(p)) p += ';stereo=1';
    if (!/sprop-stereo=/.test(p)) p += ';sprop-stereo=1';
    if (!/maxaveragebitrate=/.test(p)) p += ';maxaveragebitrate=192000';
    return `a=fmtp:${pt} ${p}`;
  });
}

const sdpTransform = (sdp) => tuneOpus(preferVideoCodec(sdp, 'H264'));

// ---------- Peer-Verbindung zum Vermittlungsserver ----------
function startPeer(attempt = 0) {
  peer = new Peer(peerIdFor(myCode), { debug: 1, config: { iceServers: ICE_SERVERS } });

  peer.on('open', () => {
    log('online als', myCode);
    el.myCode.textContent = myCode;
    if (opts.selftest) log('SELFTEST-CODE', myCode);
    setIdleText();
    if (opts.autoConnect) connectTo(opts.autoConnect);
  });

  peer.on('connection', onIncomingConnection);
  peer.on('call', onIncomingCall);

  peer.on('disconnected', () => {
    log('Vermittlung getrennt, verbinde neu');
    setTimeout(() => { if (peer && !peer.destroyed) peer.reconnect(); }, 1500);
  });

  peer.on('error', (err) => {
    log('peer error', err.type, err.message);
    switch (err.type) {
      case 'unavailable-id':
        // Code noch belegt (z. B. App gerade neu gestartet) – kurz warten, sonst neuer Code
        peer.destroy();
        if (attempt < 3) {
          el.myCode.textContent = '······';
          setTimeout(() => startPeer(attempt + 1), 4000);
        } else {
          myCode = randomCode();
          store('myCode', myCode);
          startPeer(0);
        }
        break;
      case 'peer-unavailable':
        toast('Code nicht gefunden – läuft die App beim Kollegen?');
        resetConnectUi();
        break;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        toast('Keine Verbindung zum Vermittlungsserver – versuche erneut …');
        break;
      default:
        toast(`Fehler: ${err.type}`);
    }
  });
}

// ---------- Verbinden ----------
function connectTo(rawCode) {
  const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) return toast('Der Code hat 6 Zeichen.');
  if (code === myCode) return toast('Das ist dein eigener Code 🙂');
  if (conn) return;
  el.connectBtn.disabled = true;
  el.connectBtn.textContent = 'Verbinde …';
  const c = peer.connect(peerIdFor(code), { reliable: true, metadata: { name: myName() } });
  setupConnection(c);
  setTimeout(() => {
    if (conn === c && !c.open) {
      toast('Verbindung fehlgeschlagen. Firewall oder Netzwerk blockiert evtl.');
      dropConnection(c);
    }
  }, 20000);
}

function onIncomingConnection(c) {
  if (conn && conn.open) {
    c.on('open', () => { c.send({ type: 'busy' }); setTimeout(() => c.close(), 500); });
    return;
  }
  if (conn && !conn.open) {
    // beide haben gleichzeitig auf Verbinden gedrückt: eine Verbindung gewinnt deterministisch
    if (peer.id < c.peer) { c.close(); return; }
    const old = conn;
    conn = null;
    old.close();
  }
  setupConnection(c);
}

function setupConnection(c) {
  conn = c;
  c.on('open', () => {
    if (conn !== c) return;
    remoteLabel = c.metadata?.name || codeFromPeerId(c.peer);
    c.send({ type: 'hello', name: myName(), version: opts.version });
    onConnected();
  });
  c.on('data', (msg) => { if (conn === c) handleMessage(msg); });
  c.on('close', () => { if (conn === c) onDisconnected('Verbindung beendet'); });
  c.on('error', (e) => log('conn error', e && e.message));
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'hello':
      remoteLabel = String(msg.name || remoteLabel).slice(0, 24);
      remoteVersion = msg.version ? String(msg.version).slice(0, 16) : null;
      log('Partner', remoteLabel, 'Version', remoteVersion || 'alt (< 1.1.2)');
      el.remoteName.textContent = remoteLabel;
      break;
    case 'busy':
      toast('Der Kollege ist schon mit jemand anderem verbunden.');
      dropConnection(conn);
      break;
    case 'share-stop':
      closeIncoming();
      break;
    case 'bye':
      onDisconnected(`${remoteLabel} hat getrennt`);
      break;
    // --- Fernsteuerung ---
    case 'control-request':
      log('Steuerungsanfrage empfangen');
      onControlRequest();
      break;
    case 'control-granted':
      log('Steuerung erhalten');
      if (viewerCtrl === 'pending' && inCall) setViewerCtrl('on');
      else send({ type: 'control-release' });
      break;
    case 'control-denied': {
      log('Steuerung abgelehnt, Grund:', msg.reason);
      const why = {
        window: `${remoteLabel} teilt nur ein Fenster. Steuerung geht nur bei ganzem Bildschirm.`,
        notsharing: `${remoteLabel} teilt gerade nichts.`,
        unsupported: 'Steuerung wird auf dem anderen PC nicht unterstützt.',
      }[msg.reason] || `${remoteLabel} hat die Steuerung abgelehnt.`;
      setViewerCtrl('off');
      toast(why, 4000);
      break;
    }
    case 'control-revoked':
      log('Steuerung entzogen');
      if (viewerCtrl !== 'off') { setViewerCtrl('off'); toast(`${remoteLabel} hat die Steuerung beendet.`); }
      break;
    case 'control-release':
      endHostControl(false);
      break;
    case 'in':
      if (hostCtrl) window.api.controlInput(msg.e);
      if (hostCtrl && opts.selftest) selftestHostInput(msg.e);
      break;
  }
}

function send(msg) {
  if (conn && conn.open) conn.send(msg);
}

// ---------- Fernsteuerung: ich werde gesteuert ----------
async function onControlRequest() {
  if (!outCall) return send({ type: 'control-denied', reason: 'notsharing' });
  const res = await window.api.controlAsk(remoteLabel);
  if (res === 'granted' && outCall && conn && conn.open) {
    hostCtrl = true;
    el.revokeBtn.classList.remove('hidden');
    send({ type: 'control-granted' });
    log('Steuerung erlaubt');
  } else {
    if (res === 'granted') window.api.controlEnd();
    send({ type: 'control-denied', reason: res });
  }
}

function endHostControl(notify) {
  if (!hostCtrl) return;
  hostCtrl = false;
  window.api.controlEnd();
  el.revokeBtn.classList.add('hidden');
  if (notify) send({ type: 'control-revoked' });
  log('Steuerung beendet');
}

window.api.onControlEndedLocal(() => {
  if (!hostCtrl) return;
  hostCtrl = false;
  el.revokeBtn.classList.add('hidden');
  send({ type: 'control-revoked' });
  toast('Steuerung beendet');
});

// ---------- Fernsteuerung: ich steuere ----------
let ctrlTimer = null;
const viewerKeys = new Set();

function setViewerCtrl(state) {
  const was = viewerCtrl;
  viewerCtrl = state;
  clearTimeout(ctrlTimer);
  if (was === 'on' && state !== 'on') {
    sendInput({ t: 'rel' });
    viewerKeys.clear();
  }
  el.stage.classList.toggle('controlling', state === 'on');
  el.ctrlBadge.classList.toggle('hidden', state !== 'on');
  el.controlBtn.classList.toggle('hidden', !inCall);
  el.controlBtn.disabled = state === 'pending';
  el.controlBtn.classList.toggle('active-ctrl', state === 'on');
  el.controlBtn.textContent = { off: 'Steuerung anfragen', pending: 'Angefragt …', on: 'Steuerung abgeben' }[state];
  if (state === 'on') {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    toast(`Du steuerst jetzt den PC von ${remoteLabel}`);
    if (opts.selftest) selftestViewerControl();
  }
}

function requestControl() {
  if (viewerCtrl === 'on') {
    send({ type: 'control-release' });
    setViewerCtrl('off');
    return;
  }
  if (viewerCtrl === 'pending' || !inCall) return;
  send({ type: 'control-request' });
  log('Steuerung angefragt; Partner-Version', remoteVersion || 'alt');
  setViewerCtrl('pending');
  toast(`Anfrage gesendet – ${remoteLabel} muss zustimmen.`);
  ctrlTimer = setTimeout(() => {
    if (viewerCtrl !== 'pending') return;
    setViewerCtrl('off');
    log('Steuerungsanfrage ohne Antwort');
    toast(remoteVersion ? 'Keine Antwort auf die Anfrage.' : `Keine Antwort – ${remoteLabel} hat vermutlich eine alte Version (in Claude „ScreenLink updaten“).`, 7000);
  }, 65000);
}

function sendInput(e) {
  send({ type: 'in', e });
}

// Position im Video (object-fit: contain) → 0..1 relativ zum geteilten Bildschirm
function normPos(ev) {
  const v = el.remoteVideo;
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  const x = (ev.clientX - r.left - (r.width - w) / 2) / w;
  const y = (ev.clientY - r.top - (r.height - h) / 2) / h;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}

let pendingMove = null;
let moveScheduled = false;
function queueMove(p) {
  pendingMove = p;
  if (moveScheduled) return;
  moveScheduled = true;
  requestAnimationFrame(() => {
    moveScheduled = false;
    if (pendingMove && viewerCtrl === 'on') sendInput({ t: 'mm', x: +pendingMove.x.toFixed(5), y: +pendingMove.y.toFixed(5) });
    pendingMove = null;
  });
}

el.remoteVideo.addEventListener('pointermove', (ev) => {
  if (viewerCtrl !== 'on') return;
  const p = normPos(ev);
  if (p && (p.inside || el.remoteVideo.hasPointerCapture(ev.pointerId))) queueMove(p);
});
el.remoteVideo.addEventListener('pointerdown', (ev) => {
  if (viewerCtrl !== 'on') return;
  const p = normPos(ev);
  if (!p || !p.inside) return;
  ev.preventDefault();
  el.remoteVideo.setPointerCapture(ev.pointerId);
  sendInput({ t: 'mm', x: p.x, y: p.y });
  sendInput({ t: 'md', b: ev.button });
});
el.remoteVideo.addEventListener('pointerup', (ev) => {
  if (viewerCtrl !== 'on') return;
  ev.preventDefault();
  const p = normPos(ev);
  if (p) sendInput({ t: 'mm', x: p.x, y: p.y });
  sendInput({ t: 'mu', b: ev.button });
});
el.remoteVideo.addEventListener('wheel', (ev) => {
  if (viewerCtrl !== 'on') return;
  ev.preventDefault();
  const f = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? 800 : 1.2; // 100 px ≈ 1 Raste (120)
  sendInput({ t: 'wh', dy: Math.round(-ev.deltaY * f), dx: Math.round(ev.deltaX * f) });
}, { passive: false });
el.remoteVideo.addEventListener('contextmenu', (ev) => { if (viewerCtrl === 'on') ev.preventDefault(); });
el.remoteVideo.addEventListener('auxclick', (ev) => { if (viewerCtrl === 'on') ev.preventDefault(); });

function typingLocally() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
}
window.addEventListener('keydown', (ev) => {
  if (viewerCtrl !== 'on' || typingLocally() || !el.picker.classList.contains('hidden')) return;
  if (ev.code === 'F11') return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  viewerKeys.add(ev.code);
  sendInput({ t: 'kd', c: ev.code });
}, true);
window.addEventListener('keyup', (ev) => {
  if (viewerCtrl !== 'on' || !viewerKeys.has(ev.code)) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  viewerKeys.delete(ev.code);
  sendInput({ t: 'ku', c: ev.code });
}, true);
window.addEventListener('blur', () => {
  if (viewerCtrl === 'on' && viewerKeys.size) { sendInput({ t: 'rel' }); viewerKeys.clear(); }
});

function onConnected() {
  log('verbunden mit', conn.peer);
  el.remoteName.textContent = remoteLabel;
  el.connectBox.classList.add('hidden');
  el.connectedBox.classList.remove('hidden');
  el.shareBtn.disabled = false;
  resetConnectUi();
  setIdleText();
  toast(`Verbunden mit ${remoteLabel}`);
  setTimeout(() => { if (conn && conn.open && !remoteVersion) toast(`${remoteLabel} nutzt eine alte ScreenLink-Version. Für Steuerung bitte updaten.`, 6000); }, 3000);
  if (opts.autoShare) autoShare();
}

function dropConnection(c) {
  if (!c) return;
  if (conn === c) conn = null;
  try { c.close(); } catch {}
  resetConnectUi();
}

function onDisconnected(reason) {
  const c = conn;
  conn = null;
  try { c && c.close(); } catch {}
  endHostControl(false);
  stopSharing(false);
  closeIncoming();
  el.connectBox.classList.remove('hidden');
  el.connectedBox.classList.add('hidden');
  el.shareBtn.disabled = true;
  resetConnectUi();
  setIdleText();
  if (reason) toast(reason);
}

function resetConnectUi() {
  el.connectBtn.disabled = false;
  el.connectBtn.textContent = 'Verbinden';
}

function setIdleText() {
  if (inCall) return;
  el.placeholder.classList.remove('hidden');
  if (conn && conn.open) {
    el.placeholderTitle.textContent = `Verbunden mit ${remoteLabel}`;
    el.placeholderText.textContent = 'Sobald einer von euch teilt, erscheint das Bild hier.';
  } else {
    el.placeholderTitle.textContent = 'Noch nicht verbunden';
    el.placeholderText.textContent = 'Gib den Code deines Kollegen ein oder schick ihm deinen.';
  }
}

// ---------- Quelle wählen ----------
let pickerKind = 'screen';
let pickerResolve = null;

async function pickSource() {
  el.picker.classList.remove('hidden');
  await renderSources();
  return new Promise((resolve) => { pickerResolve = resolve; });
}

async function renderSources() {
  el.sourceGrid.innerHTML = '<div style="color:var(--muted)">Lade …</div>';
  const sources = await window.api.getSources();
  const list = sources.filter((s) => (pickerKind === 'screen') === s.isScreen);
  el.sourceGrid.innerHTML = '';
  if (!list.length) el.sourceGrid.innerHTML = '<div style="color:var(--muted)">Nichts gefunden.</div>';
  list.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'source';
    const media = s.thumb ? document.createElement('img') : document.createElement('div');
    if (s.thumb) media.src = s.thumb; else media.className = 'noimg';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = s.isScreen ? (list.length > 1 ? `Bildschirm ${i + 1}` : 'Ganzer Bildschirm') : s.name;
    t.title = s.name;
    b.append(media, t);
    b.onclick = () => closePicker(s.id);
    el.sourceGrid.append(b);
  });
}

function closePicker(id) {
  el.picker.classList.add('hidden');
  if (pickerResolve) { pickerResolve(id); pickerResolve = null; }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    pickerKind = tab.dataset.kind;
    renderSources();
  };
});
el.pickerClose.onclick = () => closePicker(null);

// ---------- Teilen ----------
async function startSharing(sourceId) {
  if (!conn || !conn.open || outCall) return;
  const q = QUALITY[el.quality.value];
  try {
    localStream = await captureWithFallback(sourceId, q, el.sendAudio.checked);
  } catch (e) {
    log('Aufnahme endgültig fehlgeschlagen', e.name, e.message);
    toast(`Bildschirm konnte nicht aufgenommen werden (${e.name}: ${e.message}). Details stehen in der Logdatei.`, 9000);
    return;
  }

  const vTrack = localStream.getVideoTracks()[0];
  vTrack.contentHint = el.mode.value;
  vTrack.onended = () => stopSharing(true);
  if (!el.sendAudio.checked) localStream.getAudioTracks().forEach((t) => { t.stop(); localStream.removeTrack(t); });
  window.api.setShareInfo({ w: vTrack.getSettings().width, h: vTrack.getSettings().height });
  log('teile', vTrack.getSettings().width + 'x' + vTrack.getSettings().height, 'audio:', localStream.getAudioTracks().length);

  el.localVideo.srcObject = localStream;
  el.previewBox.classList.remove('hidden');
  el.shareBtn.classList.add('hidden');
  el.stopBtn.classList.remove('hidden');

  outCall = peer.call(conn.peer, localStream, { sdpTransform, metadata: { name: myName() } });
  const call = outCall;
  const pc = call.peerConnection;
  const onState = () => {
    log('Sende-Verbindung', pc.connectionState);
    if (pc.connectionState === 'connected') applySenderParams();
    if (pc.connectionState === 'failed' && outCall === call) {
      toast('Übertragung fehlgeschlagen (Netzwerk/NAT).');
      stopSharing(true);
    }
  };
  pc.addEventListener('connectionstatechange', onState);
  call.on('close', () => { if (outCall === call) stopSharing(false); });
  call.on('error', (e) => log('call error', e && e.message));
}

// Aufnahme mit Ausweichwegen: 1) mit Ton  2) ohne Ton  3) alter Capture-Weg (mit/ohne Ton)
async function captureWithFallback(sourceId, q, wantAudio) {
  const isScreen = sourceId.startsWith('screen:');
  const forced = opts.captureMode; // nur für Tests: 'legacy' | 'noaudio'
  const modern = async (audio) => {
    await window.api.selectSource(sourceId, audio);
    return navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.width, max: q.width }, height: { ideal: q.height, max: q.height }, frameRate: { ideal: q.fps, max: q.fps } },
      audio,
    });
  };
  const legacy = async (audio) => (await window.api.selectSource(sourceId, audio)) && navigator.mediaDevices.getUserMedia({
    audio: audio && isScreen ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: q.width, maxHeight: q.height, maxFrameRate: q.fps } },
  });

  const attempts = [];
  if (forced !== 'legacy') {
    if (wantAudio && forced !== 'noaudio') attempts.push(['modern+ton', () => modern(true)]);
    attempts.push(['modern', () => modern(false)]);
  }
  if (wantAudio && isScreen) attempts.push(['alt+ton', () => legacy(true)]);
  attempts.push(['alt', () => legacy(false)]);

  let lastErr = null;
  for (const [name, fn] of attempts) {
    try {
      const s = await fn();
      if (!s.getVideoTracks().length) throw new Error('kein Videobild');
      log('Aufnahme ok über', name, 'audio:', s.getAudioTracks().length);
      if (wantAudio && !s.getAudioTracks().length) toast('Ton konnte nicht aufgenommen werden, teile ohne Ton.', 5000);
      return s;
    } catch (e) {
      lastErr = e;
      log('Aufnahme-Versuch fehlgeschlagen:', name, e.name, e.message);
    }
  }
  throw lastErr || new Error('unbekannt');
}

async function applySenderParams() {
  if (!outCall || !localStream) return;
  const q = QUALITY[el.quality.value];
  const vTrack = localStream.getVideoTracks()[0];
  if (vTrack) {
    vTrack.contentHint = el.mode.value;
    try {
      await vTrack.applyConstraints({ width: { ideal: q.width, max: q.width }, height: { ideal: q.height, max: q.height }, frameRate: { ideal: q.fps, max: q.fps } });
    } catch (e) { log('applyConstraints', e.message); }
  }
  for (const sender of outCall.peerConnection.getSenders()) {
    if (!sender.track) continue;
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (sender.track.kind === 'video') {
      p.encodings[0].maxBitrate = q.bitrate;
      p.encodings[0].maxFramerate = q.fps;
      p.degradationPreference = el.mode.value === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
    } else {
      p.encodings[0].maxBitrate = 192_000;
    }
    try { await sender.setParameters(p); } catch (e) { log('setParameters', e.message); }
  }
}

function stopSharing(notify) {
  endHostControl(notify);
  if (notify && conn && conn.open) conn.send({ type: 'share-stop' });
  const call = outCall;
  outCall = null;
  if (call) { try { call.close(); } catch {} }
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  el.localVideo.srcObject = null;
  el.previewBox.classList.add('hidden');
  el.stopBtn.classList.add('hidden');
  el.shareBtn.classList.remove('hidden');
}

// ---------- Empfangen ----------
function onIncomingCall(call) {
  if (!conn || !conn.open || call.peer !== conn.peer) { call.close(); return; }
  closeIncoming();
  inCall = call;
  call.answer(undefined, { sdpTransform });
  call.on('stream', (stream) => {
    if (inCall !== call || el.remoteVideo.srcObject === stream) return;
    log('Stream empfangen', 'video:', stream.getVideoTracks().length, 'audio:', stream.getAudioTracks().length);
    el.remoteVideo.srcObject = stream;
    el.remoteVideo.volume = Number(el.volume.value);
    el.remoteVideo.play().catch((e) => log('play', e.message));
    el.placeholder.classList.add('hidden');
    setViewerCtrl('off');
    if (opts.selftest) setTimeout(() => selftestReport(call), 6000);
    if (opts.autoControl) setTimeout(requestControl, 9000);
  });
  call.peerConnection.addEventListener('connectionstatechange', () => {
    const s = call.peerConnection.connectionState;
    log('Empfangs-Verbindung', s);
    if ((s === 'failed' || s === 'closed') && inCall === call) closeIncoming();
  });
  call.on('close', () => { if (inCall === call) closeIncoming(); });
}

function closeIncoming() {
  const call = inCall;
  inCall = null;
  if (call) { try { call.close(); } catch {} }
  if (viewerCtrl !== 'off') send({ type: 'control-release' });
  setViewerCtrl('off');
  el.remoteVideo.srcObject = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setIdleText();
}

// ---------- Statistik ----------
const prevBytes = {};
async function collectStats(pc, direction) {
  const report = await pc.getStats();
  const out = {};
  let pair = null;
  report.forEach((s) => {
    if (s.type === direction && s.kind === 'video') {
      out.w = s.frameWidth; out.h = s.frameHeight; out.fps = s.framesPerSecond;
      out.vbytes = s.bytesSent ?? s.bytesReceived; out.codecId = s.codecId;
      out.limit = s.qualityLimitationReason;
      out.encoder = s.encoderImplementation; out.decoder = s.decoderImplementation;
    }
    if (s.type === direction && s.kind === 'audio') out.abytes = s.bytesSent ?? s.bytesReceived;
    if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
  });
  if (out.codecId) { const c = report.get(out.codecId); out.codec = c && c.mimeType; }
  if (pair) {
    out.rtt = pair.currentRoundTripTime;
    const local = report.get(pair.localCandidateId);
    out.route = local ? local.candidateType : '?';
  }
  const key = direction;
  const now = performance.now();
  if (prevBytes[key] && out.vbytes != null) {
    out.kbps = Math.round(((out.vbytes - prevBytes[key].b) * 8) / (now - prevBytes[key].t));
  }
  prevBytes[key] = { b: out.vbytes || 0, t: now };
  return out;
}

function fmtStats(label, s) {
  const route = { host: 'direkt (LAN)', srflx: 'direkt (Internet)', prflx: 'direkt', relay: 'Relay' }[s.route] || s.route || '?';
  const lines = [
    `${label}: ${s.w || '?'}x${s.h || '?'} @ ${s.fps ?? '?'} fps`,
    `Codec: ${(s.codec || '?').replace('video/', '')} ${s.encoder || s.decoder ? '· ' + (s.encoder || s.decoder) : ''}`,
    `Bitrate: ${s.kbps != null ? (s.kbps / 1000).toFixed(1) + ' Mbit/s' : '…'}`,
    `Ping: ${s.rtt != null ? Math.round(s.rtt * 1000) + ' ms' : '?'} · ${route}`,
  ];
  if (s.limit && s.limit !== 'none') lines.push(`Begrenzt durch: ${s.limit}`);
  return lines.join('\n');
}

setInterval(async () => {
  if (!statsVisible) return;
  const parts = [];
  try {
    if (inCall) parts.push(fmtStats('Empfang', await collectStats(inCall.peerConnection, 'inbound-rtp')));
    if (outCall) parts.push(fmtStats('Senden', await collectStats(outCall.peerConnection, 'outbound-rtp')));
  } catch {}
  el.stats.textContent = parts.join('\n\n') || 'Keine Übertragung aktiv';
}, 1000);

// ---------- Selbsttest (nur mit --selftest / --auto-share) ----------
async function autoShare() {
  const sources = await window.api.getSources();
  const screen = sources.find((s) => s.isScreen);
  if (screen) setTimeout(() => startSharing(screen.id), 1000);
}

async function selftestReport(call) {
  const pc = call.peerConnection;
  await collectStats(pc, 'inbound-rtp');
  await new Promise((r) => setTimeout(r, 2000));
  const s = await collectStats(pc, 'inbound-rtp');
  log('SELFTEST-RECV', JSON.stringify({ ...s, audioTracks: el.remoteVideo.srcObject?.getAudioTracks().length }));
}

// Zuschauer: Maus in die Mitte, dann ein harmloser Shift-Tastendruck, dann abgeben
function selftestViewerControl() {
  log('SELFTEST-CTRL granted');
  setTimeout(() => sendInput({ t: 'mm', x: 0.5, y: 0.5 }), 500);
  setTimeout(() => { sendInput({ t: 'kd', c: 'ShiftLeft' }); sendInput({ t: 'ku', c: 'ShiftLeft' }); }, 1000);
  setTimeout(() => requestControl(), 2500); // = abgeben
}

let selftestLogged = false;
async function selftestHostInput(e) {
  if (e.t !== 'mm' || selftestLogged) return;
  selftestLogged = true;
  setTimeout(async () => log('SELFTEST-CURSOR', JSON.stringify(await window.api.cursorPos()), 'für', JSON.stringify(e)), 200);
}

// ---------- UI-Verdrahtung ----------
el.connectBtn.onclick = () => connectTo(el.remoteCode.value);
el.remoteCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectTo(el.remoteCode.value); });
el.remoteCode.addEventListener('input', () => { el.remoteCode.value = el.remoteCode.value.toUpperCase(); });
el.disconnectBtn.onclick = () => {
  if (conn && conn.open) conn.send({ type: 'bye' });
  setTimeout(() => onDisconnected(null), 150);
};
el.copyBtn.onclick = async () => {
  try { await navigator.clipboard.writeText(myCode); toast('Code kopiert'); } catch { toast(myCode); }
};
el.myName.value = store('myName') || '';
el.myName.addEventListener('change', () => {
  store('myName', el.myName.value.trim());
  if (conn && conn.open) conn.send({ type: 'hello', name: myName(), version: opts.version });
});
el.shareBtn.onclick = async () => {
  const id = await pickSource();
  if (id) startSharing(id);
};
el.stopBtn.onclick = () => stopSharing(true);
el.controlBtn.onclick = requestControl;
el.revokeBtn.onclick = () => { endHostControl(true); toast('Steuerung entzogen'); };
el.quality.onchange = () => { store('quality', el.quality.value); applySenderParams(); };
el.mode.onchange = () => { store('mode', el.mode.value); applySenderParams(); };
el.sendAudio.onchange = () => store('sendAudio', el.sendAudio.checked ? '1' : '0');
el.volume.oninput = () => { el.remoteVideo.volume = Number(el.volume.value); store('volume', el.volume.value); };
el.statsBtn.onclick = () => { statsVisible = !statsVisible; el.stats.classList.toggle('hidden', !statsVisible); };
const toggleFullscreen = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.stage.requestFullscreen().catch(() => {});
};
el.fullscreenBtn.onclick = toggleFullscreen;
el.remoteVideo.ondblclick = () => { if (viewerCtrl !== 'on') toggleFullscreen(); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
  if (e.key === 'Escape' && !el.picker.classList.contains('hidden')) closePicker(null);
});
window.addEventListener('beforeunload', () => {
  try { if (conn && conn.open) conn.send({ type: 'bye' }); } catch {}
  try { peer && peer.destroy(); } catch {}
});

// gespeicherte Einstellungen
if (QUALITY[store('quality')]) el.quality.value = store('quality');
if (store('mode')) el.mode.value = store('mode');
if (store('sendAudio') === '0') el.sendAudio.checked = false;
if (store('volume') != null) el.volume.value = store('volume');

// ---------- Start ----------
(async () => {
  opts = await window.api.launchOptions();
  log('ScreenLink', opts.version, navigator.userAgent);
  myCode = store('myCode');
  if (!myCode || myCode.length !== 6) { myCode = randomCode(); store('myCode', myCode); }
  if (opts.selftest && !store('myName')) el.myName.value = opts.profile || 'Test';
  startPeer();
})();
