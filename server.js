// Canyon Night Live — show control server.
// Runs on the show laptop. Serves the audience screen, the iPad controllers,
// the soundboard, and phone cameras over the local network.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const HTTP_PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const MEDIA = path.join(ROOT, 'media');
const SHOW_DIR = path.join(MEDIA, 'show');
const SOUND_DIR = path.join(MEDIA, 'sounds');
const SETTINGS_FILE = path.join(MEDIA, 'settings.json');
const CERT_DIR = path.join(ROOT, '.certs');

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif'];
const VIDEO_EXT = ['.mp4', '.m4v', '.mov', '.webm'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};

for (const d of [MEDIA, SHOW_DIR, SOUND_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------- settings (persisted) ----------
let settings = { order: [], pads: {}, master: 0.9 };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), () => {});
  }, 300);
}

// ---------- media library ----------
function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function listDir(dir, kinds) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && kinds.includes(kindOf(n))).sort(natural);
  } catch { return []; }
}

function getLibrary() {
  const files = listDir(SHOW_DIR, ['image', 'video']);
  // Custom order first (from the controller's reorder), then any new files by name.
  const ordered = settings.order.filter((n) => files.includes(n));
  for (const f of files) if (!ordered.includes(f)) ordered.push(f);
  const show = ordered.map((name) => ({
    name, type: kindOf(name), url: '/media/show/' + encodeURIComponent(name),
  }));
  const sounds = listDir(SOUND_DIR, ['audio']).map((name) => ({
    name, url: '/media/sounds/' + encodeURIComponent(name),
    label: name.replace(/\.[^.]+$/, '').replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' '),
    vol: settings.pads[name]?.vol ?? 1,
    loop: settings.pads[name]?.loop ?? false,
    color: settings.pads[name]?.color ?? null,
  }));
  return { show, sounds };
}

let library = getLibrary();
let libTimer = null;
function refreshLibrary() {
  clearTimeout(libTimer);
  libTimer = setTimeout(() => {
    library = getLibrary();
    // Keep the live item pointing at the same file if the order changed.
    if (state.program.kind === 'show') {
      const i = library.show.findIndex((s) => s.name === state.program.name);
      if (i === -1) state.program = { kind: 'black' };
      else state.program.index = i;
    }
    broadcast({ t: 'library', library });
    broadcastState();
  }, 250);
}
for (const d of [SHOW_DIR, SOUND_DIR]) {
  try { fs.watch(d, refreshLibrary); } catch {}
}

// ---------- show state ----------
const state = {
  program: { kind: 'black' }, // {kind:'show', index, name} | {kind:'camera', id} | {kind:'black'}
  transition: 'cut', // 'cut' | 'fade'
  video: { volume: 1, loop: false, autoplay: true, autoNext: false },
  master: settings.master,
  cameras: [], // [{id, name}]
  screens: 0,
  screenReady: false,
};

function publicState() { return state; }

// ---------- websocket hub ----------
const clients = new Map(); // id -> {ws, role, name, ready}
let nextId = 1;

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg, filter) {
  const s = JSON.stringify(msg);
  for (const c of clients.values()) if ((!filter || filter(c)) && c.ws.readyState === 1) c.ws.send(s);
}
function broadcastState() { broadcast({ t: 'state', state: publicState() }); }
function toScreens(msg) { broadcast(msg, (c) => c.role === 'screen'); }

function recomputeRoles() {
  state.cameras = [...clients.entries()]
    .filter(([, c]) => c.role === 'camera')
    .map(([id, c]) => ({ id, name: c.name || 'Camera ' + id }));
  const screens = [...clients.values()].filter((c) => c.role === 'screen');
  state.screens = screens.length;
  state.screenReady = screens.some((c) => c.ready);
  if (state.program.kind === 'camera' && !state.cameras.find((c) => c.id === state.program.id)) {
    // Camera dropped while live: hold on black rather than a frozen frame.
    state.program = { kind: 'black' };
  }
}

function take(index) {
  const item = library.show[index];
  if (!item) return;
  state.program = { kind: 'show', index, name: item.name, at: Date.now() };
}

