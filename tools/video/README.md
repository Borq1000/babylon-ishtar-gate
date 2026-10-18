# Presentation film tools

Scripts that rendered `babylon-presentation-1080p.mp4` (see the [release](https://github.com/Borq1000/babylon-ishtar-gate/releases/tag/v1.0.0)) from the real-time scene. Not part of the web build.

- **`shots.js`** — the shot list. Each shot has a camera path (Catmull–Rom keyframes, an orbit, or a camera that tracks the procession), a time of day and a caption.
- **`page.js`** — runs inside the app. It drives the camera, the simulation and the captions deterministically, one frame at a time.
- **`render.js`** — headless Chrome on the GPU at 1.5× supersampling and the Ultra preset. Each shot is piped as JPEG frames into ffmpeg (`clips/<id>.mp4`). Run `stills` mode first to check compositions (`stills/`).
- **`audio.js`** — renders the app's own procedural soundscape offline, in sync with the camera.
  - The page's `AudioContext` is swapped for an `OfflineAudioContext` before the app starts.
  - Rendering pauses at every video frame, so camera, crowd and procession advance exactly as in the video (`audio/<id>.wav`).
- **`assemble.js`** — puts the film together:
  - 1-second dissolves between shots;
  - fades in and out;
  - loudness normalisation (−18 LUFS);
  - conversion to limited-range BT.709;
  - H.264 High / AAC encoding with `faststart`.

## Usage

Requirements: Google Chrome, ffmpeg on `PATH`, and a GPU with at least 4 GB of memory. Rendering one 1080p frame takes about 0.35–0.7 s on an RTX 2050 laptop.

```bash
# in the project root: build and serve the app on port 4173
npm run build
npx vite preview --port 4173

# in tools/video
npm install
npm run stills      # optional: first / middle / last frame of every shot
npm run audio       # audio/<id>.wav
npm run render      # clips/<id>.mp4 (resumable: finished clips are skipped)
npm run assemble    # babylon-presentation-1080p.mp4
```

Render one process at a time: two Ultra instances do not fit into 4 GB of video memory.
