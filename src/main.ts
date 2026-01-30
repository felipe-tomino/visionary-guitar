import { webrtc, streams, connectors } from '@roboflow/inference-sdk';
import type { PredictionData, AppState, FretboardState } from './types';
import { scales, noteNames } from './scales';
import { tunings } from './tunings';
import { createInitialFretboardState, processPredictions, calculateNotePositions } from './fretboard';
import { renderOverlay } from './renderer';

// DOM Elements
const videoElement = document.getElementById('video') as HTMLVideoElement;
const canvasElement = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvasElement.getContext('2d')!;
const cameraSelect = document.getElementById('camera-select') as HTMLSelectElement;
const scaleSelect = document.getElementById('scale-select') as HTMLSelectElement;
const rootSelect = document.getElementById('root-select') as HTMLSelectElement;
const tuningSelect = document.getElementById('tuning-select') as HTMLSelectElement;
const fretCountInput = document.getElementById('fret-count') as HTMLInputElement;
const fretCountValue = document.getElementById('fret-count-value') as HTMLSpanElement;
const statusIndicator = document.getElementById('status-indicator') as HTMLElement;
const statusText = document.getElementById('status-text') as HTMLElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const detectBtn = document.getElementById('detect-btn') as HTMLButtonElement;

// Application state
let appState: AppState = {
  selectedScale: 'major',
  rootNote: 2, // D
  selectedTuning: 'standard',
  fretCount: 12,
  fretCountOverride: false,
  isConnected: false,
  isConnecting: false,
};

let fretboardState: FretboardState = createInitialFretboardState();
let connection: Awaited<ReturnType<typeof webrtc.useStream>> | null = null;
let localStream: MediaStream | null = null;
let selectedDeviceId: string = '';