function handleCommand(c, m) {
  switch (m.action) {
    case 'take': take(m.index); break;
    case 'next': {
      const cur = state.program.kind === 'show' ? state.program.index : state.lastShowIndex ?? -1;
      take(Math.min(cur + 1, library.show.length - 1));
      break;
    }
    case 'prev': {
      const cur = state.program.kind === 'show' ? state.program.index : (state.lastShowIndex ?? 1);
      take(Math.max(cur - 1, 0));
      break;
    }
    case 'black': state.program = { kind: 'black' }; break;
    case 'camera':
      if (state.cameras.find((x) => x.id === m.id)) state.program = { kind: 'camera', id: m.id };
      break;
    case 'transition': state.transition = m.value === 'fade' ? 'fade' : 'cut'; break;
    case 'videoOpt':
      for (const k of ['volume', 'loop', 'autoplay', 'autoNext']) if (k in m) state.video[k] = m[k];
      break;
    case 'master':
      state.master = Math.max(0, Math.min(1, Number(m.value)));
      settings.master = state.master; saveSettings();
      break;
    case 'reorder':
      if (Array.isArray(m.order)) { settings.order = m.order.map(String); saveSettings(); refreshLibrary(); }
      return;
    case 'pad': {
      const p = (settings.pads[m.name] ||= {});
      for (const k of ['vol', 'loop', 'color']) if (k in m) p[k] = m[k];
      saveSettings(); library = getLibrary();
      broadcast({ t: 'library', library });
      return;
    }
    // Transport + sound effects are executed by the screen; just relay.
    case 'video': toScreens({ t: 'video', op: m.op, value: m.value }); return;
    case 'sfx': toScreens({ t: 'sfx', op: m.op, name: m.name }); return;
    default: return;
  }
  if (state.program.kind === 'show') state.lastShowIndex = state.program.index;
  broadcastState();
}

function onConnection(ws) {
  const id = String(nextId++);
  const c = { ws, role: 'unknown', name: '' , ready: false };
  clients.set(id, c);
  send(ws, { t: 'welcome', id, library, state: publicState() });

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    switch (m.t) {
      case 'hello':
        c.role = String(m.role || 'unknown');
        c.name = String(m.name || '').slice(0, 40);
        recomputeRoles(); broadcastState();
        break;
      case 'rename':
        c.name = String(m.name || '').slice(0, 40);
        recomputeRoles(); broadcastState();
        break;
      case 'ready': // screen has unlocked audio / gone live
        c.ready = !!m.value; recomputeRoles(); broadcastState();
        break;
      case 'cmd': handleCommand(c, m); break;
      case 'signal': { // WebRTC signalling relay
        const target = clients.get(String(m.to));
        if (target) send(target.ws, { t: 'signal', from: id, data: m.data });
        break;
      }
      case 'vstatus': // screen -> controllers: video playhead
        broadcast({ ...m }, (x) => x.role !== 'screen' && x.role !== 'camera');
        if (m.ended && state.video.autoNext && state.program.kind === 'show' && !state.video.loop) {
          handleCommand(c, { action: 'next' });
        }
        break;
      case 'sfxstatus': // screen -> soundboards: what's playing
        broadcast({ t: 'sfxstatus', playing: m.playing }, (x) => x.role !== 'screen' && x.role !== 'camera');
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    broadcast({ t: 'peer-left', id });
    recomputeRoles(); broadcastState();
  });
}

