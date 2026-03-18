import type { Prediction, FretboardState } from './types';
import {
  scalePoints, getCentroid, getPolygonHeight, smoothValue,
  analyzeAndInterpolateFrets, smoothFretPositions, extendToFretCount,
  calculateFirstFretSpacing, FRET_RATIO,
} from './geometry';
import { GEOMETRY_STABLE_TIME_MS } from './constants';

// Detection confidence thresholds
const CONFIDENCE_THRESHOLD = 0.3;
const FRET_CONFIDENCE_THRESHOLD = 0.65;

// Filtering thresholds (pixels)
const MIN_FRET_NUT_DISTANCE = 15;
const MIN_FRET_BODY_DISTANCE = 15;
const NUT_STABILITY_THRESHOLD = 5;

// Smoothing factors for geometry learning (lower = smoother)
const GEOMETRY_SMOOTHING = 0.2;

// === Prediction classification ===

export interface ClassifiedDetections {
  fretboard: Prediction | undefined;
  nut: Prediction | undefined;
  soundhole: Prediction | undefined;
  fretWires: Prediction[];
}

export function classifyPredictions(predictions: Prediction[]): ClassifiedDetections {
  return {
    fretboard: predictions.find(p => p.class === 'fretboard' && p.confidence >= CONFIDENCE_THRESHOLD),
    nut: predictions.find(p => p.class === 'nut' && p.confidence >= CONFIDENCE_THRESHOLD),
    soundhole: predictions.find(p => p.class === 'soundhole' && p.confidence >= CONFIDENCE_THRESHOLD),
    fretWires: predictions.filter(p => p.class === 'fret wire' && p.confidence >= FRET_CONFIDENCE_THRESHOLD),
  };
}

// === Fret collection (shared between calibration and post-lock) ===

export function collectDetectedFrets(
  fretWires: Prediction[],
  nutX: number,
  soundholeX: number,
  scaleX: number,
  scaleY: number
): number[] {
  const positions: number[] = [];

  for (const fw of fretWires) {
    if (fw.points.length === 0) continue;
    const centroid = getCentroid(scalePoints(fw.points, scaleX, scaleY));

    // Filter out frets too close to nut or soundhole (likely false positives)
    if (nutX > 0 && nutX - centroid.x < MIN_FRET_NUT_DISTANCE) continue;
    if (soundholeX > 0 && centroid.x - soundholeX < MIN_FRET_BODY_DISTANCE) continue;

    positions.push(centroid.x);
  }

  // Sort from nut to body (descending X - nut has higher X)
  positions.sort((a, b) => b - a);
  return positions;
}

// === Geometry calibration (pre-lock) ===

export function calibrateGeometry(
  newState: FretboardState,
  prevState: FretboardState,
  detections: ClassifiedDetections,
  frets: number[],
  scaleX: number,
  scaleY: number
): void {
  // Analyze and interpolate missing frets
  const { count: estimatedFretCount, positions: interpolatedPositions } = newState.nutX > 0
    ? analyzeAndInterpolateFrets(newState.nutX, frets)
    : { count: frets.length, positions: frets };

  // Smooth fret positions against previous frame
  newState.fretPositions = smoothFretPositions(interpolatedPositions, prevState.fretPositions);

  // Track max frets seen
  if (estimatedFretCount > prevState.geometry.maxFretsSeen) {
    newState.geometry.maxFretsSeen = estimatedFretCount;
  }

  // Smooth last fret position
  const lastFretX = interpolatedPositions.length > 0
    ? interpolatedPositions[interpolatedPositions.length - 1]
    : Infinity;
  if (lastFretX < Infinity) {
    newState.geometry.lastFretX = smoothValue(prevState.geometry.lastFretX, lastFretX, 0.6);
  }

  // Learn geometry when both nut and soundhole are visible
  if (detections.nut && detections.soundhole && estimatedFretCount > 0) {
    learnGeometry(newState, prevState, detections, estimatedFretCount, scaleX, scaleY);
  } else {
    newState.geometry.stableStartTime = 0;
  }
}

