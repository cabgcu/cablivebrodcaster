-- Canyon Night Live — one-time Supabase setup.
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
-- It is safe to run again.

-- 1) Storage bucket for slides, videos and sounds (public so the screen can play them).
--    file_size_limit = null means "use the project's global upload limit".
--    That global limit is set in Dashboard → Storage → Settings → "Upload file size limit".
--    Free plan: 50 MB maximum per file. Pro and above: can be raised (e.g. to 2 GB).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('canyon-media', 'canyon-media', true, null, array['image/*', 'video/*', 'audio/*'])
on conflict (id) do update set public = true, file_size_limit = null, allowed_mime_types = excluded.allowed_mime_types;

-- Let the show pages (publishable key) list, upload, replace and delete files in that bucket.
drop policy if exists "canyon media read"   on storage.objects;
drop policy if exists "canyon media upload" on storage.objects;
drop policy if exists "canyon media update" on storage.objects;
drop policy if exists "canyon media delete" on storage.objects;
create policy "canyon media read"   on storage.objects for select to anon, authenticated using (bucket_id = 'canyon-media');
create policy "canyon media upload" on storage.objects for insert to anon, authenticated with check (bucket_id = 'canyon-media');
create policy "canyon media update" on storage.objects for update to anon, authenticated using (bucket_id = 'canyon-media') with check (bucket_id = 'canyon-media');
create policy "canyon media delete" on storage.objects for delete to anon, authenticated using (bucket_id = 'canyon-media');

-- 2) Small settings table: rundown order, soundboard pad settings, and what's live.
create table if not exists public.show_settings (
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.show_settings enable row level security;
grant select, insert, update on public.show_settings to anon, authenticated;

drop policy if exists "show settings read"   on public.show_settings;
drop policy if exists "show settings insert" on public.show_settings;
drop policy if exists "show settings update" on public.show_settings;
create policy "show settings read"   on public.show_settings for select to anon, authenticated using (true);
create policy "show settings insert" on public.show_settings for insert to anon, authenticated with check (true);
create policy "show settings update" on public.show_settings for update to anon, authenticated using (true) with check (true);

-- 3) Realtime: nothing to set up. The pages use Broadcast + Presence on a public channel.
--    (If you turned on "Allow only private channels" in Realtime settings, turn it off.)
