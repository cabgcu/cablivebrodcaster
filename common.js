// Shared client code: the show "room" (Supabase Realtime), the media library,
// and WebRTC helpers used by the screen, controller and cameras.
import { openRoom, openFeed, listFolder, uploadFile, deleteFile, loadSettings, saveSettings } from './backend.js';

export { loadSettings, saveSettings, openFeed };

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'];
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'];
export function kindOf(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

// ---------- room ----------
// Every page joins the same realtime room. Messages are broadcast to all;
// a message with `to` is meant for one device only.
export function connect(role, { meta = {}, onMessage = () => {}, onStatus = () => {}, onPeers = () => {}, onPeerLeft = () => {} } = {}) {
  const id = role[0] + Math.random().toString(36).slice(2, 10);
  let myMeta = { role, ...meta };
  let known = new Set();
  const api = {
    id,
    peers: [],
    send(msg) { room.send({ ...msg, from: id }); },
    cmd(action, extra = {}) { api.send({ t: 'cmd', action, ...extra }); },
    setMeta(m) { myMeta = { ...myMeta, ...m }; room.track(myMeta); },
  };
  const room = openRoom({
    id,
    meta: myMeta,
    onStatus,
    onMessage: (m) => { if (!m || m.from === id || (m.to && m.to !== id)) return; onMessage(m); },
    onPeers: (list) => {
      api.peers = list.filter((p) => p.id !== id);
      const now = new Set(api.peers.map((p) => p.id));
      for (const old of known) if (!now.has(old)) onPeerLeft(old);
      known = now;
      onPeers(api.peers);
    },
  });
  return api;
}

// What the room looks like right now, from presence.
export function summarize(peers) {
  const screens = peers.filter((p) => p.role === 'screen');
  return {
    cameras: peers.filter((p) => p.role === 'camera').map((p) => ({ id: p.id, name: p.name || 'Camera',
      zoom: p.zoom ?? 1, zoomMin: p.zoomMin ?? 1, zoomMax: p.zoomMax ?? 1 }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    screens: screens.length,
    screenReady: screens.some((s) => s.ready),
    cached: screens.find((s) => s.ready)?.cached || screens[0]?.cached || '',
  };
}

export const DEFAULT_STATE = {
  program: { kind: 'black' },
  transition: 'cut',
  video: { volume: 1, loop: false, autoplay: true, autoNext: false },
  master: 0.9,
};

// ---------- media library ----------
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Files listed in `order` come first, in that order; new files follow by name.
function orderBy(files, order = []) {
  const byName = new Map(files.map((f) => [f.name, f]));
  const out = order.filter((n) => byName.has(n)).map((n) => byName.get(n));
  for (const f of files) if (!out.includes(f)) out.push(f);
  return out;
}

export async function loadLibrary() {
  const [show, sounds, settings] = await Promise.all([
    listFolder('show'), listFolder('sounds'), loadSettings('main').catch(() => ({})),
  ]);
  const order = settings.order || [];
  const pads = settings.pads || {};
  const titles = settings.titles || {}; // display names set with Rename (the stored file keeps its name)
  const files = show.filter((f) => ['image', 'video'].includes(kindOf(f.name))).sort((a, b) => natural(a.name, b.name));
  const byName = new Map(files.map((f) => [f.name, f]));
  const ordered = order.filter((n) => byName.has(n)).map((n) => byName.get(n));
  for (const f of files) if (!ordered.includes(f)) ordered.push(f);
  return {
    settings,
    show: ordered.map((f) => ({ name: f.name, type: kindOf(f.name), url: f.url, label: titles[f.name] || prettyName(f.name) })),
    sounds: orderBy(sounds.filter((f) => kindOf(f.name) === 'audio').sort((a, b) => natural(a.name, b.name)), settings.soundOrder).map((f) => ({
      name: f.name, url: f.url,
      label: pads[f.name]?.label || prettyName(f.name),
      vol: pads[f.name]?.vol ?? 1, loop: pads[f.name]?.loop ?? false, color: pads[f.name]?.color ?? null,
    })),
  };
}

// Change shared settings (rundown order / pads), then tell everyone to reload.
export async function updateSettings(link, fn) {
  const s = await loadSettings('main').catch(() => ({}));
  fn(s);
  await saveSettings('main', s);
  link.send({ t: 'library' });
}

// Storage keys can't contain every character; keep names simple.
export function cleanName(name) {
  return name.normalize('NFKD').replace(/[^\w.\-() ]+/g, '').replace(/\s+/g, '-') || 'file';
}

export async function uploadFiles(link, folder, files, onProgress = () => {}) {
  let n = 0;
  for (const f of files) {
    onProgress(`Uploading ${f.name} (${++n}/${files.length})…`);
    try { await uploadFile(folder, cleanName(f.name), f); }
    catch (e) { alert(`${f.name}: ${e.message || 'upload failed'}`); }
  }
  onProgress('');
  link.send({ t: 'library' });
}

export async function removeFile(link, folder, name) {
  try { await deleteFile(folder, name); } catch (e) { alert(e.message || 'delete failed'); }
  link.send({ t: 'library' });
}

// ---------- cameras ----------
// Two routes, both with no server of our own:
//  1. Direct (WebRTC): phone -> laptop/iPad, peer to peer. Lowest delay. Works on
//     the same Wi-Fi and often across different networks. The public STUN
//     address only helps each device learn its own internet address; no video
//     goes through it.
//  2. Supabase: when the direct route is blocked, the phone sends JPEG frames
//     over a Supabase Realtime channel. Works on any network with internet.
// Viewers start both at once and switch to direct as soon as it connects, so
// a picture appears within a second or two either way.
const RTC_CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
  bundlePolicy: 'max-bundle',
};
export async function getRtcConfig() { return RTC_CONFIG; }

// Signalling messages arrive over the network in order, but the handlers are
// async. Run them one at a time per peer, and hold ICE candidates until the
// remote description is set — otherwise addIceCandidate throws, the candidate
// is lost, the connection never forms, and the video stays black.
export class SignalQueue {
  constructor() { this.chains = new Map(); }
  run(key, fn) {
    const next = (this.chains.get(key) || Promise.resolve()).then(fn).catch((e) => console.warn('signal', e));
    this.chains.set(key, next);
    return next;
  }
}
export async function addIce(pc, candidate) {
  if (!pc.remoteDescription) { (pc._pendingIce ||= []).push(candidate); return; }
  try { await pc.addIceCandidate(candidate); } catch (e) { console.warn('ice', e); }
}
export async function setRemote(pc, desc) {
  await pc.setRemoteDescription(desc);
  const pending = pc._pendingIce || [];
  pc._pendingIce = [];
  for (const c of pending) { try { await pc.addIceCandidate(c); } catch (e) { console.warn('ice', e); } }
}

// Ask the browser to render frames as soon as they arrive (lowest latency).
export function lowLatencyReceiver(receiver) {
  try { receiver.playoutDelayHint = 0; } catch {}
  try { receiver.jitterBufferTarget = 0; } catch {}
}

// Viewer side: subscribe to camera streams. One instance per page.
// States per camera: 'connecting' | 'direct' | 'relay' (via Supabase) | 'failed'.
const DIRECT_TIMEOUT = 10000; // give the direct route this long to connect
const DIRECT_RETRY = 60000; // while relayed, try the direct route again this often
export class CameraViewer {
  constructor(link, { quality = 'high', onStream = () => {}, onGone = () => {}, onState = () => {} } = {}) {
    this.link = link;
    this.quality = quality;
    this.onStream = onStream;
    this.onGone = onGone;
    this.onState = onState;
    this.states = new Map(); // cameraId -> state
    this.cams = new Map(); // cameraId -> { pc, mode, relay, retry }
    this.queue = new SignalQueue();
  }
  // Call with the current camera list; opens/closes connections.
  sync(cameras) {
    const ids = new Set(cameras.map((c) => c.id));
    for (const id of [...this.cams.keys()]) if (!ids.has(id)) this.drop(id);
    for (const id of ids) if (!this.cams.has(id)) this.start(id);
  }
  setState(camId, st) {
    if (!this.cams.has(camId) || this.states.get(camId) === st) return;
    this.states.set(camId, st);
    this.onState(camId, st);
  }
  start(camId) {
    const e = { pc: null, mode: null, relay: null, retry: null };
    this.cams.set(camId, e);
    this.setState(camId, 'connecting');
    this.startRelay(camId);
    this.tryDirect(camId);
  }

  // ----- direct (WebRTC) -----
  tryDirect(camId) {
    const e = this.cams.get(camId);
    if (!e || e.pc) return;
    clearTimeout(e.retry);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    e.pc = pc;
    let stream = null;
    const alive = () => this.cams.get(camId) === e && e.pc === pc;
    const useDirect = () => {
      if (!alive() || !stream || e.mode === 'direct' || pc.connectionState !== 'connected') return;
      e.mode = 'direct';
      this.stopRelay(camId);
      this.setState(camId, 'direct');
      this.onStream(camId, stream);
    };
    const giveUp = () => {
      if (!alive()) return;
      e.pc = null;
      this.signal(camId, { type: 'bye' });
      pc.close();
      if (e.mode === 'direct') { e.mode = null; this.setState(camId, 'connecting'); }
      this.startRelay(camId); // no-op if the relay is already running
      e.retry = setTimeout(() => this.tryDirect(camId), DIRECT_RETRY);
    };
    pc.onicecandidate = (ev) => ev.candidate && this.signal(camId, { type: 'ice', candidate: ev.candidate.toJSON() });
    pc.ontrack = (ev) => {
      lowLatencyReceiver(ev.receiver);
      stream = ev.streams[0] || new MediaStream([ev.track]);
      useDirect();
    };
    pc.onconnectionstatechange = () => {
      if (!alive()) return;
      const st = pc.connectionState;
      if (st === 'connected') useDirect();
      else if (st === 'failed' || st === 'closed') giveUp();
      else if (st === 'disconnected') setTimeout(() => { if (alive() && pc.connectionState === 'disconnected') giveUp(); }, 4000);
    };
    setTimeout(() => { if (alive() && e.mode !== 'direct') giveUp(); }, DIRECT_TIMEOUT);
    this.signal(camId, { type: 'want', quality: this.quality });
  }

  // ----- relay (JPEG frames over Supabase) -----
  startRelay(camId) {
    const e = this.cams.get(camId);
    if (!e || e.relay) return;
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const r = { stream: null, lastAt: 0, startedAt: Date.now() };
    e.relay = r;
    let busy = false;
    let pending = null;
    const draw = (f) => {
      if (e.relay !== r || !f?.img) return;
      if (busy) { pending = f; return; } // keep only the newest frame
      busy = true;
      const img = new Image();
      const done = () => {
        busy = false;
        if (pending) { const p = pending; pending = null; draw(p); }
      };
      img.onload = () => {
        if (e.relay !== r) return done();
        const w = f.w || img.naturalWidth, h = f.h || img.naturalHeight;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        ctx.drawImage(img, 0, 0, w, h);
        r.lastAt = Date.now();
        if (!r.stream) r.stream = canvas.captureStream();
        if (e.mode !== 'direct' && e.mode !== 'relay') {
          e.mode = 'relay';
          this.onStream(camId, r.stream);
        }
        if (e.mode === 'relay') this.setState(camId, 'relay');
        done();
      };
      img.onerror = done;
      img.src = f.img;
    };
    r.feed = openFeed(camId + ':' + this.quality, { onMessage: draw });
    // Ask the camera for frames now and every few seconds (it stops sending
    // to viewers it hasn't heard from in a while).
    const ask = () => this.signal(camId, { type: 'frames', quality: this.quality });
    ask();
    r.timer = setInterval(() => {
      ask();
      const quiet = Date.now() - (r.lastAt || r.startedAt);
      if (quiet > 12000 && e.mode !== 'direct') this.setState(camId, 'failed');
    }, 3000);
  }
  stopRelay(camId) {
    const e = this.cams.get(camId);
    const r = e?.relay;
    if (!r) return;
    e.relay = null;
    clearInterval(r.timer);
    r.feed.close();
    r.stream?.getTracks().forEach((t) => t.stop());
    if (e.mode === 'relay') e.mode = null;
    this.signal(camId, { type: 'noframes' });
  }

  drop(camId, quiet) {
    const e = this.cams.get(camId);
    if (!e) return;
    this.stopRelay(camId);
    clearTimeout(e.retry);
    if (e.pc) {
      if (!quiet) this.signal(camId, { type: 'bye' });
      e.pc.close();
    }
    this.cams.delete(camId);
    this.states.delete(camId);
    this.onGone(camId);
  }
  signal(to, data) { this.link.send({ t: 'signal', to, data }); }
  handleSignal(from, data) {
    return this.queue.run(from, async () => {
      const pc = this.cams.get(from)?.pc;
      if (!pc || pc.signalingState === 'closed') return;
      if (data.type === 'offer') {
        await setRemote(pc, { type: 'offer', sdp: data.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(from, { type: 'answer', sdp: pc.localDescription.sdp });
      } else if (data.type === 'ice') {
        await addIce(pc, data.candidate);
      }
    });
  }
}

// ---------- small DOM helpers ----------
export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function $(sel, root = document) { return root.querySelector(sel); }

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}

export async function wakeLock() {
  const req = async () => { try { await navigator.wakeLock?.request('screen'); } catch {} };
  req();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && req());
}

// ---------- icons (inline SVG, stroke style) ----------
const ICONS = {
  logo: '<path d="M3 20 9.5 8l4 7 2.5-4L21 20Z"/><circle cx="17" cy="5" r="1.6"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  play: '<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.6-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  restart: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.3"/><path d="M3 3.5v4.8h4.8"/>',
  back10: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8.3"/><path d="M3 3.5v4.8h4.8"/>',
  fwd10: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8.3"/><path d="M21 3.5v4.8h-4.8"/>',
  black: '<rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" stroke="none"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6"/><path d="m18.5 6-.8 13.1A2 2 0 0 1 15.7 21H8.3a2 2 0 0 1-2-1.9L5.5 6"/>',
  camera: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2.5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L5 21"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2.5"/><path d="M8 21h8M12 17v4"/>',
  tablet: '<rect x="4" y="2" width="16" height="20" rx="2.5"/><path d="M11 18h2"/>',
  phone: '<rect x="6.5" y="2" width="11" height="20" rx="2.5"/><path d="M11 18h2"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  flip: '<path d="M3 12a9 9 0 0 1 15.36-6.36L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.36 6.36L3 16"/><path d="M3 21v-5h5"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  fade: '<path d="M4 12c2-6 6-6 8 0s6 6 8 0"/>',
  wave: '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'i ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
}
// Replace <i data-icon="name"></i> placeholders in static markup.
export function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((i) => i.replaceWith(icon(i.dataset.icon, i.className)));
}

// Range inputs show a filled track up to the thumb.
export function paintRange(r) {
  const min = Number(r.min || 0), max = Number(r.max || 100);
  r.style.setProperty('--p', ((Number(r.value) - min) / (max - min || 1)) * 100 + '%');
}
export function setRange(r, v) { r.value = v; paintRange(r); }
document.addEventListener('input', (e) => { if (e.target.type === 'range') paintRange(e.target); });

if (document.readyState !== 'loading') hydrateIcons();
else document.addEventListener('DOMContentLoaded', () => hydrateIcons());

// "03-guest_intro.png" -> "Guest intro"
export function prettyName(name) {
  const s = String(name || '').replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]*/, '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(name || '');
}
