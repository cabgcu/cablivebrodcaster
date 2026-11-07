# Canyon Night Live — show control

A browser-based show control system for the Canyon Night live talk show. There is nothing to install: every device just opens a web page. **Supabase** connects the devices and stores the media.

| Device | Page | What it does |
|---|---|---|
| **Laptop** → projector/TV | `screen.html` | What the audience sees. Shows slides, videos and live cameras. **All audio** (videos and sound effects) plays from the laptop. |
| **iPad 1** | `control.html` | Next / back, tap any slide or video to put it on screen, video transport (play, pause, scrub, ±10s, volume), cut to a live camera, black screen, cut/fade. |
| **iPad 2** | `sound.html` | Soundboard pads. Sounds play on the **laptop**, not the iPad. Includes Stop all, Fade out all, master volume, and per-pad volume, loop and color. |
| **Phones** | `camera.html` | Turns a phone into a live camera. The controller iPad sees a preview of every camera and can cut to any of them. The phone shows a red **ON AIR** tally light while it is live. |
| any | `index.html` | Start page with links and QR codes for every device. |

## How it works

- **Supabase Realtime** (Broadcast + Presence) carries the iPads' button presses to the laptop and keeps track of which devices are online. It also carries the short setup messages that connect each camera.
- **Supabase Storage** (bucket `canyon-media`) holds the slides, videos and sounds. When the audience screen opens, it **downloads every slide and video into the laptop's memory**. Playback then never waits on the internet. The controller shows *Screen loading media 3/7* until the download finishes.
- **Camera video does not go through Supabase.** It travels phone → laptop directly over your Wi-Fi (WebRTC). Cameras connect as soon as they join and keep playing in the background. A cut is therefore instant.
- The audience screen holds the show state, meaning what's live. It saves that state to Supabase, so a reload comes back on the same slide.

## One-time setup

### 1. Set up Supabase

Open your project dashboard → **SQL Editor** → New query. Paste the contents of [`supabase/setup.sql`](supabase/setup.sql) and click **Run**. This creates:
- the public storage bucket `canyon-media`, with upload and delete allowed
- a small `show_settings` table for rundown order, pad settings and the live state

The project URL and publishable key are already set in [`config.js`](config.js).

### 2. Host the pages (HTTPS required)

The pages are plain static files: `index.html`, `screen.html`, `control.html`, `sound.html`, `camera.html`, `common.js`, `backend.js`, `config.js` and `style.css`. They must be served over **https://**, because iPhones only allow camera access on secure pages.

> Supabase Storage is not a good place to host these pages. For security, it serves `.html` files as plain text, so browsers show the code instead of running it. Keep the **media** in Supabase and the **pages** on a static host.

The easiest host is **GitHub Pages**, which is free and uses HTTPS:
1. Merge this branch into `main`.
2. In the repo on GitHub, go to **Settings → Pages**. Under **Source**, choose *Deploy from a branch*, then pick branch `main` and folder `/ (root)`. Click Save.
3. After a minute, the site is live at `https://cabgcu.github.io/cablivebrodcaster/`.

Netlify, Vercel and Cloudflare Pages also work. Upload or connect the folder; there's no build step.

## Show day

1. Open the start page (`index.html`) on the laptop.
2. **Audience screen:** click *Open*, drag the Chrome window onto the projector, then **click once**. That one click turns on sound and goes full screen. Browsers block sound until someone clicks the page, so the controller shows a yellow warning until this is done. Wait for the controller to say **Screen live**.
3. **iPad 1:** scan *Show control*. **iPad 2:** scan *Soundboard*. In Safari, Share → *Add to Home Screen* opens them full screen like an app.
4. **Phones:** scan *Live camera*, allow camera access, name the camera (e.g. "Wide shot") and tap **Go live-ready**.
   - The laptop and the camera phones should be on the **same Wi-Fi**.
   - Turn off Auto-Lock on camera phones, or keep them plugged in. A locked phone stops sending video.
   - Hold phones sideways for a 16:9 picture.

The laptop and iPads need internet access, because button presses travel through Supabase. Each press typically takes about 0.1–0.2 s to reach the laptop.

## Adding slides, videos and sounds

- Use *＋ Add slides / videos* on the controller or *＋ Add sounds* on the soundboard. You can also upload files to the `canyon-media` bucket in the Supabase dashboard: put slides and videos in the `show/` folder and sound effects in `sounds/`.
- Slides are images (PNG/JPG/WebP/GIF). Export a PowerPoint, Keynote, Canva or Google Slides deck as images.
- Videos: MP4 (H.264) is the most reliable format.
- **File size:** the Supabase free plan limits each upload to **50 MB**. Compress longer videos (for example with HandBrake, 1080p) or use a paid plan.
- The rundown follows filename order (`01-…`, `02-…`). You can change it on the controller with *Reorder / delete*.

## Backup controls on the laptop

If an iPad dies or the internet drops, use the keyboard or a presentation clicker on the audience screen:
`→` / `Space` / `PageDown` = next, `←` / `PageUp` = back, `B` or `.` = black, `K` = play/pause video, `F` = full screen.

## Camera latency

The camera-to-screen delay is typically about 0.1–0.3 s on good Wi-Fi. That is roughly the delay of a wireless video transmitter, but it is not literally zero. Cutting between cameras is instant, because every feed is already playing in the background.

To keep camera delay low:
- Use a good 5 GHz Wi-Fi router dedicated to the show. Busy venue or guest Wi-Fi is the most common cause of lag. Some guest networks also block device-to-device traffic entirely.
- Choose 720p on the phone. Use 1080p only on a strong network.

## Security note

The publishable key is designed to be visible in browser code, but anyone with it can use what the setup SQL allows. Anyone who has the page links and digs out the key could upload or delete show media, or send commands during the show. For a small show that is usually acceptable. To lock it down, add Supabase Auth (a show login) and change the policies in `setup.sql` from `anon` to `authenticated`.

## Settings

[`config.js`](config.js) contains:
- `SUPABASE_URL` and `SUPABASE_KEY`: your project.
- `BUCKET`: the storage bucket name.
- `ROOM`: devices with the same room name control the same show. Change it to run a separate rehearsal room.
