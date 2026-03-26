# Architecture

This document describes the technical architecture of Visionary Guitar: how real-time inference works, how the fretboard geometry is calibrated, and how the codebase is organized.

## System Overview

```
┌──────────┐    WebRTC stream    ┌──────────────────┐    predictions    ┌────────────────┐
│  Webcam  │ ──────────────────► │ Roboflow Serverless│ ──────────────► │ Canvas Overlay │
│          │                     │ Inference          │                  │                │
└──────────┘                     └──────────────────┘                  └────────────────┘
     │                                   ▲                                     │
     │    MediaStream API                │  WebRTC handshake                   │
     ▼                                   │  (proxied via Express)              ▼
┌──────────┐                     ┌──────────────────┐              ┌────────────────┐
│ Browser  │ ───────────────────►│  Express Server   │              │  HTML5 Canvas  │
│ (Client) │   POST /api/        │  (server.ts)      │              │  2D Context    │
└──────────┘   init-webrtc       └──────────────────┘              └────────────────┘
```

The browser captures webcam video and streams it to Roboflow's serverless infrastructure via WebRTC. Roboflow runs a custom workflow (`guitar-predictions`) and returns detection results on each frame. The client processes these predictions, calibrates fretboard geometry, and renders scale notes on an HTML5 Canvas overlay.

## Roboflow Integration

The entire Roboflow integration lives in two files:

### Client — `src/connection.ts`

Uses `@roboflow/inference-sdk` to open a WebRTC stream:

```ts
const connector = connectors.withProxyUrl('/api/init-webrtc');

webrtc.useStream({
  source: stream,       // MediaStream from webcam
  connector,            // routes handshake through our server
  wrtcParams: {
    workspaceName: 'tominoprod',
    workflowId: 'guitar-predictions',
    imageInputName: 'image',
    dataOutputNames: ['predictions'],
  },
  onData,               // callback for each frame's predictions
});
```

### Server — `server.ts`

A single Express endpoint that proxies the WebRTC handshake so the API key never reaches the client:

```ts
app.post('/api/init-webrtc', async (req, res) => {
  const client = InferenceHTTPClient.init({ apiKey: process.env.ROBOFLOW_API_KEY });
  const answer = await client.initializeWebrtcWorker({ offer, ...config });
  res.json(answer);
});
```

### Why WebRTC over REST

A REST approach would require capturing a frame, encoding it as JPEG, sending an HTTP POST, waiting for the response, and repeating. WebRTC establishes a persistent bidirectional stream — video frames flow to Roboflow continuously and predictions flow back with minimal latency.

## Detection Model

The Roboflow workflow detects four classes:

| Class | Purpose | Confidence Threshold |
|---|---|---|
| **Nut** | Anchor point at the headstock end of the fretboard | 0.3 |
| **Fret wire** | Individual metal frets across the fretboard | 0.65 |
| **Soundhole** | Anchor point at the body end of the fretboard | 0.3 |
| **Fretboard** | Polygon of the full playing surface (used for taper) | 0.3 |

Predictions include polygon points (not just bounding boxes), which allows precise geometric calculations.

Fret wires use a higher confidence threshold (0.65) because false positives in fret detection directly affect note placement. Detections within 15px of the nut or soundhole are also filtered out as likely false positives.

## Calibration Pipeline

Calibration runs every frame until geometry is locked, then switches to a lightweight tracking mode.

### Phase 1: Detection & Anchor Tracking

Each frame's predictions are classified by `calibration.ts:classifyPredictions()`. Anchor positions (nut, soundhole) are updated using exponential moving averages (60% smoothing factor) to prevent jitter.

The fretboard axis angle is computed by fitting a line through all detected centroids (nut, fret wires, soundhole) using linear regression.

### Phase 2: Fret Interpolation

The model rarely detects every fret — occlusion, lighting, and camera angle cause gaps. The app fills these gaps using the equal temperament geometric series.

