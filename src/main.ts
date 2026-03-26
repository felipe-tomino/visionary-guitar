import type { AppState, FretboardState, PredictionData } from './types';
import { scales } from './scales';
import { DEFAULT_FRET_COUNT } from './constants';
import { createInitialFretboardState, processPredictions, calculateNotePositions } from './fretboard';
import { renderOverlay } from './renderer';
import { getAvailableCameras, startCameraStream, stopStream } from './camera';
import { connectToRoboflow, type RoboflowConnection } from './connection';
import {
  getUIElements, populateDropdowns, populateCameraDropdown,
  updateStatus, setConnecting, updateDetectButton, resetFretCountSlider,
  setupCollapsibleControls,
} from './ui';

// DOM
const videoElement = document.getElementById('video') as HTMLVideoElement;
const canvasElement = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvasElement.getContext('2d')!;
const ui = getUIElements();

// State
let appState: AppState = {
  selectedScale: 'major',
  rootNote: 0, // C
  selectedTuning: 'standard',
  fretCount: DEFAULT_FRET_COUNT,
  fretCountOverride: false,
  isConnected: false,
  isConnecting: false,
};

let fretboardState: FretboardState = createInitialFretboardState();
let connection: RoboflowConnection | null = null;
let localStream: MediaStream | null = null;
let selectedDeviceId: string = '';

// === Camera ===

async function initCameras(): Promise<void> {
  try {
    const cameras = await getAvailableCameras();
    populateCameraDropdown(ui, cameras);

    if (cameras.length > 0) {
      selectedDeviceId = cameras[0].deviceId;
      ui.cameraSelect.value = selectedDeviceId;
      await startPreview();
    }
  } catch {
    updateConnectionStatus(false, 'Camera access denied');
    populateCameraDropdown(ui, [], 'Camera access denied');
  }
}

async function startPreview(): Promise<void> {
  if (localStream && !appState.isConnected) {
    stopStream(localStream);
    localStream = null;
  }

  if (!selectedDeviceId) {
    videoElement.srcObject = null;
    return;
  }

  try {
    localStream = await startCameraStream(selectedDeviceId);
    videoElement.srcObject = localStream;
    resizeCanvas();
  } catch (error) {
    console.error('Failed to start camera preview:', error);
  }
}

// === Connection ===

async function toggleConnection(): Promise<void> {
  if (appState.isConnecting) return;

  if (appState.isConnected && connection) {
    await connection.cleanup();
    connection = null;
    updateConnectionStatus(false, 'Disconnected');
    resetState();
    await startPreview();
    return;
  }

  if (!selectedDeviceId) {
    updateConnectionStatus(false, 'Select a camera first');
    return;
  }

  appState.isConnecting = true;
  setConnecting(ui, true);
  updateConnectionStatus(false, 'Connecting...');

  try {
    if (localStream) {
      stopStream(localStream);
      localStream = null;
    }

    localStream = await startCameraStream(selectedDeviceId);
    videoElement.srcObject = localStream;

    connection = await connectToRoboflow(localStream, handlePredictionData);

    appState.isConnecting = false;
    setConnecting(ui, false);
    updateConnectionStatus(true, 'Connected');

    try {
      const remoteStream = await connection.remoteStream();
      videoElement.srcObject = remoteStream;
      resizeCanvas();
    } catch {
      // Keep local stream if remote stream fails
    }
  } catch (error) {
    console.error('Failed to start WebRTC connection:', error);
    appState.isConnecting = false;
    setConnecting(ui, false);
    updateConnectionStatus(false, 'Connection failed');

    if (localStream) {
      stopStream(localStream);
      localStream = null;
    }
    await startPreview();
  }
}

// === Data handler ===

function handlePredictionData(data: unknown): void {
  const raw = data as {
    serialized_output_data?: { predictions?: PredictionData };
    predictions?: PredictionData;
  };
  const predictionData = raw.serialized_output_data?.predictions ?? raw.predictions;
  if (!predictionData?.predictions) return;

  const classes = predictionData.predictions.map(p => `${p.class}(${p.confidence?.toFixed(2)})`);
  console.log('[predictions]', classes.join(', '));

  fretboardState = processPredictions(
    predictionData,
    fretboardState,
    canvasElement.width,
    canvasElement.height,
  );
  render();
}

