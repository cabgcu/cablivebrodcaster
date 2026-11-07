// All Supabase access lives here: Realtime (commands, presence, camera
// signalling), Storage (media files) and one small settings table.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import { SUPABASE_URL, SUPABASE_KEY, BUCKET, ROOM } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 50 } },
});

// ---------- realtime room ----------
export function openRoom({ id, meta, onMessage, onPeers, onStatus }) {
  let current = meta;
  const ch = sb.channel('show:' + ROOM, {
    config: { broadcast: { self: false, ack: false }, presence: { key: id } },
  });
  ch.on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload));
  ch.on('presence', { event: 'sync' }, () => {
    const st = ch.presenceState();
    onPeers(Object.entries(st).map(([key, metas]) => {
      const { presence_ref, ...m } = metas[metas.length - 1] || {};
      return { id: key, ...m };
    }));
  });
  ch.subscribe((status) => {
    onStatus(status === 'SUBSCRIBED');
    if (status === 'SUBSCRIBED') ch.track(current);
  });
  return {
    send: (msg) => ch.send({ type: 'broadcast', event: 'm', payload: msg }),
    track: (m) => { current = m; return ch.track(m); },
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
