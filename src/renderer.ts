import type { NotePosition, FretboardState } from './types';
import { getNoteName, isNoteInScale, isRootNote } from './scales';
import { GEOMETRY_STABLE_TIME_MS } from './constants';

// Roboflow Design System Colors (Dark Mode)
const ROOT_NOTE_COLOR = '#FF6B6B'; // destructive
const SCALE_NOTE_COLOR = '#00FFCE'; // aquavision-500 (dark mode brand)
const NOTE_RADIUS = 14;
const FONT_SIZE = 11;
const FONT_FAMILY = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// Mirror x-coordinate to match the mirrored video
function mirrorX(x: number, canvasWidth: number): number {
  return canvasWidth - x;
}

export function renderOverlay(
  ctx: CanvasRenderingContext2D,
  notePositions: NotePosition[],
  scaleIntervals: number[],
  rootNote: number,
  fretboardState: FretboardState,
  showFretNumbers: boolean = true
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const canvasWidth = ctx.canvas.width;

  // Only show detection visualizations during calibration
  if (!fretboardState.isValid) {
    renderDetectedLandmarks(ctx, fretboardState, canvasWidth);
    renderDetectionLegend(ctx, canvasWidth, fretboardState.isValid);
    renderCalibratingStatus(ctx, fretboardState, canvasWidth);
    return;
  }

  // Optionally draw fret numbers
  if (showFretNumbers && fretboardState.fretPositions.length > 0) {
    renderFretNumbers(ctx, fretboardState, canvasWidth);
  }

  // Draw scale notes
  for (const pos of notePositions) {
    if (!isNoteInScale(pos.note, rootNote, scaleIntervals)) {
      continue;
    }

    const isRoot = isRootNote(pos.note, rootNote);
    const color = isRoot ? ROOT_NOTE_COLOR : SCALE_NOTE_COLOR;
    const noteName = getNoteName(pos.note);

    // Mirror x-coordinate to match mirrored video
    const mirroredX = mirrorX(pos.x, canvasWidth);
    drawNoteMarker(ctx, mirroredX, pos.y, noteName, color, isRoot);
  }
}

function drawNoteMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  noteName: string,
  color: string,
  isRoot: boolean
): void {
  ctx.save();

  // Draw circle
  ctx.beginPath();
  ctx.arc(x, y, NOTE_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.5;
  ctx.fill();

  // Draw border for root notes
  if (isRoot) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Draw note name
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(noteName, x, y);

  ctx.restore();
}

function renderFretNumbers(
  ctx: CanvasRenderingContext2D,
  state: FretboardState,
  canvasWidth: number
): void {
  const { fretPositions, nutX, nutCenterY, geometry } = state;

  if (fretPositions.length === 0) return;

  // Calculate Y position for fret numbers (below the fretboard)
  const fretboardHalfHeight = geometry.nutHeight / 2;
  const labelY = nutCenterY + fretboardHalfHeight + 25;

  ctx.save();
  ctx.fillStyle = '#888';
  ctx.font = `12px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Draw fret numbers for common marker positions
  const markerFrets = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];

  for (let fret = 1; fret <= fretPositions.length; fret++) {
    if (markerFrets.includes(fret)) {
      const fretX = fretPositions[fret - 1];
      const prevFretX = fret === 1 ? nutX : fretPositions[fret - 2];
      const centerX = (fretX + prevFretX) / 2;

      // Mirror x-coordinate to match mirrored video
      const mirroredX = mirrorX(centerX, canvasWidth);
      ctx.fillText(fret.toString(), mirroredX, labelY);
    }
  }

  ctx.restore();
}

function renderDetectionLegend(ctx: CanvasRenderingContext2D, canvasWidth: number, isCalibrated: boolean): void {
  ctx.save();

  // Background for legend
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(canvasWidth - 180, 5, 175, isCalibrated ? 55 : 35);

  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // Yellow = Detected
  ctx.fillStyle = '#FFD700';
  ctx.fillRect(canvasWidth - 170, 15, 20, 3);
  ctx.fillStyle = '#fff';
  ctx.fillText('Detected', canvasWidth - 145, 17);

  // Green dashed = Calculated (only show when calibrated)
  if (isCalibrated) {
    ctx.strokeStyle = 'rgba(0, 255, 100, 0.8)';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(canvasWidth - 170, 32);
    ctx.lineTo(canvasWidth - 150, 32);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.fillText('Calculated', canvasWidth - 145, 32);

    // Red = Fret 0
    ctx.fillStyle = '#FF6B6B';
    ctx.fillRect(canvasWidth - 170, 45, 20, 3);
    ctx.fillStyle = '#fff';
    ctx.fillText('Fret 0', canvasWidth - 145, 47);
  }

  ctx.restore();
}

function renderCalibratingStatus(ctx: CanvasRenderingContext2D, state: FretboardState, canvasWidth: number): void {
  // Draw status message at top
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(0, 0, canvasWidth, 80);

  ctx.fillStyle = '#fff';
  ctx.font = `16px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let message = 'Position your guitar in frame';
  let subMessage = '';

  // Show calibration progress
  if (state.nutX > 0 && state.soundholeX > 0) {
    if (!state.geometry.isLocked && state.geometry.stableStartTime > 0) {
      const elapsed = Date.now() - state.geometry.stableStartTime;
      const progress = Math.min(100, Math.round((elapsed / GEOMETRY_STABLE_TIME_MS) * 100));
      message = `Learning geometry... ${progress}%`;
      subMessage = `Frets detected: ${state.geometry.maxFretsSeen} - Hold still`;
    } else if (!state.geometry.isLocked) {
      message = 'Detecting fretboard...';
      subMessage = `Frets: ${state.geometry.maxFretsSeen} - Hold steady`;
    }
  } else if (state.nutX > 0) {
    message = 'Looking for soundhole...';
    subMessage = `Frets: ${state.detectedFretPositions.length} - Show guitar body`;
  } else if (state.soundholeX > 0) {
    message = 'Looking for headstock...';
    subMessage = 'Show the headstock area';
  }

  ctx.fillText(message, canvasWidth / 2, 30);

  if (subMessage) {
    ctx.font = `12px ${FONT_FAMILY}`;
    ctx.fillStyle = '#aaa';
    ctx.fillText(subMessage, canvasWidth / 2, 55);
  }

  ctx.restore();
}

function renderDetectedLandmarks(
  ctx: CanvasRenderingContext2D,
  state: FretboardState,
  canvasWidth: number
): void {
  ctx.save();

  // Draw detected nut (red vertical line)
  if (state.nutX > 0 && state.detectedNutY.top !== state.detectedNutY.bottom) {
    ctx.strokeStyle = '#FF6B6B';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const nutMirrorX = mirrorX(state.nutX, canvasWidth);
    ctx.moveTo(nutMirrorX, state.detectedNutY.top);
    ctx.lineTo(nutMirrorX, state.detectedNutY.bottom);
    ctx.stroke();

    // Label
    ctx.fillStyle = '#FF6B6B';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('FRET 0', nutMirrorX, state.detectedNutY.top - 8);
  }

  // Draw detected fret wires (yellow vertical lines)
  if (state.detectedFretPositions.length > 0 && state.detectedNutY.top !== state.detectedNutY.bottom) {
    ctx.strokeStyle = '#FFD700';
    ctx.lineWidth = 2;

    const fretHeight = state.detectedNutY.bottom - state.detectedNutY.top;

    state.detectedFretPositions.forEach((fretX, index) => {
      const mirroredX = mirrorX(fretX, canvasWidth);
      ctx.beginPath();
      ctx.moveTo(mirroredX, state.nutCenterY - fretHeight / 2);
      ctx.lineTo(mirroredX, state.nutCenterY + fretHeight / 2);
      ctx.stroke();

      // Fret number label
      ctx.fillStyle = '#FFD700';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText((index + 1).toString(), mirroredX, state.nutCenterY - fretHeight / 2 - 8);
    });
  }

  // Draw detected soundhole (cyan circle indicator)
  if (state.soundholeX > 0) {
    ctx.strokeStyle = '#00FFCE';
    ctx.lineWidth = 2;
    const shMirrorX = mirrorX(state.soundholeX, canvasWidth);
    ctx.beginPath();
    ctx.arc(shMirrorX, state.soundholeCenterY, 20, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#00FFCE';
    ctx.font = 'bold 10px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('BODY', shMirrorX, state.soundholeCenterY - 30);
  }

  ctx.restore();
}
