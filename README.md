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
- **Camera video does not go through Supabase.** It travels phone → laptop directly over your Wi-Fi (WebRTC). When that's impossible (different Wi-Fi networks, cellular, or a school network that blocks it), it goes through a **camera relay** (TURN server) that you set up once on the start page. Cameras connect as soon as they join and keep playing in the background. A cut is therefore instant.
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
   - With the **camera relay** set up (below), phones can be on any network: school Wi-Fi, a different Wi-Fi from the laptop, or cellular. Without it, they must share the laptop's Wi-Fi.
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

## Camera relay (phones on different Wi-Fi, school networks)

School networks usually stop devices from talking to each other directly, and often put phones and laptops on different Wi-Fi networks. A **TURN relay** fixes this. Both the phone and the laptop connect *out* to a relay server on the internet, and the server passes the video along. That works on almost any network that has internet access.

Set it up once:

1. Create a free TURN account. Either works:
   - **ExpressTURN** (expressturn.com): has a large free plan. After you sign up, the dashboard shows a server address (like `turn:free.expressturn.com:3478`), a username and a password.
   - **Metered** (metered.ca → TURN Server → create an app): copy the "credentials API URL" (`https://YOUR-APP.metered.live/api/v1/turn/credentials?apiKey=…`).
2. On the start page (`index.html`), scroll to **Camera relay**. Paste the server address, username and password, *or* the credentials link. Click **Save and test**. You should see **Working**.
3. On a camera phone **on the school Wi-Fi**, open the start page and tap **Test on this device**. If it says *Working*, cameras will connect from that network.
4. Reload the screen, controller and camera pages.

The relay is saved in Supabase, so every device picks it up. There's no need to edit code. When two devices *can* reach each other directly, the video still goes direct. The camera's badge shows **· relay** when the relay is in use. Relayed video is sent at a lower bitrate (2.5 Mbps), which keeps delay down and makes the free allowance last.

If the test says *Not reachable* on the school Wi-Fi, the school may block the relay's port. Add a TLS address on port 443 if your provider gives one (e.g. `turns:…:443?transport=tcp`), because schools almost never block port 443. Put several addresses in the box separated by spaces. As a last resort, use a phone hotspot or a portable router for the laptop and cameras.

**Data use:** each relayed camera uses about 1 GB per hour. Check your provider's free monthly allowance against your show length and number of cameras.

## Camera latency

The camera-to-screen delay is typically about 0.1–0.3 s on good Wi-Fi. That is roughly the delay of a wireless video transmitter, but it is not literally zero. Cutting between cameras is instant, because every feed is already playing in the background.

To keep camera delay low:
- Use a good 5 GHz Wi-Fi router dedicated to the show. Busy venue or guest Wi-Fi is the most common cause of lag. Some guest networks also block device-to-device traffic entirely.
- Choose 720p on the phone. Use 1080p only on a strong network.

## Cameras show black

Each camera tile on the controller now says what is happening:

- **Connecting…**: the phone and laptop are still finding each other. This normally takes 1–3 seconds.
- **Network is blocking the video**: they could not find a direct route. The phone's badge stays on *0 viewers · N connecting*.

The usual reasons a direct route fails:

1. **The Wi-Fi isolates devices.** School, campus, hotel, venue and "guest" networks often block devices from talking to each other.
2. **A phone is on cellular** and not on the same Wi-Fi as the laptop.
3. A VPN or "Private Relay" is turned on on the phone or laptop.

Fixes, quickest first:

- Put every device on the **same private network**. A portable router, or a phone hotspot that the laptop and the camera phones all join, works well.
- Or set up the **camera relay** on the start page. See [Camera relay](#camera-relay-phones-on-different-wi-fi-school-networks). (Developers can also set `ICE_SERVERS_URL` / `ICE_SERVERS` in `config.js`.)

## Security note

The publishable key is designed to be visible in browser code, but anyone with it can use what the setup SQL allows. Anyone who has the page links and digs out the key could upload or delete show media, or send commands during the show. For a small show that is usually acceptable. To lock it down, add Supabase Auth (a show login) and change the policies in `setup.sql` from `anon` to `authenticated`.

## Settings

[`config.js`](config.js) contains:
- `SUPABASE_URL` and `SUPABASE_KEY`: your project.
- `BUCKET`: the storage bucket name.
- `ROOM`: devices with the same room name control the same show. Change it to run a separate rehearsal room.
