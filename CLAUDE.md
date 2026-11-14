# ScreenLink

Electron-App für 1:1-Bildschirmübertragung mit Systemton zwischen zwei PCs
(wie Discord-Stream). Projekt-Notiz: `ScreenLink.md` im Obsidian-Vault.

- `src/main.js` – Fenster, `setDisplayMediaRequestHandler` (Quelle + `audio: 'loopback'`), IPC.
- `src/renderer.js` – PeerJS (Cloud-Vermittlung 0.peerjs.com), Code-System, WebRTC-Call,
  SDP-Tuning (H.264 bevorzugt, Opus stereo 192 kbit/s), Bitrate per `setParameters`, Stats.
- Peer-ID = `screenlink-v1-` + 6-stelliger Code (in localStorage gespeichert).
- Release: `npm run dist`, dann `gh release create vX.Y.Z dist/ScreenLink.exe` (Download-URL für Maxis Claude: `releases/latest/download/ScreenLink.exe`).
- Release: `npm run dist`, dann `gh release create vX.Y.Z dist/ScreenLink.exe`
  (feste Download-URL: `https://github.com/<user>/screenlink/releases/latest/download/ScreenLink.exe`).
- Start: `npm start` · Build: `npm run dist` → `dist/ScreenLink.exe` (portable).
- Selbsttest (zwei Instanzen auf einem PC):
  `electron . --profile=a --selftest` → Code aus Log, dann
  `electron . --profile=b --selftest --auto-connect=<CODE> --auto-share`;
  A loggt `SELFTEST-RECV {...}` mit Auflösung/fps/Codec.
- Hinweis: Nach `npm install` ggf. `node node_modules/electron/install.js` (npm blockt Install-Skripte).