// ---------- HTTP handler ----------
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) { // Range support is required for video seeking (and for Safari at all).
      let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
      end = Math.min(end, st.size - 1);
      if (isNaN(start) || start > end || start < 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) || p === base ? p : null;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/api/info') {
    return json(res, 200, { ips: lanAddresses(), httpPort: HTTP_PORT, httpsPort: HTTPS_PORT, hostname: os.hostname() });
  }
  if (p === '/api/qr') {
    const svg = await QRCode.toString(url.searchParams.get('text') || '', { type: 'svg', margin: 1 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg);
  }
  if (p === '/api/library') return json(res, 200, library);

  if (p === '/api/upload' && (req.method === 'PUT' || req.method === 'POST')) {
    const kind = url.searchParams.get('kind');
    const name = path.basename(url.searchParams.get('name') || '').replace(/[\\/:*?"<>|]/g, '_');
    const dir = kind === 'sounds' ? SOUND_DIR : kind === 'show' ? SHOW_DIR : null;
    const want = kind === 'sounds' ? ['audio'] : ['image', 'video'];
    if (!dir || !name || !want.includes(kindOf(name))) return json(res, 400, { error: 'Unsupported file type' });
    const dest = path.join(dir, name);
    const tmp = dest + '.uploading';
    const out = fs.createWriteStream(tmp);
    req.pipe(out);
    out.on('finish', () => fs.rename(tmp, dest, (e) => {
      if (e) return json(res, 500, { error: e.message });
      refreshLibrary(); json(res, 200, { ok: true, name });
    }));
    out.on('error', (e) => json(res, 500, { error: e.message }));
    return;
  }
  if (p === '/api/delete' && req.method === 'POST') {
    const kind = url.searchParams.get('kind');
    const dir = kind === 'sounds' ? SOUND_DIR : kind === 'show' ? SHOW_DIR : null;
    const file = dir && safeJoin(dir, path.basename(url.searchParams.get('name') || ''));
    if (!file) return json(res, 400, { error: 'bad request' });
    return fs.unlink(file, (e) => { refreshLibrary(); json(res, e ? 404 : 200, { ok: !e }); });
  }

  if (p.startsWith('/media/')) {
    const file = safeJoin(MEDIA, p.slice('/media/'.length));
    if (!file) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, file);
  }

  const pages = { '/': 'index.html', '/screen': 'screen.html', '/control': 'control.html',
    '/sound': 'sound.html', '/soundboard': 'sound.html', '/camera': 'camera.html' };
  if (pages[p]) return serveFile(req, res, path.join(PUBLIC, pages[p]));
  const file = safeJoin(PUBLIC, p.slice(1));
  if (!file) { res.writeHead(403); return res.end(); }
  serveFile(req, res, file);
}

// ---------- certificates (phones need HTTPS to use the camera) ----------
async function loadCert() {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const ipsFile = path.join(CERT_DIR, 'ips.json');
  const ips = lanAddresses();
  try {
    const known = JSON.parse(fs.readFileSync(ipsFile, 'utf8'));
    if (ips.every((ip) => known.includes(ip))) {
      return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
    }
  } catch {}
  const selfsigned = require('selfsigned');
  const notAfter = new Date(); notAfter.setFullYear(notAfter.getFullYear() + 5);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Canyon Night Live' }], {
    keySize: 2048, algorithm: 'sha256', notAfterDate: notAfter,
    extensions: [{ name: 'subjectAltName', altNames: [
      { type: 2, value: 'localhost' }, { type: 2, value: os.hostname() },
      { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip })),
    ] }],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(ipsFile, JSON.stringify(ips));
  return { key: pems.private, cert: pems.cert };
}

(async () => {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', onConnection);
  const upgrade = (req, sock, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
  };

  const h = http.createServer(handler);
  h.on('upgrade', upgrade);
  h.listen(HTTP_PORT, '0.0.0.0');

  try {
    const s = https.createServer(await loadCert(), handler);
    s.on('upgrade', upgrade);
    s.listen(HTTPS_PORT, '0.0.0.0');
  } catch (e) {
    console.warn('HTTPS disabled (phone cameras will not work):', e.message);
  }

  const ip = lanAddresses()[0] || 'localhost';
  console.log(`
  ┌──────────────────────────────────────────────────────────┐
     CANYON NIGHT LIVE — show server is running
  └──────────────────────────────────────────────────────────┘
   On this laptop (audience screen):  http://localhost:${HTTP_PORT}/screen
   Start page with QR codes:          http://${ip}:${HTTP_PORT}/

   iPad 1 — slides & video control:   http://${ip}:${HTTP_PORT}/control
   iPad 2 — soundboard:               http://${ip}:${HTTP_PORT}/sound
   Phones — live camera:              https://${ip}:${HTTPS_PORT}/camera

   Show files:   ${SHOW_DIR}
   Sound files:  ${SOUND_DIR}
`);
})();