On a guitar, each fret spacing equals the previous spacing multiplied by `2^(-1/12) ≈ 0.9439`. This is the same ratio that defines note frequencies — it's a physical property of the instrument, not an approximation.

`geometry.ts:analyzeAndInterpolateFrets()` walks through detected fret positions, estimates how many frets fit in each gap (using the expected geometric spacing), and interpolates missing positions. If the model detects 60% of the frets, the app reconstructs the rest accurately.

### Phase 3: Geometry Lock

During calibration, the app tracks:

- **Nut height** — perpendicular size of the nut polygon (smoothed)
- **Taper ratio** — fretboard width at the soundhole divided by width at the nut
- **Fret count** — number of interpolated frets
- **Fretboard length** — distance from nut to last detected fret

When the fret count remains stable for 1.5 seconds (`GEOMETRY_STABLE_TIME_MS`), geometry is locked. After lock:

- Small nut movements (< 5px) trigger a simple translation of all fret positions
- Larger movements trigger full re-interpolation using the locked geometry as reference
- The soundhole position is derived from the nut + learned fretboard length, so it no longer needs to be visible

### Smoothing

Multiple exponential moving averages run simultaneously to prevent visual jitter:

| Parameter | Smoothing Factor | Purpose |
|---|---|---|
| Anchor positions (nut, soundhole) | 0.6 | Prevents anchor jumping |
| Axis angle | 0.2 | Slow rotation response |
| Height scale | 0.3 | Gradual zoom adjustment |
| Fret positions | 0.6 | Smooth fret sliding |

## Note Calculation & Rendering

### Music Theory

Scales are defined as arrays of semitone intervals from the root note (e.g., Major = `[0, 2, 4, 5, 7, 9, 11]`). Tunings are arrays of MIDI note numbers for each open string.

For each string and fret, the MIDI note is `openStringNote + fret`. A note is in the scale if `(note - root) mod 12` matches any interval in the scale definition.

### String Positioning

`geometry.ts:getStringPosition()` calculates where each string crosses each fret, accounting for:

- Fretboard axis angle
- Taper (the fretboard narrows toward the body)
- A spread margin (90%) to keep notes within fretboard bounds
- Perspective angle blending to handle non-perpendicular camera views

### Canvas Rendering

`renderer.ts` draws the overlay on an HTML5 Canvas layered on top of the video element. All X coordinates are mirrored to match the browser's mirrored webcam display.

During calibration, the renderer shows detected landmarks (nut in red, fret wires in yellow, soundhole in cyan) and a progress indicator. After calibration, it draws note circles — root notes in red with a white border, scale notes in cyan.

## Project Structure

```
src/
├── main.ts           App entry point — state management, camera, event wiring
├── types.ts          TypeScript interfaces (Prediction, FretboardState, AppState, etc.)
├── constants.ts      Roboflow config, timing constants
├── connection.ts     WebRTC connection to Roboflow (23 lines)
├── camera.ts         MediaStream API wrapper
├── fretboard.ts      Prediction processing, anchor tracking, note position calculation
├── calibration.ts    Geometry learning, stability tracking, lock logic, fret collection
├── geometry.ts       Pure math — fret interpolation, smoothing, string positioning
├── renderer.ts       Canvas overlay rendering (notes, landmarks, calibration UI)
├── scales.ts         10 scale definitions as interval arrays
├── tunings.ts        7 tuning definitions as MIDI note arrays
├── ui.ts             DOM element management and UI state updates
├── index.html        Layout with video, canvas, and controls
└── style.css         Tailwind CSS + custom styles

server.ts             Express server — static file serving + WebRTC proxy endpoint
vite.config.ts        Vite build configuration (dev proxy, output settings)
render.yaml           Render.com deployment configuration
```

## Key Dependencies

- `@roboflow/inference-sdk` — WebRTC streaming and serverless inference
- `express` — Backend server for API key proxying
- `vite` — Frontend build tooling and dev server
- `tailwindcss` — Styling
