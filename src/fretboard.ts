import type { Point, Prediction, PredictionData, FretboardState, FretboardGeometry, NotePosition } from './types';
import { tunings, getNoteAtFret } from './tunings';
import {
  scalePoints, getCentroid, getPolygonHeight, smoothValue,
  fitLineAngle, getStringPosition,
} from './geometry';
import {
  classifyPredictions, collectDetectedFrets,
  calibrateGeometry, updateLockedFretPositions,
  type ClassifiedDetections,
} from './calibration';

// Smoothing factors
const ANCHOR_SMOOTHING = 0.6;
const Y_ANCHOR_SMOOTHING = 0.6;
const ANGLE_SMOOTHING = 0.2;
const SCALE_SMOOTHING = 0.3;

function createInitialGeometry(): FretboardGeometry {
  return {
    nutHeight: 0,
    taperRatio: 0.75,
    fretCount: 0,
    fretboardLength: 0,
    scaleLength: 0,
    isLocked: false,
    stableStartTime: 0,
    lastStableFretCount: 0,
    maxFretsSeen: 0,
    lastFretX: 0,
  };
}

export function createInitialFretboardState(): FretboardState {
  return {
    nutX: 0,
    nutCenterY: 0,
    soundholeX: 0,
    soundholeCenterY: 0,
    axisAngle: 0,
    heightScale: 1,
    geometry: createInitialGeometry(),
    fretPositions: [],
    detectedFretPositions: [],
    detectedNutY: { top: 0, bottom: 0 },
    isValid: false,
  };
}

export function processPredictions(
  data: PredictionData,
  state: FretboardState,
  videoWidth?: number,
  videoHeight?: number
): FretboardState {
  const scaleX = videoWidth && data.image.width ? videoWidth / data.image.width : 1;
  const scaleY = videoHeight && data.image.height ? videoHeight / data.image.height : 1;
  const detections = classifyPredictions(data.predictions);

  const newState: FretboardState = {
    ...state,
    geometry: { ...state.geometry },
  };

  // Update anchor positions and axis angle from detections
  const axisPoints = extractAnchors(newState, state, detections, scaleX, scaleY);
  if (axisPoints.length >= 2) {
    const angle = fitLineAngle(axisPoints);
    newState.axisAngle = smoothValue(state.axisAngle, angle, ANGLE_SMOOTHING);
  }

  // After geometry locked, derive soundhole from nut + learned length
  if (state.geometry.isLocked && newState.nutX > 0 && state.geometry.fretboardLength > 0) {
    newState.soundholeX = newState.nutX - state.geometry.fretboardLength * Math.cos(newState.axisAngle);
    newState.soundholeCenterY = newState.nutCenterY - state.geometry.fretboardLength * Math.sin(newState.axisAngle);
  }

  // Update real-time scale factor from fret wire heights
  updateScaleFactor(newState, state, detections.fretWires, scaleX, scaleY);

  // Collect detected frets (shared between calibration and post-lock)
  const frets = collectDetectedFrets(detections.fretWires, newState.nutX, newState.soundholeX, scaleX, scaleY);
  newState.detectedFretPositions = frets;

  // Calibrate or update fret positions
  if (!state.geometry.isLocked) {
    calibrateGeometry(newState, state, detections, frets, scaleX, scaleY);
  } else {
    updateLockedFretPositions(newState, state, frets);
  }

  // Validate
  newState.isValid =
    newState.nutX > 0 &&
    newState.nutCenterY > 0 &&
    newState.geometry.isLocked &&
    newState.fretPositions.length > 0;

  return newState;
}

