// Canyon Night Live — Supabase connection settings.
// The publishable key is meant to be public (it ships in browser code).
export const SUPABASE_URL = 'https://rbpfdpxarlfconjrarge.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_ZrH0kSdzOqHpR41_nmzoeg_TlHGTIvE';

// Storage bucket that holds slides, videos and sounds (created by supabase/setup.sql).
export const BUCKET = 'canyon-media';

// Every device using the same room name is part of the same show.
export const ROOM = 'canyon-night';

// ---------- camera relay (TURN) ----------
// Cameras normally stream straight from phone to laptop over Wi-Fi. Many
// school, venue and guest networks block device-to-device traffic, or a phone
// may be on cellular. Then cameras show black unless a TURN relay is set up.
// Fill in ONE of these (see README, "Cameras show black"):
//
// a) A URL that returns ICE servers as JSON, e.g. Metered's free plan:
//    'https://YOUR-APP.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY'
export const ICE_SERVERS_URL = '';
//
// b) Or list TURN servers directly:
//    [{ urls: 'turn:turn.example.com:443?transport=tcp', username: '…', credential: '…' }]
export const ICE_SERVERS = [];
