import type { AppState } from './types';
import { scales, noteNames } from './scales';
import { tunings } from './tunings';
import { DEFAULT_FRET_COUNT, MAX_FRET_COUNT } from './constants';

export interface UIElements {
  cameraSelect: HTMLSelectElement;
  scaleSelect: HTMLSelectElement;
  rootSelect: HTMLSelectElement;
  tuningSelect: HTMLSelectElement;
  fretCountInput: HTMLInputElement;
  fretCountValue: HTMLSpanElement;
  statusIndicator: HTMLElement;
  statusText: HTMLElement;
  connectBtn: HTMLButtonElement;
  detectBtn: HTMLButtonElement;
}

export function getUIElements(): UIElements {
  return {
    cameraSelect: document.getElementById('camera-select') as HTMLSelectElement,
    scaleSelect: document.getElementById('scale-select') as HTMLSelectElement,
    rootSelect: document.getElementById('root-select') as HTMLSelectElement,
    tuningSelect: document.getElementById('tuning-select') as HTMLSelectElement,
    fretCountInput: document.getElementById('fret-count') as HTMLInputElement,
    fretCountValue: document.getElementById('fret-count-value') as HTMLSpanElement,
    statusIndicator: document.getElementById('status-indicator') as HTMLElement,
    statusText: document.getElementById('status-text') as HTMLElement,
    connectBtn: document.getElementById('connect-btn') as HTMLButtonElement,
    detectBtn: document.getElementById('detect-btn') as HTMLButtonElement,
  };
}

export function populateDropdowns(ui: UIElements, state: AppState): void {
  for (const [key, scale] of Object.entries(scales)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = scale.name;
    if (key === state.selectedScale) option.selected = true;
    ui.scaleSelect.appendChild(option);
  }

  for (let i = 0; i < noteNames.length; i++) {
    const option = document.createElement('option');
    option.value = i.toString();
    option.textContent = noteNames[i];
    if (i === state.rootNote) option.selected = true;
    ui.rootSelect.appendChild(option);
  }

  for (const [key, tuning] of Object.entries(tunings)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = tuning.name;
    if (key === state.selectedTuning) option.selected = true;
    ui.tuningSelect.appendChild(option);
  }

  ui.fretCountInput.value = state.fretCount.toString();
  ui.fretCountValue.textContent = state.fretCount.toString();
}

export function populateCameraDropdown(
  ui: UIElements,
  cameras: MediaDeviceInfo[],
  errorMessage?: string
): void {
  // Clear existing options except placeholder
  while (ui.cameraSelect.options.length > 1) {
    ui.cameraSelect.remove(1);
  }

  if (errorMessage) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = errorMessage;
    ui.cameraSelect.appendChild(option);
    return;
  }

  if (cameras.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No cameras found';
    ui.cameraSelect.appendChild(option);
    return;
  }

  cameras.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Camera ${index + 1}`;
    ui.cameraSelect.appendChild(option);
  });
}

export function updateStatus(ui: UIElements, connected: boolean, message: string): void {
  ui.statusIndicator.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  ui.statusText.textContent = message;
  ui.connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
  ui.connectBtn.classList.toggle('btn-primary', !connected);
  ui.connectBtn.classList.toggle('btn-destructive', connected);
}

export function setConnecting(ui: UIElements, connecting: boolean): void {
  ui.connectBtn.disabled = connecting;
  if (connecting) {
    ui.connectBtn.textContent = 'Connecting...';
  }
}

export function updateDetectButton(ui: UIElements, isDetecting: boolean, isConnected: boolean): void {
  if (!isConnected) {
    ui.detectBtn.disabled = true;
    ui.detectBtn.textContent = 'Reset Detection';
  } else if (isDetecting) {
    ui.detectBtn.disabled = true;
    ui.detectBtn.textContent = 'Detecting...';
  } else {
    ui.detectBtn.disabled = false;
    ui.detectBtn.textContent = 'Reset Detection';
  }
}

export function resetFretCountSlider(ui: UIElements): void {
  ui.fretCountInput.max = MAX_FRET_COUNT.toString();
  ui.fretCountInput.value = DEFAULT_FRET_COUNT.toString();
  ui.fretCountValue.textContent = DEFAULT_FRET_COUNT.toString();
}

export function setupCollapsibleControls(): void {
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
