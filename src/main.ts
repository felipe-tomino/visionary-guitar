import type { AppState, FretboardState, PredictionData } from './types';
import { scales } from './scales';
import { DEFAULT_FRET_COUNT } from './constants';
import { createInitialFretboardState, processPredictions, calculateNotePositions } from './fretboard';
import { renderOverlay } from './renderer';
import { getAvailableCameras, startCameraStream, stopStream } from './camera';
import { connectToRoboflow, type RoboflowConnection, type WorkflowParams } from './connection';
import {
  getUIElements, populateDropdowns, populateCameraDropdown,
  updateStatus, setConnecting, updateDetectButton, resetFretCountSlider,
  setupCollapsibleControls,
} from './ui';

// Feature flag: use new Roboflow Workflow pipeline (set to false to use legacy local processing)
const USE_WORKFLOW_PIPELINE = true;

// DOM
const videoElement = document.getElementById('video') as HTMLVideoElement;
const canvasElement = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvasElement.getContext('2d')!;
const ui = getUIElements();

// State
let appState: AppState = {
  selectedScale: 'major',
  rootNote: 2, // D
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

// === Workflow parameters ===

function getWorkflowParams(): WorkflowParams {
  return {
    scale_name: appState.selectedScale,
    root_note: appState.rootNote,
    tuning: appState.selectedTuning,
    fret_count: appState.fretCount,
  };
}

async function reconnectWithParams(): Promise<void> {
  if (!appState.isConnected || !connection || appState.isConnecting) return;

  appState.isConnecting = true;
  setConnecting(ui, true);
  updateConnectionStatus(true, 'Updating...');

  try {
    await connection.cleanup();
    connection = null;

    localStream = await startCameraStream(selectedDeviceId);
    videoElement.srcObject = localStream;

    const onData = USE_WORKFLOW_PIPELINE ? handleWorkflowData : handlePredictionData;
    const params = USE_WORKFLOW_PIPELINE ? getWorkflowParams() : undefined;
    connection = await connectToRoboflow(localStream, onData, params);

    appState.isConnecting = false;
    setConnecting(ui, false);
    updateConnectionStatus(true, 'Connected');

    try {
      const remoteStream = await connection.remoteStream();
      videoElement.srcObject = remoteStream;
      resizeCanvas();
    } catch {
      // Keep local stream if remote fails
    }
  } catch (error) {
    console.error('Failed to reconnect:', error);
    appState.isConnecting = false;
    setConnecting(ui, false);
    updateConnectionStatus(false, 'Reconnection failed');
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

    const onData = USE_WORKFLOW_PIPELINE ? handleWorkflowData : handlePredictionData;
    const params = USE_WORKFLOW_PIPELINE ? getWorkflowParams() : undefined;
    connection = await connectToRoboflow(localStream, onData, params);

    appState.isConnecting = false;
    setConnecting(ui, false);
    updateConnectionStatus(true, 'Connected');

    if (USE_WORKFLOW_PIPELINE) {
      // Workflow pipeline: hide canvas overlay, video track has annotations baked in
      canvasElement.style.display = 'none';
    }

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

// === Data handlers ===

function handleWorkflowData(_data: unknown): void {
  // In workflow pipeline mode, the annotated video comes via the video track.
  // The data channel is disabled (dataOutputNames: []).
  // Nothing to process here — the video element displays the annotated stream directly.
}

function handlePredictionData(data: unknown): void {
  const rawData = data as {
    serialized_output_data?: { predictions?: PredictionData };
    predictions?: PredictionData;
  };

  const predictions = rawData.serialized_output_data?.predictions || rawData.predictions;
  if (!predictions) return;

  const videoWidth = videoElement.videoWidth || canvasElement.width;
  const videoHeight = videoElement.videoHeight || canvasElement.height;

  fretboardState = processPredictions(predictions, fretboardState, videoWidth, videoHeight);
  render();
}

// === State helpers ===

function updateConnectionStatus(connected: boolean, message: string): void {
  appState.isConnected = connected;
  updateStatus(ui, connected, message);
  if (!USE_WORKFLOW_PIPELINE) {
    updateDetectButton(ui, !fretboardState.geometry.isLocked, appState.isConnected);
  }
}

function resetState(): void {
  fretboardState = createInitialFretboardState();
  appState.fretCountOverride = false;
  appState.fretCount = DEFAULT_FRET_COUNT;
  resetFretCountSlider(ui);
  ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasElement.style.display = '';
  if (!USE_WORKFLOW_PIPELINE) {
    updateDetectButton(ui, !fretboardState.geometry.isLocked, appState.isConnected);
  }
}

// === Rendering (legacy local pipeline) ===

function resizeCanvas(): void {
  if (videoElement.videoWidth && videoElement.videoHeight) {
    canvasElement.width = videoElement.videoWidth;
    canvasElement.height = videoElement.videoHeight;
  }
}

function render(): void {
  if (USE_WORKFLOW_PIPELINE) return; // Rendering handled by Roboflow Workflow

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
    if (USE_WORKFLOW_PIPELINE) {
      reconnectWithParams();
    } else {
      render();
    }
  });

  ui.rootSelect.addEventListener('change', () => {
    appState.rootNote = parseInt(ui.rootSelect.value, 10);
    if (USE_WORKFLOW_PIPELINE) {
      reconnectWithParams();
    } else {
      render();
    }
  });

  ui.tuningSelect.addEventListener('change', () => {
    appState.selectedTuning = ui.tuningSelect.value;
    if (USE_WORKFLOW_PIPELINE) {
      reconnectWithParams();
    } else {
      render();
    }
  });

  ui.fretCountInput.addEventListener('input', () => {
    appState.fretCount = parseInt(ui.fretCountInput.value, 10);
    appState.fretCountOverride = true;
    ui.fretCountValue.textContent = ui.fretCountInput.value;
    if (USE_WORKFLOW_PIPELINE) {
      reconnectWithParams();
    } else {
      render();
    }
  });

  ui.connectBtn.addEventListener('click', toggleConnection);
  ui.detectBtn.addEventListener('click', resetState);

  videoElement.addEventListener('loadedmetadata', resizeCanvas);
  videoElement.addEventListener('resize', resizeCanvas);
  window.addEventListener('resize', () => { resizeCanvas(); if (!USE_WORKFLOW_PIPELINE) render(); });

  initCameras();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