function learnGeometry(
  newState: FretboardState,
  prevState: FretboardState,
  detections: ClassifiedDetections,
  estimatedFretCount: number,
  scaleX: number,
  scaleY: number
): void {
  // Learn nut height
  const scaledNut = scalePoints(detections.nut!.points, scaleX, scaleY);
  const nutHeight = getPolygonHeight(scaledNut);
  if (nutHeight > 20) {
    newState.geometry.nutHeight = prevState.geometry.nutHeight === 0
      ? nutHeight
      : prevState.geometry.nutHeight * (1 - GEOMETRY_SMOOTHING) + nutHeight * GEOMETRY_SMOOTHING;
  }

  // Learn taper ratio from fretboard polygon
  if (detections.fretboard && detections.fretboard.points.length > 0) {
    const scaledFretboard = scalePoints(detections.fretboard.points, scaleX, scaleY);
    const scaledSoundhole = scalePoints(detections.soundhole!.points, scaleX, scaleY);
    const soundholeCentroid = getCentroid(scaledSoundhole);
    const pointsNearSoundhole = scaledFretboard.filter(
      p => Math.abs(p.x - soundholeCentroid.x) < 50
    );

    if (pointsNearSoundhole.length >= 2 && nutHeight > 0) {
      const endWidth = getPolygonHeight(pointsNearSoundhole);
      const taperRatio = Math.max(0.5, Math.min(1.0, endWidth / nutHeight));
      newState.geometry.taperRatio = prevState.geometry.taperRatio * (1 - GEOMETRY_SMOOTHING) + taperRatio * GEOMETRY_SMOOTHING;
    }
  }

  // Check fret count stability
  const now = Date.now();
  const fretCountIsStable = estimatedFretCount === prevState.geometry.lastStableFretCount;

  if (fretCountIsStable) {
    if (prevState.geometry.stableStartTime === 0) {
      newState.geometry.stableStartTime = now;
    }

    const stableDuration = now - prevState.geometry.stableStartTime;
    if (stableDuration >= GEOMETRY_STABLE_TIME_MS) {
      lockGeometry(newState, estimatedFretCount);
    }
  } else {
    newState.geometry.stableStartTime = 0;
    newState.geometry.lastStableFretCount = estimatedFretCount;
  }
}

function lockGeometry(state: FretboardState, fretCount: number): void {
  state.geometry.fretCount = fretCount;

  if (state.nutX > 0 && state.geometry.lastFretX > 0) {
    const lastFretDistance = Math.abs(state.nutX - state.geometry.lastFretX);
    const fretRatio = 1 - Math.pow(FRET_RATIO, state.geometry.fretCount - 0.7);
    state.geometry.scaleLength = lastFretDistance / fretRatio;
    state.geometry.fretboardLength = lastFretDistance;
  }

  state.geometry.isLocked = true;
}

// === Post-lock fret position updates ===

export function updateLockedFretPositions(
  newState: FretboardState,
  prevState: FretboardState,
  frets: number[]
): void {
  const nutMovement = Math.abs(newState.nutX - prevState.nutX);
  const nutIsStable = nutMovement < NUT_STABILITY_THRESHOLD && prevState.fretPositions.length > 0;

  if (nutIsStable) {
    // Guitar is stable - adjust for small nut drift
    const nutDelta = newState.nutX - prevState.nutX;
    newState.fretPositions = prevState.fretPositions.map(x => x + nutDelta);
  } else if (newState.nutX > 0 && frets.length > 0) {
    // Guitar moved - recalculate with interpolation
    const referenceSpacing = calculateFirstFretSpacing(prevState.geometry);
    const { positions: interpolatedPositions } = analyzeAndInterpolateFrets(
      newState.nutX,
      frets,
      prevState.geometry.fretCount,
      referenceSpacing
    );

    const extendedPositions = extendToFretCount(
      interpolatedPositions,
      prevState.geometry.fretCount
    );

    newState.fretPositions = smoothFretPositions(extendedPositions, prevState.fretPositions);
  }
}
