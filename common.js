// Shared client code: the show "room" (Supabase Realtime), the media library,
// and WebRTC helpers used by the screen, controller and cameras.
import { openRoom, listFolder, uploadFile, deleteFile, loadSettings, saveSettings } from './backend.js';

export { loadSettings, saveSettings };

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
    cameras: peers.filter((p) => p.role === 'camera').map((p) => ({ id: p.id, name: p.name || 'Camera' }))
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

export async function loadLibrary() {
  const [show, sounds, settings] = await Promise.all([
    listFolder('show'), listFolder('sounds'), loadSettings('main').catch(() => ({})),
  ]);
  const order = settings.order || [];
  const pads = settings.pads || {};
  const files = show.filter((f) => ['image', 'video'].includes(kindOf(f.name))).sort((a, b) => natural(a.name, b.name));
  const byName = new Map(files.map((f) => [f.name, f]));
  const ordered = order.filter((n) => byName.has(n)).map((n) => byName.get(n));
  for (const f of files) if (!ordered.includes(f)) ordered.push(f);
  return {
    settings,
    show: ordered.map((f) => ({ name: f.name, type: kindOf(f.name), url: f.url })),
    sounds: sounds.filter((f) => kindOf(f.name) === 'audio').sort((a, b) => natural(a.name, b.name)).map((f) => ({
      name: f.name, url: f.url,
      label: f.name.replace(/\.[^.]+$/, '').replace(/^\d+[-_ ]*/, '').replace(/[-_]+/g, ' '),
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

// ---------- WebRTC ----------
// Cameras stream directly device-to-device on the local Wi-Fi; Supabase only
// carries the short setup messages. STUN helps if a device is on another network.
export const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  bundlePolicy: 'max-bundle',
};

// Ask the browser to render frames as soon as they arrive (lowest latency).
export function lowLatencyReceiver(receiver) {
  try { receiver.playoutDelayHint = 0; } catch {}
  try { receiver.jitterBufferTarget = 0; } catch {}
}

// Viewer side: subscribe to camera streams. One instance per page.
export class CameraViewer {
  constructor(link, { quality = 'high', onStream = () => {}, onGone = () => {} } = {}) {
    this.link = link;
    this.quality = quality;
    this.onStream = onStream;
    this.onGone = onGone;
    this.pcs = new Map(); // cameraId -> pc
  }
  // Call with the current camera list; opens/closes connections.
  sync(cameras) {
    const ids = new Set(cameras.map((c) => c.id));
    for (const id of [...this.pcs.keys()]) if (!ids.has(id)) this.drop(id);
    for (const id of ids) if (!this.pcs.has(id)) this.request(id);
  }
  request(camId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pcs.set(camId, pc);
    pc.onicecandidate = (e) => e.candidate && this.signal(camId, { type: 'ice', candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      lowLatencyReceiver(e.receiver);
      this.onStream(camId, e.streams[0] || new MediaStream([e.track]));
    };
    const retry = () => {
      if (this.pcs.get(camId) !== pc) return;
      this.drop(camId, true);
      setTimeout(() => { if (!this.pcs.has(camId)) this.request(camId); }, 1500);
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') retry(); };
    // If the camera never answers (e.g. it was still starting), ask again.
    setTimeout(() => { if (pc.connectionState === 'new' && !pc.remoteDescription) retry(); }, 6000);
    this.signal(camId, { type: 'want', quality: this.quality });
  }
  drop(camId, quiet) {
    const pc = this.pcs.get(camId);
    if (!pc) return;
    this.pcs.delete(camId);
    if (!quiet) this.signal(camId, { type: 'bye' });
    pc.close();
    this.onGone(camId);
  }
  signal(to, data) { this.link.send({ t: 'signal', to, data }); }
  async handleSignal(from, data) {
    const pc = this.pcs.get(from);
    if (!pc) return;
    if (data.type === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal(from, { type: 'answer', sdp: pc.localDescription.sdp });
    } else if (data.type === 'ice') {
      try { await pc.addIceCandidate(data.candidate); } catch {}
    }
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