// Extract anchor positions from detections and return axis points for angle fitting
function extractAnchors(
  newState: FretboardState,
  prevState: FretboardState,
  detections: ClassifiedDetections,
  scaleX: number,
  scaleY: number
): Point[] {
  const axisPoints: Point[] = [];

  // Nut
  if (detections.nut?.points.length) {
    const scaledNut = scalePoints(detections.nut.points, scaleX, scaleY);
    const centroid = getCentroid(scaledNut);
    newState.nutX = smoothValue(prevState.nutX, centroid.x, ANCHOR_SMOOTHING);
    newState.nutCenterY = smoothValue(prevState.nutCenterY, centroid.y, Y_ANCHOR_SMOOTHING);
    axisPoints.push(centroid);

    const ys = scaledNut.map(p => p.y);
    newState.detectedNutY = { top: Math.min(...ys), bottom: Math.max(...ys) };
  }

  // Fret wires
  for (const fw of detections.fretWires) {
    if (fw.points.length > 0) {
      axisPoints.push(getCentroid(scalePoints(fw.points, scaleX, scaleY)));
    }
  }

  // Soundhole - use edge closest to nut for fretboard endpoint
  if (detections.soundhole?.points.length) {
    const scaledSH = scalePoints(detections.soundhole.points, scaleX, scaleY);
    const fretboardEnd = scaledSH.reduce((max, p) => p.x > max.x ? p : max, scaledSH[0]);
    axisPoints.push(getCentroid(scaledSH));

    // During calibration, track the fretboard end position
    if (!prevState.geometry.isLocked) {
      newState.soundholeX = smoothValue(prevState.soundholeX, fretboardEnd.x, ANCHOR_SMOOTHING);
      newState.soundholeCenterY = smoothValue(prevState.soundholeCenterY, fretboardEnd.y, Y_ANCHOR_SMOOTHING);
    }
  }

  return axisPoints;
}

// Update scale factor based on detected fret wire heights vs learned geometry
function updateScaleFactor(
  newState: FretboardState,
  prevState: FretboardState,
  fretWires: Prediction[],
  scaleX: number,
  scaleY: number
): void {
  if (fretWires.length === 0 || !prevState.geometry.isLocked || prevState.geometry.nutHeight === 0) return;

  let totalHeight = 0;
  let count = 0;
  for (const fw of fretWires) {
    if (fw.points.length > 0) {
      const height = getPolygonHeight(scalePoints(fw.points, scaleX, scaleY));
      if (height > 10) {
        totalHeight += height;
        count++;
      }
    }
  }

  if (count > 0) {
    const avgDetectedHeight = totalHeight / count;
    const expectedAvgHeight = prevState.geometry.nutHeight * (1 + prevState.geometry.taperRatio) / 2;
    const scale = avgDetectedHeight / expectedAvgHeight;
    newState.heightScale = prevState.heightScale === 1
      ? scale
      : prevState.heightScale + (scale - prevState.heightScale) * SCALE_SMOOTHING;
  }
}

export function calculateNotePositions(
  state: FretboardState,
  tuningKey: string,
  fretCount: number
): NotePosition[] {
  if (!state.isValid) return [];

  const tuning = tunings[tuningKey];
  if (!tuning) return [];

  const { nutX, fretPositions } = state;
  const stringCount = tuning.notes.length;
  const positions: NotePosition[] = [];

  for (let stringIndex = 0; stringIndex < stringCount; stringIndex++) {
    const openNote = tuning.notes[stringIndex];

    // Open string at nut
    const nutPos = getStringPosition(state, stringIndex, stringCount, nutX);
    positions.push({ string: stringIndex + 1, fret: 0, x: nutPos.x, y: nutPos.y, note: openNote });

    // Fretted notes - placed in the middle of fret spacing (where you press)
    const maxFret = Math.min(fretCount, fretPositions.length);
    for (let fret = 1; fret <= maxFret; fret++) {
      const prevFretX = fret === 1 ? nutX : fretPositions[fret - 2];
      const midFretX = (prevFretX + fretPositions[fret - 1]) / 2;
      const notePos = getStringPosition(state, stringIndex, stringCount, midFretX);
      positions.push({ string: stringIndex + 1, fret, x: notePos.x, y: notePos.y, note: getNoteAtFret(openNote, fret) });
    }
  }

  return positions;
}