// Enumerate available video devices
async function enumerateCameras(): Promise<void> {
  try {
    // Request camera permission first to get device labels
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
    tempStream.getTracks().forEach(track => track.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');

    // Clear existing options except the first placeholder
    while (cameraSelect.options.length > 1) {
      cameraSelect.remove(1);
    }

    if (videoDevices.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No cameras found';
      cameraSelect.appendChild(option);
      return;
    }

    // Add video devices to dropdown
    videoDevices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${index + 1}`;
      cameraSelect.appendChild(option);
    });

    // Auto-select first camera if available
    if (videoDevices.length > 0 && !selectedDeviceId) {
      selectedDeviceId = videoDevices[0].deviceId;
      cameraSelect.value = selectedDeviceId;
      await startPreview();
    }
  } catch (error) {
    console.error('Failed to enumerate cameras:', error);
    updateStatus(false, 'Camera access denied');

    // Add error option to dropdown
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Camera access denied';
    cameraSelect.appendChild(option);
  }
}

// Start camera preview (local stream only, no Roboflow connection)
async function startPreview(): Promise<void> {
  // Stop existing preview if any
  if (localStream && !appState.isConnected) {
    streams.stopStream(localStream);
    localStream = null;
  }

  if (!selectedDeviceId) {
    videoElement.srcObject = null;
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: selectedDeviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });

    // Show local stream in video element
    videoElement.srcObject = localStream;
    resizeCanvas();
  } catch (error) {
    console.error('Failed to start camera preview:', error);
  }
}

// Initialize UI
function initializeUI(): void {
  // Populate scale dropdown
  for (const [key, scale] of Object.entries(scales)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = scale.name;
    if (key === appState.selectedScale) option.selected = true;
    scaleSelect.appendChild(option);
  }

  // Populate root note dropdown
  for (let i = 0; i < noteNames.length; i++) {
    const option = document.createElement('option');
    option.value = i.toString();
    option.textContent = noteNames[i];
    if (i === appState.rootNote) option.selected = true;
    rootSelect.appendChild(option);
  }

  // Populate tuning dropdown
  for (const [key, tuning] of Object.entries(tunings)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = tuning.name;
    if (key === appState.selectedTuning) option.selected = true;
    tuningSelect.appendChild(option);
  }

  // Set initial fret count
  fretCountInput.value = appState.fretCount.toString();
  fretCountValue.textContent = appState.fretCount.toString();

  // Event listeners
  cameraSelect.addEventListener('change', async () => {
    selectedDeviceId = cameraSelect.value;
    if (!appState.isConnected) {
      await startPreview();
    }
  });

  scaleSelect.addEventListener('change', () => {
    appState.selectedScale = scaleSelect.value;
    render();
  });

  rootSelect.addEventListener('change', () => {
    appState.rootNote = parseInt(rootSelect.value, 10);
    render();
  });

  tuningSelect.addEventListener('change', () => {
    appState.selectedTuning = tuningSelect.value;
    render();
  });

  fretCountInput.addEventListener('input', () => {
    appState.fretCount = parseInt(fretCountInput.value, 10);
    appState.fretCountOverride = true; // User manually set fret count
    fretCountValue.textContent = fretCountInput.value;
    render();
  });

  connectBtn.addEventListener('click', toggleConnection);

  // Detect guitar button
  detectBtn.addEventListener('click', resetDetection);

  // Controls panel collapse toggle
  const controlsToggle = document.getElementById('controls-toggle');
  const controlsContent = document.getElementById('controls-content');
  const controlsChevron = document.getElementById('controls-chevron');

  if (controlsToggle && controlsContent && controlsChevron) {
    controlsToggle.addEventListener('click', () => {
      controlsContent.classList.toggle('collapsed');
      controlsChevron.classList.toggle('collapsed');
    });
  }
}

function updateStatus(connected: boolean, message: string): void {
  appState.isConnected = connected;
  statusIndicator.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  statusText.textContent = message;
  connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
  updateDetectButton();
}

function setConnecting(connecting: boolean): void {
  appState.isConnecting = connecting;
  connectBtn.disabled = connecting;
  if (connecting) {
    connectBtn.textContent = 'Connecting...';
  }
}

function resetDetection(): void {
  // Reset the fretboard state to trigger re-detection
  fretboardState = createInitialFretboardState();
  appState.fretCountOverride = false;
  fretCountValue.textContent = appState.fretCount.toString();
  ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  updateDetectButton();
}

function updateDetectButton(): void {
  const isDetecting = !fretboardState.geometry.isLocked;
  const isConnected = appState.isConnected;

  if (!isConnected) {
    detectBtn.disabled = true;
    detectBtn.textContent = 'Detect Guitar';
  } else if (isDetecting) {
    detectBtn.disabled = true;
    detectBtn.textContent = 'Detecting...';
  } else {
    detectBtn.disabled = false;
    detectBtn.textContent = 'Detect Guitar';
  }
}

async function toggleConnection(): Promise<void> {
  if (appState.isConnecting) return;

  if (appState.isConnected && connection) {
    await connection.cleanup();
    connection = null;
    updateStatus(false, 'Disconnected');
    fretboardState = createInitialFretboardState();
    ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

    // Reset fret count display and override flag
    appState.fretCountOverride = false;
    fretCountValue.textContent = appState.fretCount.toString();

    // Restart preview with local stream
    await startPreview();
    return;
  }

  await startConnection();
}

async function startConnection(): Promise<void> {
  if (!selectedDeviceId) {
    updateStatus(false, 'Select a camera first');
    return;
  }

  setConnecting(true);
  updateStatus(false, 'Connecting...');

  try {
    // Stop preview stream first
    if (localStream) {
      streams.stopStream(localStream);
      localStream = null;
    }

    // Get camera stream with selected device
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: selectedDeviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });

    // Show local stream immediately
    videoElement.srcObject = localStream;

    // Create connector using proxy
    const connector = connectors.withProxyUrl('/api/init-webrtc');

    // Connect to Roboflow
    connection = await webrtc.useStream({
      source: localStream,
      connector,
      wrtcParams: {
        workspaceName: 'tominoprod',
        workflowId: 'guitar-predictions',
        imageInputName: 'image',
        dataOutputNames: ['predictions'],
      },
      onData: handlePredictionData,
    });

    // Mark as connected
    setConnecting(false);
    updateStatus(true, 'Connected');

    // Switch to remote stream (annotated video from Roboflow)
    try {
      const remoteStream = await connection.remoteStream();
      videoElement.srcObject = remoteStream;
      resizeCanvas();
    } catch {
      // Keep local stream if remote stream fails
    }
  } catch (error) {
    console.error('Failed to start WebRTC connection:', error);
    setConnecting(false);
    updateStatus(false, 'Connection failed');

    // Cleanup on error and restart preview
    if (localStream) {
      streams.stopStream(localStream);
      localStream = null;
    }
    await startPreview();
  }
}

function handlePredictionData(data: unknown): void {
  const rawData = data as {
    serialized_output_data?: {
      predictions?: PredictionData;
    };
    predictions?: PredictionData;
  };

  const predictions = rawData.serialized_output_data?.predictions || rawData.predictions;

  if (!predictions) {
    return;
  }

  // Get video dimensions for scaling predictions from model space to video space
  const videoWidth = videoElement.videoWidth || canvasElement.width;
  const videoHeight = videoElement.videoHeight || canvasElement.height;

  fretboardState = processPredictions(
    predictions,
    fretboardState,
    appState.fretCount,
    videoWidth,
    videoHeight
  );

  render();
}

function resizeCanvas(): void {
  if (videoElement.videoWidth && videoElement.videoHeight) {
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  }
}

function render(): void {
  const scale = scales[appState.selectedScale];
  if (!scale) return;

  // Use user's fret count if they manually changed it, otherwise use detected count
  const effectiveFretCount = appState.fretCountOverride
    ? appState.fretCount
    : fretboardState.geometry.isLocked
      ? fretboardState.geometry.fretCount
      : appState.fretCount;

  // Update UI to show detected fret count (only if user hasn't overridden)
  if (fretboardState.geometry.isLocked && !appState.fretCountOverride) {
    fretCountValue.textContent = `${fretboardState.geometry.fretCount} (detected)`;
  }

  const notePositions = calculateNotePositions(
    fretboardState,
    appState.selectedTuning,
    effectiveFretCount
  );

  renderOverlay(
    ctx,
    notePositions,
    scale.intervals,
    appState.rootNote,
    fretboardState
  );

  // Update detect button state
  updateDetectButton();
}

// Handle video resize
videoElement.addEventListener('loadedmetadata', resizeCanvas);
videoElement.addEventListener('resize', resizeCanvas);

// Window resize handler
window.addEventListener('resize', () => {
  resizeCanvas();
  render();
});

// Initialize when DOM is ready
function init(): void {
  initializeUI();
  enumerateCameras();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
