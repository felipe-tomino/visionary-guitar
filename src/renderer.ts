import type { NotePosition, FretboardState } from './types';
import { getNoteName, isNoteInScale, isRootNote } from './scales';

// Roboflow Design System Colors (Dark Mode)
const ROOT_NOTE_COLOR = '#FF6B6B'; // destructive
const SCALE_NOTE_COLOR = '#00FFCE'; // aquavision-500 (dark mode brand)
const NOTE_RADIUS = 14;
const FONT_SIZE = 11;

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

  if (!fretboardState.isValid) {
    renderCalibrating(ctx, fretboardState);
    return;
  }

  const canvasWidth = ctx.canvas.width;

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
  ctx.font = `bold ${FONT_SIZE}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
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
  const fretboardHalfWidth = geometry.nutWidth / 2;
  const labelY = nutCenterY + fretboardHalfWidth + 25;

  ctx.save();
  ctx.fillStyle = '#888';
  ctx.font = '12px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
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

const GEOMETRY_STABLE_TIME_MS = 1500; // Must match fretboard.ts

function renderCalibrating(ctx: CanvasRenderingContext2D, state: FretboardState): void {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  ctx.fillStyle = '#fff';
  ctx.font = '18px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let message = 'Position your guitar in frame';
  let subMessage = '';
  let debugInfo = '';

  // Show calibration progress
  if (state.nutX > 0 && state.soundholeX > 0) {
    if (!state.geometry.isLocked && state.geometry.stableStartTime > 0) {
      const elapsed = Date.now() - state.geometry.stableStartTime;
      const progress = Math.min(100, Math.round((elapsed / GEOMETRY_STABLE_TIME_MS) * 100));
      message = 'Learning fretboard geometry...';
      subMessage = `${progress}% - hold still`;
      debugInfo = `Frets: ${state.geometry.maxFretsSeen} | Width: ${Math.round(state.geometry.nutWidth)}px`;
    } else if (!state.geometry.isLocked) {
      message = 'Detecting fretboard...';
      subMessage = 'Hold guitar steady';
      debugInfo = `Nut: ✓ | Soundhole: ✓ | Frets: ${state.geometry.maxFretsSeen}`;
    }
  } else if (state.nutX > 0) {
    message = 'Looking for soundhole...';
    subMessage = 'Show more of the guitar body';
    debugInfo = `Nut: ✓ | Frets: ${state.geometry.maxFretsSeen}`;
  } else if (state.soundholeX > 0) {
    message = 'Looking for nut...';
    subMessage = 'Show the headstock area';
  }

  ctx.fillText(message, ctx.canvas.width / 2, ctx.canvas.height / 2);

  if (subMessage) {
    ctx.font = '14px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText(subMessage, ctx.canvas.width / 2, ctx.canvas.height / 2 + 30);
  }

  if (debugInfo) {
    ctx.font = '12px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText(debugInfo, ctx.canvas.width / 2, ctx.canvas.height / 2 + 55);
  }

  ctx.restore();
}

export function renderDebugInfo(
  ctx: CanvasRenderingContext2D,
  state: FretboardState
): void {
  if (!state.isValid) return;

  const canvasWidth = ctx.canvas.width;
  const { nutX, nutCenterY, soundholeX, soundholeCenterY, axisAngle, currentScale, geometry, fretPositions } = state;

  ctx.save();
  ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
  ctx.lineWidth = 1;

  // Calculate scaled widths
  const nutHalfWidth = (geometry.nutWidth * currentScale) / 2;
  const endHalfWidth = (geometry.nutWidth * geometry.taperRatio * currentScale) / 2;

  // Draw fretboard outline following axis angle
  ctx.beginPath();
  ctx.moveTo(mirrorX(nutX, canvasWidth), nutCenterY - nutHalfWidth);
  ctx.lineTo(mirrorX(soundholeX, canvasWidth), soundholeCenterY - endHalfWidth);
  ctx.lineTo(mirrorX(soundholeX, canvasWidth), soundholeCenterY + endHalfWidth);
  ctx.lineTo(mirrorX(nutX, canvasWidth), nutCenterY + nutHalfWidth);
  ctx.closePath();
  ctx.stroke();

  // Draw fret lines following axis angle
  ctx.strokeStyle = 'rgba(255, 255, 0, 0.5)';
  for (const fretX of fretPositions) {
    // Calculate center Y at this fret position following axis
    const dx = fretX - nutX;
    const centerY = nutCenterY + dx * Math.tan(axisAngle);

    // Calculate width at this fret position
    const t = (nutX - fretX) / (nutX - soundholeX);
    const halfWidth = nutHalfWidth * (1 - t * (1 - geometry.taperRatio));

    ctx.beginPath();
    ctx.moveTo(mirrorX(fretX, canvasWidth), centerY - halfWidth);
    ctx.lineTo(mirrorX(fretX, canvasWidth), centerY + halfWidth);
    ctx.stroke();
  }

  // Draw nut marker
  ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mirrorX(nutX, canvasWidth), nutCenterY - nutHalfWidth);
  ctx.lineTo(mirrorX(nutX, canvasWidth), nutCenterY + nutHalfWidth);
  ctx.stroke();

  // Draw axis line (for debugging)
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mirrorX(nutX, canvasWidth), nutCenterY);
  ctx.lineTo(mirrorX(soundholeX, canvasWidth), soundholeCenterY);
  ctx.stroke();

  ctx.restore();
}
