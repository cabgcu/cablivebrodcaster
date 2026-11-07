# Canyon Night Live — show control

A show control system for the Canyon Night live talk show. One laptop runs everything. iPads and phones control it over Wi-Fi.

| Device | Page | What it does |
|---|---|---|
| **Laptop** → projector/TV | `/screen` | What the audience sees. Shows slides, videos and live cameras. **All audio** (videos and sound effects) plays from the laptop. |
| **iPad 1** | `/control` | Next / back, tap any slide or video to put it on screen, video transport (play, pause, scrub, ±10s, volume), cut to a live camera, black screen, cut/fade. |
| **iPad 2** | `/sound` | Soundboard pads. Sounds play on the **laptop**, not the iPad. Includes Stop all, Fade out all, master volume, and per-pad volume, loop and color. |
| **Phones** | `/camera` | Turns a phone into a live camera. The controller iPad sees a preview of every camera and can cut to any of them. The phone shows a red **ON AIR** tally light while it is live. |

## Setup (one time)

1. Install [Node.js](https://nodejs.org) 18 or newer on the show laptop.
2. In this folder, run:

```bash
npm install
```

## Show day

1. Connect the laptop, both iPads and the camera phones to the **same Wi-Fi network**.
2. On the laptop, run:

```bash
npm start
```

3. Open `http://localhost:3000` on the laptop. This start page has QR codes for every device.
4. **Audience screen:** click *Open* under Audience screen, drag that Chrome window onto the projector, then **click once**. That one click turns on sound and goes full screen. Browsers block sound until someone clicks the page, so the controller shows a yellow warning until this is done.
5. **iPad 1:** scan the *Show control* code. **iPad 2:** scan the *Soundboard* code. In Safari, Share → *Add to Home Screen* opens them full screen like an app.
6. **Phones:** scan the *Live camera* code. The first time, Safari warns that the connection isn't private. This is expected because the laptop makes its own certificate. Tap *Show Details* → *visit this website*, then allow camera access. Name the camera (e.g. "Wide shot") and tap **Go live-ready**.
   - Turn off Auto-Lock on camera phones, or keep them plugged in. A locked phone stops sending video.
   - Hold phones sideways for a 16:9 picture.

## Adding slides, videos and sounds

- **From an iPad:** use *＋ Add slides / videos* on the controller or *＋ Add sounds* on the soundboard.
- **On the laptop:** drop files into `media/show/` (slides and videos) or `media/sounds/`. Pages update automatically.
- Slides are images (PNG/JPG/WebP/GIF). Export a PowerPoint, Keynote, Canva or Google Slides deck as images.
- Videos: MP4 (H.264) is the most reliable format. MOV and WebM also work in Chrome.
- The rundown follows filename order (`01-…`, `02-…`). You can change it on the controller with *Reorder / delete*.

## Backup controls on the laptop

If an iPad dies, use the keyboard or a presentation clicker on the audience screen:
`→` / `Space` / `PageDown` = next, `←` / `PageUp` = back, `B` or `.` = black, `K` = play/pause video, `F` = full screen.

## Camera latency

Cameras use WebRTC directly over your local network. They connect at full quality as soon as they join and keep playing on the audience screen while hidden. A cut is therefore instant: nothing has to load or buffer. The camera-to-screen delay is typically about 0.1–0.3 s on good Wi-Fi. That is roughly the delay of a wireless video transmitter, but it is not literally zero.

To keep camera delay low:
- Use a good 5 GHz Wi-Fi router dedicated to the show, near the stage. Busy venue or guest Wi-Fi is the most common cause of lag or stutter.
- Choose 720p on the phone. Use 1080p only on a strong network.
- Keep the laptop plugged in and close other heavy apps.

## Notes

- Ports: `3000` (HTTP) and `3443` (HTTPS, required by phone cameras). Change them with the `PORT` and `HTTPS_PORT` environment variables.
- The self-signed certificate is stored in `.certs/`. It is regenerated if the laptop's network address changes, and phones then show the warning once more.
- Camera feeds are video only. Use the venue's microphones for sound.
- Media files, settings and certificates are not committed to git.
