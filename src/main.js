const { app, BrowserWindow, ipcMain, desktopCapturer, session, screen, globalShortcut } = require('electron');
const path = require('path');

let input = null;
try {
  if (process.platform === 'win32') input = require('./input');
} catch (e) {
  console.error('Eingabemodul nicht verfügbar', e);
}

// --- Startoptionen (für Tests: zwei Instanzen auf einem PC) ---
function argValue(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}
const profile = argValue('profile');
if (profile) {
  app.setPath('userData', path.join(app.getPath('appData'), `ScreenLink-${profile}`));
}
const launchOptions = {
  profile,
  autoConnect: argValue('auto-connect'),
  autoShare: process.argv.includes('--auto-share'),
  autoControl: process.argv.includes('--auto-control'),
  selftest: process.argv.includes('--selftest'),
  captureMode: argValue('capture'),
  version: app.getVersion(),
};

// --- Logdatei: %APPDATA%\ScreenLink\screenlink.log (bei jedem Start neu) ---
const fs = require('fs');
const os = require('os');
let logStream = null;
try {
  const logFile = path.join(app.getPath('userData'), 'screenlink.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  logStream = fs.createWriteStream(logFile, { flags: 'w' });
  launchOptions.logFile = logFile;
} catch {}
for (const level of ['log', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    orig(...a);
    if (logStream) {
      const line = a.map((x) => (x instanceof Error ? x.stack : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
      logStream.write(`${new Date().toISOString()} ${level === 'error' ? 'FEHLER ' : ''}${line}\n`);
    }
  };
}
// --- Einstellungen + Kompatibilitätsmodus (WGC aus → DirectX/GDI-Capturer) ---
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
launchOptions.compat = !!settings.compat || process.argv.includes('--compat');
if (launchOptions.compat) {
  app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer,AllowWgcWindowCapturer,AllowWgcZeroHz');
}
console.log(`ScreenLink ${app.getVersion()} · Kompatibilitätsmodus: ${launchOptions.compat ? 'AN' : 'aus'} · Electron ${process.versions.electron} · Windows ${os.release()} · ${os.cpus()[0]?.model}`);
process.on('uncaughtException', (e) => console.error('uncaught', e));

// Ton des Partners ohne Klick abspielen
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const STOP_SHORTCUT = 'Control+Alt+Shift+S';

let win = null;
let overlay = null;
let selectedSourceId = null;
let selectedAudio = true;
let sharedSource = null; // tatsächlich geteilte Quelle (mit display_id)

const control = {
  active: false,
  name: '',
  display: null,
  keys: new Set(),
  buttons: new Set(),
};

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#0f1115',
    title: 'ScreenLink',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('closed', () => { endControl('closed'); win = null; });
}

// ---------- Fernsteuerung (Seite, die geteilt wird) ----------
let shareSize = null; // tatsächliche Größe des geteilten Videos {w, h}

// Monitor zur geteilten Quelle finden: display_id → Auflösung → Seitenverhältnis → Hauptmonitor
function displayForSource(src) {
  if (!src || !src.id.startsWith('screen:')) return null;
  const ds = screen.getAllDisplays();
  let d = ds.find((x) => src.display_id && String(x.id) === String(src.display_id));
  let how = 'display_id';
  if (!d && ds.length === 1) { d = ds[0]; how = 'einziger Monitor'; }
  if (!d && shareSize) {
    const phys = (x) => ({ w: Math.round(x.bounds.width * x.scaleFactor), h: Math.round(x.bounds.height * x.scaleFactor) });
    const exact = ds.filter((x) => Math.abs(phys(x).w - shareSize.w) <= 2 && Math.abs(phys(x).h - shareSize.h) <= 2);
    if (exact.length === 1) { d = exact[0]; how = 'Auflösung'; }
    if (!d) {
      const ar = shareSize.w / shareSize.h;
      const same = ds.filter((x) => Math.abs(x.bounds.width / x.bounds.height - ar) < 0.02);
      if (same.length === 1) { d = same[0]; how = 'Seitenverhältnis'; }
    }
  }
  if (!d) { d = screen.getPrimaryDisplay(); how = 'Hauptmonitor (Notlösung)'; }
  console.log(`[${profile || 'main'}] Monitor für ${src.id} (display_id="${src.display_id}") über ${how}: ${d.id} ${JSON.stringify(d.bounds)} x${d.scaleFactor}`);
  return d;
}

// ---------- Anfrage-Fenster (immer im Vordergrund, nicht im Stream sichtbar) ----------
let requestWin = null;
let requestResolve = null;

function askViaWindow(name, display, timeoutSec) {
  return new Promise((resolve) => {
    closeRequestWindow(false);
    requestResolve = resolve;
    const w = 460, h = 180;
    const b = display.workArea;
    requestWin = new BrowserWindow({
      x: Math.round(b.x + (b.width - w) / 2),
      y: Math.round(b.y + (b.height - h) / 2),
      width: w,
      height: h,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: false,
      alwaysOnTop: true,
      show: false,
      title: 'ScreenLink – Steuerungsanfrage',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    requestWin.setAlwaysOnTop(true, 'screen-saver');
    requestWin.setContentProtection(true);
    requestWin.loadFile(path.join(__dirname, 'request.html'), { query: { name, timeout: String(timeoutSec) } });
    requestWin.once('ready-to-show', () => {
      if (!requestWin) return;
      requestWin.show();
      requestWin.focus();
      requestWin.moveTop();
      if (launchOptions.selftest && process.argv.includes('--real-ask')) {
        console.log(`[${profile}] SELFTEST Anfrage-Fenster sichtbar: ${requestWin.isVisible()}, oben: ${requestWin.isAlwaysOnTop()}`);
        setTimeout(() => requestWin && requestWin.webContents.executeJavaScript("document.getElementById('yes').click()"), 1500);
      }
    });
    requestWin.on('closed', () => { requestWin = null; closeRequestWindow(false); });
    setTimeout(() => closeRequestWindow(false), (timeoutSec + 2) * 1000);
  });
}

function closeRequestWindow(answer) {
  const r = requestResolve;
  requestResolve = null;
  if (requestWin && !requestWin.isDestroyed()) requestWin.destroy();
  requestWin = null;
  if (r) r(answer);
}

function showOverlay(display, name) {
  hideOverlay();
  const w = 520, h = 44;
  const b = display.workArea;
  overlay = new BrowserWindow({
    x: Math.round(b.x + (b.width - w) / 2),
    y: b.y + 8,
    width: w,
    height: h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setContentProtection(true); // nicht im Stream sichtbar
  overlay.loadFile(path.join(__dirname, 'overlay.html'), { query: { name } });
  overlay.once('ready-to-show', () => overlay && overlay.showInactive());
}

function hideOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}

function releaseAll() {
  if (!input) return;
  for (const code of control.keys) { try { input.sendKey(code, true); } catch {} }
  for (const b of control.buttons) { try { input.mouseButton(b, true); } catch {} }
  control.keys.clear();
  control.buttons.clear();
}

function startControl(name) {
  control.active = true;
  control.name = name;
  control.display = displayForSource(sharedSource);
  try { globalShortcut.register(STOP_SHORTCUT, () => endControl('shortcut')); } catch {}
  showOverlay(control.display || screen.getPrimaryDisplay(), name);
  console.log(`[${profile || 'main'}] Steuerung aktiv für ${name}, Display ${control.display && control.display.id}`);
}

// reason: 'shortcut' | 'overlay' → lokal beendet, Renderer informieren
function endControl(reason) {
  if (!control.active) return;
  releaseAll();
  control.active = false;
  control.display = null;
  try { globalShortcut.unregister(STOP_SHORTCUT); } catch {}
  hideOverlay();
  console.log(`[${profile || 'main'}] Steuerung beendet (${reason})`);
  if ((reason === 'shortcut' || reason === 'overlay') && win && !win.isDestroyed()) {
    win.webContents.send('control-ended-local');
  }
}

function handleInput(e) {
  if (!control.active || !input || !e || typeof e !== 'object') return;
  const d = control.display;
  switch (e.t) {
    case 'mm': {
      if (!d) return;
      const nx = Math.min(1, Math.max(0, Number(e.x)));
      const ny = Math.min(1, Math.max(0, Number(e.y)));
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
      const dip = { x: d.bounds.x + nx * (d.bounds.width - 1), y: d.bounds.y + ny * (d.bounds.height - 1) };
      const p = screen.dipToScreenPoint ? screen.dipToScreenPoint(dip) : dip;
      const ok = input.moveTo(p.x, p.y);
      if (launchOptions.selftest) console.log(`[${profile}] moveTo ${Math.round(p.x)},${Math.round(p.y)} -> ${ok} jetzt ${JSON.stringify(input.cursorPos())}`);
      break;
    }
    case 'md':
    case 'mu': {
      const b = Number(e.b);
      if (!(b >= 0 && b <= 4)) return;
      if (e.t === 'md') control.buttons.add(b); else control.buttons.delete(b);
      input.mouseButton(b, e.t === 'mu');
      break;
    }
    case 'wh': {
      const dy = Math.max(-2400, Math.min(2400, Number(e.dy) || 0));
      const dx = Math.max(-2400, Math.min(2400, Number(e.dx) || 0));
      input.wheel(dy, dx);
      break;
    }
    case 'kd':
    case 'ku': {
      const code = String(e.c || '');
      if (!input.hasKey(code)) return;
      if (e.t === 'kd') control.keys.add(code); else control.keys.delete(code);
      input.sendKey(code, e.t === 'ku');
      break;
    }
    case 'rel':
      releaseAll();
      break;
  }
}

app.whenReady().then(() => {
  app.getGPUInfo('basic')
    .then((g) => console.log('GPU', JSON.stringify((g.gpuDevice || []).map((d) => ({ vendor: d.vendorId, device: d.deviceId, active: d.active, driver: d.driverVersion })))))
    .catch(() => {});
  console.log('Displays', JSON.stringify(screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor }))));
  // Liefert die in der App ausgewählte Quelle an getDisplayMedia, inkl. Systemton
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src =
        sources.find((s) => s.id === selectedSourceId) ||
        sources.find((s) => s.id.startsWith('screen:'));
      if (!src) return callback({});
      sharedSource = src;
      const result = { video: src };
      if (process.platform === 'win32' && selectedAudio) result.audio = 'loopback';
      console.log(`[${profile || 'main'}] Aufnahme-Anfrage: ${src.id} (${src.name}) Ton: ${!!result.audio}`);
      callback(result);
    } catch (e) {
      console.error('display media handler', e);
      callback({});
    }
  });

  ipcMain.handle('get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 400, height: 225 },
      fetchWindowIcons: false,
    });
    return sources
      .filter((s) => !s.name.startsWith('ScreenLink'))
      .map((s) => ({
        id: s.id,
        name: s.name,
        isScreen: s.id.startsWith('screen:'),
        thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      }));
  });

  ipcMain.handle('select-source', async (_e, id, audio) => {
    selectedSourceId = id;
    selectedAudio = audio !== false;
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      sharedSource = sources.find((s) => s.id === id) || sharedSource;
    } catch (e) { console.log('getSources', e.message); }
    return true;
  });

  ipcMain.handle('launch-options', () => launchOptions);

  ipcMain.on('set-compat', (_e, on) => {
    settings.compat = !!on;
    try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.error('settings', e); }
    console.log(`Kompatibilitätsmodus ${on ? 'AN' : 'aus'} – Neustart`);
    const args = process.argv.slice(1).filter((a) => a !== '--compat');
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    app.relaunch(portable ? { execPath: portable, args: [] } : { args });
    app.exit(0);
  });

  ipcMain.on('log', (_e, msg) => {
    console.log(`[${profile || 'main'}] ${msg}`);
  });

  // Steuerungsanfrage vom Partner: Nutzer fragen. Rückgabe: 'granted' | 'denied' | 'window' | 'unsupported'
  ipcMain.handle('control-ask', async (_e, rawName) => {
    const name = String(rawName || 'Dein Partner').slice(0, 24);
    const tag = `[${profile || 'main'}]`;
    console.log(`${tag} Steuerungsanfrage von ${name}; Quelle ${sharedSource && sharedSource.id}; Eingabemodul ${input ? 'ok' : 'FEHLT'}`);
    if (!input) return 'unsupported';
    if (!sharedSource || !sharedSource.id.startsWith('screen:')) return 'window';
    if (control.active) return 'granted';
    const realAsk = process.argv.includes('--real-ask');
    if (launchOptions.selftest && launchOptions.autoShare && !realAsk) { startControl(name); return 'granted'; }

    const display = displayForSource(sharedSource) || screen.getPrimaryDisplay();
    if (win) win.flashFrame(true);
    const ok = await askViaWindow(name, display, 60);
    if (win) win.flashFrame(false);
    console.log(`${tag} Antwort auf Steuerungsanfrage: ${ok ? 'erlaubt' : 'abgelehnt/abgelaufen'}`);
    if (!ok) return 'denied';
    if (!sharedSource || !sharedSource.id.startsWith('screen:')) return 'window';
    startControl(name);
    return 'granted';
  });

  ipcMain.on('control-answer', (e, ok) => {
    if (requestWin && e.sender === requestWin.webContents) closeRequestWindow(!!ok);
  });
  ipcMain.on('share-info', (_e, info) => {
    if (info && info.w > 0 && info.h > 0) shareSize = { w: Number(info.w), h: Number(info.h) };
  });
  ipcMain.on('control-end', () => { closeRequestWindow(false); endControl('renderer'); });
  ipcMain.on('control-stop-local', () => endControl('overlay'));
  ipcMain.on('control-input', (_e, ev) => {
    try { handleInput(ev); } catch (err) { console.error('input', err); }
  });
  ipcMain.handle('cursor-pos', () => (input ? input.cursorPos() : null));

  createWindow();
});

app.on('will-quit', () => { endControl('quit'); globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => app.quit());
