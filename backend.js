// All Supabase access lives here: Realtime (commands, presence, camera
// signalling), Storage (media files) and one small settings table.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
import * as tus from 'https://cdn.jsdelivr.net/npm/tus-js-client@4.3.1/+esm';
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

// Small files go up in one request. Anything over 6 MB uses Supabase's
// resumable (TUS) upload: sent in 6 MB chunks, with progress, and it picks up
// where it left off if the Wi-Fi drops.
const CHUNK = 6 * 1024 * 1024;
const STORAGE_HOST = SUPABASE_URL.replace(/\.supabase\.co\/?$/, '.storage.supabase.co');

export async function uploadFile(folder, name, file, onProgress = () => {}) {
  const path = `${folder}/${name}`;
  if (file.size <= CHUNK) {
    const { error } = await sb.storage.from(BUCKET).upload(path, file, {
      upsert: true, contentType: file.type || undefined, cacheControl: '31536000',
    });
    if (error) throw friendlyError(error, file);
    onProgress(1);
    return;
  }
  await new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${STORAGE_HOST}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      headers: { authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, 'x-upsert': 'true' },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK, // Supabase requires exactly 6 MB chunks
      metadata: {
        bucketName: BUCKET, objectName: path,
        contentType: file.type || 'application/octet-stream', cacheControl: '31536000',
      },
      onProgress: (sent, total) => onProgress(total ? sent / total : 0),
      onError: (e) => reject(friendlyError(e, file)),
      onSuccess: () => { onProgress(1); resolve(); },
    });
    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0]);
      upload.start();
    });
  });
}

function friendlyError(e, file) {
  const status = String(e?.originalResponse?.getStatus?.() || e?.statusCode || e?.status || '');
  const body = String(e?.originalResponse?.getBody?.() || e?.message || e || '');
  if (status === '413' || /maximum allowed size|too large|payload/i.test(body)) {
    const mb = Math.max(1, Math.round(file.size / 1024 / 1024));
    return new Error(`This file is ${mb} MB, which is over your Supabase upload limit. ` +
      'On the Free plan the limit is 50 MB per file. On a paid plan, raise it in the Supabase dashboard: ' +
      'Storage → Settings → Upload file size limit.');
  }
  return new Error(body.replace(/^tus: /, '').slice(0, 300) || 'Upload failed');
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