// === State helpers ===

function updateConnectionStatus(connected: boolean, message: string): void {
  appState.isConnected = connected;
  updateStatus(ui, connected, message);
  updateDetectButton(ui, !fretboardState.geometry.isLocked, appState.isConnected);
}

function resetState(): void {
  fretboardState = createInitialFretboardState();
  appState.fretCountOverride = false;
  appState.fretCount = DEFAULT_FRET_COUNT;
  resetFretCountSlider(ui);
  ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  updateDetectButton(ui, !fretboardState.geometry.isLocked, appState.isConnected);
}

async function resetDetection(): Promise<void> {
  if (!appState.isConnected || !connection || appState.isConnecting) return;

  // Disconnect to destroy server-side state
  await connection.cleanup();
  connection = null;
  resetState();
  updateConnectionStatus(false, 'Reconnecting...');

  // Reconnect with fresh pipeline
  appState.isConnecting = true;
  setConnecting(ui, true);

  try {
    localStream = await startCameraStream(selectedDeviceId);
    videoElement.srcObject = localStream;

    connection = await connectToRoboflow(localStream, handlePredictionData);

    appState.isConnecting = false;
    setConnecting(ui, false);
    updateConnectionStatus(true, 'Connected');

    try {
      const remoteStream = await connection.remoteStream();
      videoElement.srcObject = remoteStream;
      resizeCanvas();
    } catch {
      // Keep local stream if remote stream fails
    }
  } catch (error) {
    console.error('Failed to reconnect:', error);
    appState.isConnecting = false;
    setConnecting(ui, false);
    updateConnectionStatus(false, 'Reconnect failed');
    await startPreview();
  }
}

// === Rendering ===

function resizeCanvas(): void {
  if (videoElement.videoWidth && videoElement.videoHeight) {
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  }
}

function render(): void {
  const scale = scales[appState.selectedScale];
  if (!scale) return;

  // Update fret count slider after calibration
  if (fretboardState.geometry.isLocked) {
    const detectedFrets = fretboardState.geometry.fretCount;
    if (parseInt(ui.fretCountInput.max) !== detectedFrets) {
      ui.fretCountInput.max = detectedFrets.toString();

      if (appState.fretCount > detectedFrets) {
        appState.fretCount = detectedFrets;
        ui.fretCountInput.value = detectedFrets.toString();
      }

      if (!appState.fretCountOverride) {
        appState.fretCount = detectedFrets;
        ui.fretCountInput.value = detectedFrets.toString();
      }
    }
  }

  ui.fretCountValue.textContent = appState.fretCount.toString();

  const notePositions = calculateNotePositions(fretboardState, appState.selectedTuning, appState.fretCount);
  renderOverlay(ctx, notePositions, scale.intervals, appState.rootNote, fretboardState);
  updateDetectButton(ui, !fretboardState.geometry.isLocked, appState.isConnected);
}

// === Event wiring ===

function init(): void {
  populateDropdowns(ui, appState);
  setupCollapsibleControls();

  ui.cameraSelect.addEventListener('change', async () => {
    selectedDeviceId = ui.cameraSelect.value;
    if (!appState.isConnected) await startPreview();
  });

  ui.scaleSelect.addEventListener('change', () => {
    appState.selectedScale = ui.scaleSelect.value;
    render();
  });

  ui.rootSelect.addEventListener('change', () => {
    appState.rootNote = parseInt(ui.rootSelect.value, 10);
    render();
  });

  ui.tuningSelect.addEventListener('change', () => {
    appState.selectedTuning = ui.tuningSelect.value;
    render();
  });

  ui.fretCountInput.addEventListener('input', () => {
    appState.fretCount = parseInt(ui.fretCountInput.value, 10);
    appState.fretCountOverride = true;
    ui.fretCountValue.textContent = ui.fretCountInput.value;
    render();
  });

  ui.connectBtn.addEventListener('click', toggleConnection);
  ui.detectBtn.addEventListener('click', resetDetection);

  videoElement.addEventListener('loadedmetadata', resizeCanvas);
  videoElement.addEventListener('resize', resizeCanvas);
  window.addEventListener('resize', () => { resizeCanvas(); render(); });

  initCameras();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
