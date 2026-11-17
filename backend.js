// All Supabase access lives here: Realtime (commands, presence, camera
// signalling and relayed camera frames), Storage (media files) and one small
// settings table.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_KEY, BUCKET, ROOM } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 50 } },
});

// ---------- realtime room ----------
// Joins the show channel and keeps it joined: if the join fails, times out or
// the socket drops, the channel is torn down and rebuilt with a growing delay.
// onStatus(up, reason) reports why it is down so pages can show it.
// High-frequency status messages are dropped while not joined (instead of
// each one turning into a REST request); commands still go out over REST so a
// button press is not lost while the controller reconnects.
const REST_OK = new Set(['cmd', 'library', 'state', 'getstate']);

export function openRoom({ id, meta, onMessage, onPeers, onStatus }) {
  let current = meta;
  let ch = null;
  let joined = false;
  let attempt = 0;
  let retryTimer = null;

  const report = (up, reason) => {
    joined = up;
    try { onStatus(up, reason || ''); } catch (e) { console.error(e); }
  };

  let joining = false;
  async function join() {
    clearTimeout(retryTimer);
    if (joining) return;
    joining = true;
    const old = ch;
    ch = null;
    if (old) {
      // sb.channel() hands back an existing channel with the same name, so the
      // old one must be fully gone first, even if unsubscribing timed out.
      await sb.removeChannel(old).catch(() => {});
      if (sb.getChannels().includes(old)) { try { old.teardown(); sb.realtime._remove(old); } catch {} }
    }
    joining = false;
    const mine = sb.channel('show:' + ROOM, {
      config: { broadcast: { self: false, ack: false }, presence: { key: id } },
    });
    ch = mine;
    mine.on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload));
    mine.on('presence', { event: 'sync' }, () => {
      const st = mine.presenceState();
      onPeers(Object.entries(st).map(([key, metas]) => {
        const { presence_ref, ...m } = metas[metas.length - 1] || {};
        return { id: key, ...m };
      }));
    });
    mine.subscribe((status, err) => {
      if (mine !== ch) return; // an older channel we already replaced
      if (status === 'SUBSCRIBED') {
        attempt = 0;
        report(true);
        mine.track(current);
        return;
      }
      const reason = status === 'TIMED_OUT' ? 'Timed out reaching Supabase Realtime'
        : status === 'CLOSED' ? 'Connection closed'
        : 'Realtime error' + (err?.message ? ': ' + err.message : '');
      console.warn('[room]', status, err || '');
      report(false, reason);
      // Rebuild the channel ourselves; 1s, 2s, 4s … up to 15s.
      const delay = Math.min(15000, 1000 * 2 ** attempt++);
      retryTimer = setTimeout(join, delay);
    });
  }

  join();
  // Coming back from sleep / a network change: rejoin right away.
  addEventListener('online', () => { if (!joined) { attempt = 0; join(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !joined) { attempt = 0; join(); }
  });

  return {
    send: (msg) => {
      if (!ch) return Promise.resolve('dropped');
      if (joined) return ch.send({ type: 'broadcast', event: 'm', payload: msg });
      if (!REST_OK.has(msg?.t)) return Promise.resolve('dropped');
      return typeof ch.httpSend === 'function'
        ? ch.httpSend('m', msg).catch((e) => console.warn('[room] REST send failed', e))
        : ch.send({ type: 'broadcast', event: 'm', payload: msg });
    },
    track: (m) => { current = m; return joined ? ch.track(m) : Promise.resolve('queued'); },
  };
}

// ---------- camera feed (video frames over Supabase) ----------
// When a phone and the laptop can't reach each other directly (different
// Wi-Fi, cellular, networks that isolate devices), the camera sends JPEG
// frames on its own channel instead. One channel per camera keeps the frames
// away from the show channel, so other devices never download them.
const closing = new Map(); // topic -> promise that resolves once the old channel is gone

export function openFeed(name, { onMessage = () => {} } = {}) {
  const topic = `feed:${ROOM}:${name}`;
  let ch = null;
  let joined = false;
  let closed = false;
  let attempt = 0;
  let timer = null;

  const remove = (c) => {
    const p = sb.removeChannel(c).catch(() => {}).then(() => {
      if (sb.getChannels().includes(c)) { try { c.teardown(); sb.realtime._remove(c); } catch {} }
    });
    closing.set(topic, p);
    return p;
  };

  async function join() {
    clearTimeout(timer);
    if (closed) return;
    const old = ch;
    ch = null;
    joined = false;
    if (old) await remove(old);
    await closing.get(topic);
    if (closed || ch) return;
    const mine = sb.channel(topic, { config: { broadcast: { self: false, ack: false } } });
    ch = mine;
    mine.on('broadcast', { event: 'f' }, ({ payload }) => onMessage(payload));
    mine.subscribe((status) => {
      if (mine !== ch || closed) return;
      if (status === 'SUBSCRIBED') { joined = true; attempt = 0; return; }
      joined = false;
      timer = setTimeout(join, Math.min(15000, 1000 * 2 ** attempt++));
    });
  }
  join();
  addEventListener('online', () => { if (!joined && !closed) { attempt = 0; join(); } });

  return {
    ready: () => joined,
    send: (payload) => { if (joined) ch.send({ type: 'broadcast', event: 'f', payload }); },
    // Bytes waiting to go out on the socket: skip frames instead of queueing lag.
    backlog: () => sb.realtime?.conn?.bufferedAmount || 0,
    close() {
      closed = true;
      joined = false;
      clearTimeout(timer);
      if (ch) { remove(ch); ch = null; }
    },
  };
}

// ---------- media storage ----------
export async function listFolder(folder) {
  const { data, error } = await sb.storage.from(BUCKET).list(folder, {
    limit: 1000, sortBy: { column: 'name', order: 'asc' },
  });
  if (error) throw error;
  return data.filter((f) => f.id).map((f) => ({
    name: f.name,
    url: sb.storage.from(BUCKET).getPublicUrl(`${folder}/${f.name}`).data.publicUrl +
      '?v=' + encodeURIComponent(f.updated_at || f.id),
  }));
}

export async function uploadFile(folder, name, file) {
  const { error } = await sb.storage.from(BUCKET).upload(`${folder}/${name}`, file, {
    upsert: true, contentType: file.type || undefined, cacheControl: '31536000',
  });
  if (error) throw error;
}

export async function deleteFile(folder, name) {
  const { error } = await sb.storage.from(BUCKET).remove([`${folder}/${name}`]);
  if (error) throw error;
}

// ---------- settings table (rundown order, pad settings, live state) ----------
export async function loadSettings(key) {
  const { data, error } = await sb.from('show_settings').select('data').eq('id', `${ROOM}:${key}`).maybeSingle();
  if (error) throw error;
  return data?.data || {};
}

export async function saveSettings(key, value) {
  const { error } = await sb.from('show_settings').upsert({ id: `${ROOM}:${key}`, data: value, updated_at: new Date().toISOString() });
  if (error) throw error;
}
