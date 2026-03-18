# Visionary Guitar

Real-time guitar scale visualization powered by computer vision. Point your webcam at a guitar and see scale patterns overlaid directly on the fretboard.

<!-- TODO: Add screenshot/gif here -->

## How It Works

1. Your webcam captures a live video of your guitar
2. The video streams to [Roboflow](https://roboflow.com/) via WebRTC for real-time inference
3. A custom Roboflow Workflow detects the nut, fret wires, and soundhole
4. The app calibrates fretboard geometry using detected landmarks
5. Scale note positions are calculated and rendered as a canvas overlay on the video

## Features

- Real-time fretboard detection and auto-calibration
- Fret interpolation using equal temperament geometric spacing
- 10 scales: Major, Minor, Pentatonic, Blues, Dorian, Mixolydian, and more
- 7 tunings: Standard, Drop D, Open G, DADGAD, and more
- Adjustable fret count with auto-detection
- Multiple camera support

## Tech Stack

- **Frontend**: TypeScript, Vite, Tailwind CSS, HTML5 Canvas
- **Backend**: Node.js, Express
- **AI/CV**: [Roboflow Inference SDK](https://github.com/roboflow/inference) (serverless API + WebRTC streaming)

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/)
- A [Roboflow](https://roboflow.com/) account and API key

### Setup

```bash
# Clone the repository
git clone https://github.com/felipe-tomino/visionary-guitar.git
cd visionary-guitar

# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env and add your Roboflow API key
```

### Development

```bash
pnpm dev
```

Opens at `http://localhost:5173` with hot reload. The Vite dev server proxies API requests to the Express backend.

### Production

```bash
pnpm build
pnpm start
```

Builds the frontend and starts the Express server on port 3000.

## Project Structure

```
src/
  main.ts          # App entry point, UI logic, WebRTC connection
  fretboard.ts     # Fretboard detection, calibration, geometry math
  renderer.ts      # Canvas overlay rendering
  scales.ts        # Scale definitions and music theory helpers
  tunings.ts       # Guitar tuning definitions (MIDI notes)
  types.ts         # TypeScript interfaces
  constants.ts     # Shared constants and configuration
  index.html       # UI markup
  style.css        # Styles (Tailwind CSS)
server.ts          # Express server with WebRTC proxy endpoint
```

## License

ISC
