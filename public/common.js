// Shared client code: WebSocket link to the show server (auto-reconnect)
// and small WebRTC helpers used by the screen, controller and cameras.

export function connect(role, { name = '', onMessage = () => {}, onStatus = () => {} } = {}) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws = null;
  let closedByUs = false;
  let retry = 0;
  const api = {
    id: null,
    name,
    send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
    cmd(action, extra = {}) { api.send({ t: 'cmd', action, ...extra }); },
    close() { closedByUs = true; ws && ws.close(); },
  };
  function open() {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      api.send({ t: 'hello', role, name: api.name });
      onStatus(true);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'welcome') api.id = m.id;
      onMessage(m);
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closedByUs) setTimeout(open, Math.min(4000, 300 * 2 ** retry++));
    };
    ws.onerror = () => ws.close();
  }
  open();
  return api;
}

// ---------- WebRTC ----------
// Local network only: no STUN/TURN needed (and the show may be offline).
export const RTC_CONFIG = { iceServers: [], bundlePolicy: 'max-bundle' };

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
  // Call with the current camera list from state; opens/closes connections.
  sync(cameras) {
    const ids = new Set(cameras.map((c) => c.id));
    for (const id of [...this.pcs.keys()]) if (!ids.has(id)) this.drop(id);
    for (const id of ids) if (!this.pcs.has(id)) this.request(id);
  }
  request(camId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pcs.set(camId, pc);
    pc.onicecandidate = (e) => e.candidate && this.signal(camId, { type: 'ice', candidate: e.candidate });
    pc.ontrack = (e) => {
      lowLatencyReceiver(e.receiver);
      this.onStream(camId, e.streams[0] || new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && this.pcs.get(camId) === pc) {
        this.drop(camId);
        setTimeout(() => this.request(camId), 1000); // retry
      }
    };
    this.signal(camId, { type: 'want', quality: this.quality });
  }
  drop(camId) {
    const pc = this.pcs.get(camId);
    if (!pc) return;
    this.pcs.delete(camId);
    try { this.signal(camId, { type: 'bye' }); } catch {}
    pc.close();
    this.onGone(camId);
  }
  reset() { for (const id of [...this.pcs.keys()]) this.drop(id); }
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

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
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

export async function uploadFiles(kind, files, onProgress = () => {}) {
  let done = 0;
  for (const f of files) {
    onProgress(`Uploading ${f.name} (${++done}/${files.length})…`);
    const r = await fetch(`/api/upload?kind=${kind}&name=${encodeURIComponent(f.name)}`, { method: 'PUT', body: f });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`${f.name}: ${j.error || 'upload failed'}`);
    }
  }
  onProgress('');
}
