const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('path');

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
  selftest: process.argv.includes('--selftest'),
};

// Ton des Partners ohne Klick abspielen
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let selectedSourceId = null;

function createWindow() {
  const win = new BrowserWindow({
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
}

app.whenReady().then(() => {
  // Liefert die in der App ausgewählte Quelle an getDisplayMedia, inkl. Systemton
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src =
        sources.find((s) => s.id === selectedSourceId) ||
        sources.find((s) => s.id.startsWith('screen:'));
      if (!src) return callback({});
      const result = { video: src };
      if (process.platform === 'win32') result.audio = 'loopback';
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

  ipcMain.handle('select-source', (_e, id) => {
    selectedSourceId = id;
    return true;
  });

  ipcMain.handle('launch-options', () => launchOptions);

  ipcMain.on('log', (_e, msg) => {
    console.log(`[${profile || 'main'}] ${msg}`);
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
