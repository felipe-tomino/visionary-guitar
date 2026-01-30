import type { Point, PredictionData, FretboardState, FretboardGeometry, NotePosition } from './types';
import { tunings, getNoteAtFret } from './tunings';

const CONFIDENCE_THRESHOLD = 0.3;
const FRET_CONFIDENCE_THRESHOLD = 0.65; // Higher confidence for fret wires to avoid false positives
const FRET_RATIO = Math.pow(2, -1 / 12); // ~0.9439
const ANCHOR_SMOOTHING = 0.6; // smoothing for real-time nut tracking
const SCALE_SMOOTHING = 0.4; // smoothing for height scale factor
const FRET_POSITION_SMOOTHING = 0.6; // smoothing for fret X positions to prevent jumping
const NUT_STABILITY_THRESHOLD = 5; // pixels - if nut moves less than this, consider guitar stable
const STRING_SPREAD_MARGIN = 0.9; // reduce string spread to stay within fretboard (1.0 = full width)
const ANGLE_SPREAD_FACTOR = 0.5; // how much axis angle affects string spread (0 = vertical, 1 = full perpendicular)
const GEOMETRY_STABLE_TIME_MS = 1500; // 1.5 seconds of stable fret count to lock geometry
const MIN_FRET_NUT_DISTANCE = 15; // minimum pixels between nut and first fret (filter false positives)
const MIN_FRET_BODY_DISTANCE = 15; // minimum pixels between soundhole and last fret (filter false positives)

// Initial geometry state
function createInitialGeometry(): FretboardGeometry {
  return {
    nutWidth: 0,
    taperRatio: 0.75, // default taper ratio
    fretCount: 0,
    fretboardLength: 0, // distance from nut to last fret
    scaleLength: 0, // calculated scale length
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
    currentScale: 1,
    geometry: createInitialGeometry(),
    fretPositions: [],
    detectedFretPositions: [],
    detectedNutY: { top: 0, bottom: 0 },
    lastUpdateTime: 0,
    isValid: false,
  };
}

// Scale points from model to video coordinates
function scalePoints(points: Point[], scaleX: number, scaleY: number): Point[] {
  return points.map(p => ({ x: p.x * scaleX, y: p.y * scaleY }));
}

function getCentroid(points: Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function getPolygonHeight(points: Point[]): number {
  if (points.length < 2) return 0;
  const ys = points.map(p => p.y);
  return Math.max(...ys) - Math.min(...ys);
}

// Smooth anchor position for real-time tracking (follows movement, no rejection)
function smoothAnchor(current: number, newValue: number): number {
  if (current === 0) return newValue;
  return current + (newValue - current) * ANCHOR_SMOOTHING;
}

// Fit a line through points and return the angle (using linear regression)
function fitLineAngle(points: Point[]): number {
  if (points.length < 2) return 0;

  // Calculate means
  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;

  // Calculate slope using least squares
  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    numerator += dx * dy;
    denominator += dx * dx;
  }

  // Avoid division by zero (vertical line)
  if (Math.abs(denominator) < 0.001) return -Math.PI / 2;

  const slope = numerator / denominator;
  return Math.atan(slope);
}

// Analyze detected fret positions and interpolate missing frets
// Key constraint: fret spacing ALWAYS decreases (each spacing = previous * FRET_RATIO)
// If we see a spacing >= previous spacing, frets are missing
function analyzeAndInterpolateFrets(
  nutX: number,
  detectedPositions: number[],
  maxFrets: number = 24 // Safety cap
): { count: number; positions: number[] } {
  if (detectedPositions.length === 0) return { count: 0, positions: [] };
  if (detectedPositions.length === 1) return { count: 1, positions: [...detectedPositions] };

  // Positions should already be sorted from nut to body (descending X)
  const firstSpacing = nutX - detectedPositions[0];
  if (firstSpacing <= 0) return { count: detectedPositions.length, positions: [...detectedPositions] };

  // Build interpolated positions using the constraint that spacing always decreases
  const interpolatedPositions: number[] = [];
  let expectedSpacing = firstSpacing; // Start with first fret spacing
  let prevX = nutX;

  for (let i = 0; i < detectedPositions.length; i++) {
    const detectedX = detectedPositions[i];
    const actualSpacing = prevX - detectedX;

    // Calculate how many frets this gap represents
    // Key rule: spacing should decrease. If actual >= expected, frets are missing
    let fretGaps = 1;

    // Only interpolate if spacing is significantly larger than expected
    if (actualSpacing > expectedSpacing * 1.3) {
      // Use geometric series: find n where sum of n spacings ≈ actualSpacing
      // Sum = expectedSpacing * (1 - FRET_RATIO^n) / (1 - FRET_RATIO)
      // Solve for n: n = log(1 - actualSpacing * (1 - FRET_RATIO) / expectedSpacing) / log(FRET_RATIO)
      const ratio = actualSpacing / expectedSpacing;
      fretGaps = Math.round(ratio);
      fretGaps = Math.max(1, Math.min(fretGaps, 4)); // Cap between 1 and 4
    }

    // Safety: don't exceed max frets
    if (interpolatedPositions.length + fretGaps > maxFrets) {
      fretGaps = Math.max(1, maxFrets - interpolatedPositions.length);
    }

    if (fretGaps === 1) {
      // Single fret - use detected position
      interpolatedPositions.push(detectedX);
      // Update expected spacing for next iteration (should decrease)
      expectedSpacing = actualSpacing * FRET_RATIO;
    } else {
      // Multiple frets - interpolate missing ones using geometric progression
      const gapStartX = prevX;
      const gapEndX = detectedX;
      const totalRatioSum = (1 - Math.pow(FRET_RATIO, fretGaps)) / (1 - FRET_RATIO);

      for (let j = 1; j <= fretGaps; j++) {
        if (interpolatedPositions.length >= maxFrets) break;

        if (j < fretGaps) {
          let accumulatedRatio = 0;
          for (let k = 0; k < j; k++) {
            accumulatedRatio += Math.pow(FRET_RATIO, k);
          }
          const t = accumulatedRatio / totalRatioSum;
          interpolatedPositions.push(gapStartX - (gapStartX - gapEndX) * t);
        } else {
          interpolatedPositions.push(detectedX);
        }
      }

      // Update expected spacing for next iteration
      expectedSpacing = (actualSpacing / fretGaps) * FRET_RATIO;
    }

    prevX = detectedX;

    // Safety check
    if (interpolatedPositions.length >= maxFrets) break;
  }

  return { count: interpolatedPositions.length, positions: interpolatedPositions };
}

// Smooth fret positions between frames to prevent jumping
function smoothFretPositions(
  newPositions: number[],
  previousPositions: number[]
): number[] {
  if (previousPositions.length === 0) return newPositions;

  const smoothedPositions: number[] = [];

  for (let i = 0; i < newPositions.length; i++) {
    if (i < previousPositions.length) {
      // Smooth against previous frame's position at same index
      const smoothed = previousPositions[i] + (newPositions[i] - previousPositions[i]) * FRET_POSITION_SMOOTHING;
      smoothedPositions.push(smoothed);
    } else {
      // New fret that wasn't in previous frame - use as-is
      smoothedPositions.push(newPositions[i]);
    }
  }

  return smoothedPositions;
}

// Extend interpolated positions to target fret count using geometric progression
function extendToFretCount(
  positions: number[],
  targetFretCount: number
): number[] {
  if (positions.length === 0 || positions.length >= targetFretCount) {
    return positions;
  }

  const extended = [...positions];

  // Calculate spacing from last two frets to extrapolate
  let lastSpacing: number;
  if (positions.length >= 2) {
    lastSpacing = positions[positions.length - 2] - positions[positions.length - 1];
  } else {
    return positions; // Can't extrapolate with only one fret
  }

  // Add missing frets using geometric progression
  let prevX = positions[positions.length - 1];
  let currentSpacing = lastSpacing * FRET_RATIO;

  while (extended.length < targetFretCount) {
    const nextX = prevX - currentSpacing;
    extended.push(nextX);
    prevX = nextX;
    currentSpacing *= FRET_RATIO;
  }

  return extended;
}

// Get fretboard width at a given X position using geometry
function getWidthAtX(geometry: FretboardGeometry, nutX: number, soundholeX: number, x: number): number {
  if (!geometry.isLocked || geometry.nutWidth === 0) return geometry.nutWidth || 50;

  const fretboardLength = nutX - soundholeX;
  if (fretboardLength <= 0) return geometry.nutWidth;

  // Linear interpolation from nut width to tapered width
  const t = (nutX - x) / fretboardLength; // 0 at nut, 1 at soundhole
  const clampedT = Math.max(0, Math.min(1, t));
  return geometry.nutWidth * (1 - clampedT * (1 - geometry.taperRatio));
}

// Get string position at X, accounting for axis angle and scale
// Returns both X and Y because strings spread perpendicular to the axis
function getStringPosition(
  state: FretboardState,
  stringIndex: number,
  stringCount: number,
  fretX: number
): { x: number; y: number } {
  const { nutX, nutCenterY, soundholeX, axisAngle, currentScale, geometry } = state;

  // Calculate the center point at this fret position following the axis angle
  const dx = fretX - nutX;
  const centerYAtFret = nutCenterY + dx * Math.tan(axisAngle);

  // Get width at this X position and apply current scale
  // Apply margin to keep notes within the fretboard
  const baseWidth = getWidthAtX(geometry, nutX, soundholeX, fretX);
  const scaledWidth = baseWidth * currentScale * STRING_SPREAD_MARGIN;
  const halfWidth = scaledWidth / 2;

  // String 0 at top, string (count-1) at bottom
  // Spread perpendicular to the axis, but softened by ANGLE_SPREAD_FACTOR
  const t = stringIndex / (stringCount - 1);
  const offsetFromCenter = -halfWidth + t * scaledWidth;

  // Blend between vertical spread (angle=0) and full perpendicular spread
  // This makes the string spread look more natural
  const effectiveAngle = axisAngle * ANGLE_SPREAD_FACTOR;
  const perpX = -Math.sin(effectiveAngle) * offsetFromCenter;
  const perpY = Math.cos(effectiveAngle) * offsetFromCenter;

  return {
    x: fretX + perpX,
    y: centerYAtFret + perpY,
  };
}

export function processPredictions(
  data: PredictionData,
  state: FretboardState,
  _fretCount: number, // unused - we detect fret count from the video
  videoWidth?: number,
  videoHeight?: number
): FretboardState {
  const predictions = data.predictions;
  const modelWidth = data.image.width;
  const modelHeight = data.image.height;
  const scaleX = videoWidth && modelWidth ? videoWidth / modelWidth : 1;
  const scaleY = videoHeight && modelHeight ? videoHeight / modelHeight : 1;

  // Find predictions (use higher confidence for fret wires to avoid false positives)
  const fretboard = predictions.find(p => p.class === 'fretboard' && p.confidence >= CONFIDENCE_THRESHOLD);
  const nut = predictions.find(p => p.class === 'nut' && p.confidence >= CONFIDENCE_THRESHOLD);
  const soundhole = predictions.find(p => p.class === 'soundhole' && p.confidence >= CONFIDENCE_THRESHOLD);
  const fretWires = predictions.filter(p => p.class === 'fret wire' && p.confidence >= FRET_CONFIDENCE_THRESHOLD);

  const newState: FretboardState = {
    ...state,
    geometry: { ...state.geometry },
    lastUpdateTime: Date.now(),
  };

  // === COLLECT ALL AXIS POINTS (for real-time angle calculation) ===
  // Use nut, fret wires, and soundhole centroids to fit the fretboard axis
  const axisPoints: Point[] = [];

  // Add nut centroid and store Y bounds for rendering
  if (nut && nut.points.length > 0) {
    const scaledNut = scalePoints(nut.points, scaleX, scaleY);
    const centroid = getCentroid(scaledNut);
    newState.nutX = smoothAnchor(state.nutX, centroid.x);
    newState.nutCenterY = smoothAnchor(state.nutCenterY, centroid.y);
    axisPoints.push({ x: centroid.x, y: centroid.y });

    // Store Y bounds for rendering during calibration
    const ys = scaledNut.map(p => p.y);
    newState.detectedNutY = { top: Math.min(...ys), bottom: Math.max(...ys) };
  }

  // Add fret wire centroids (they lie along the fretboard axis)
  for (const fw of fretWires) {
    if (fw.points.length > 0) {
      const scaledFw = scalePoints(fw.points, scaleX, scaleY);
      const centroid = getCentroid(scaledFw);
      axisPoints.push(centroid);
    }
  }

  // Add soundhole - use the edge closest to the nut (fretboard ends there, not at center)
  if (soundhole && soundhole.points.length > 0) {
    const scaledSoundhole = scalePoints(soundhole.points, scaleX, scaleY);

    // Find the point with highest X (closest to nut) - this is where fretboard meets soundhole
    const fretboardEndPoint = scaledSoundhole.reduce((max, p) => p.x > max.x ? p : max, scaledSoundhole[0]);

    // Use centroid for axis fitting (center of soundhole is on the axis)
    const centroid = getCentroid(scaledSoundhole);
    axisPoints.push(centroid);

    // During calibration, track the fretboard end position (edge of soundhole)
    if (!state.geometry.isLocked) {
      newState.soundholeX = smoothAnchor(state.soundholeX, fretboardEndPoint.x);
      newState.soundholeCenterY = smoothAnchor(state.soundholeCenterY, fretboardEndPoint.y);
    }
  }

  // === CALCULATE AXIS ANGLE from all detected points (real-time) ===
  if (axisPoints.length >= 2) {
    const angle = fitLineAngle(axisPoints);
    newState.axisAngle = smoothAnchor(state.axisAngle, angle);
  }

  // === CALCULATE SOUNDHOLE POSITION (after geometry locked) ===
  // Use nut position + learned fretboard length along the calculated axis
  if (state.geometry.isLocked && newState.nutX > 0 && state.geometry.fretboardLength > 0) {
    newState.soundholeX = newState.nutX - state.geometry.fretboardLength * Math.cos(newState.axisAngle);
    newState.soundholeCenterY = newState.nutCenterY - state.geometry.fretboardLength * Math.sin(newState.axisAngle);
  }

  // === CALCULATE REAL-TIME SCALE from fret wire heights ===
  if (fretWires.length > 0 && state.geometry.isLocked && state.geometry.nutWidth > 0) {
    // Get average height from detected fret wires
    let totalHeight = 0;
    let count = 0;
    for (const fw of fretWires) {
      if (fw.points.length > 0) {
        const scaledFw = scalePoints(fw.points, scaleX, scaleY);
        const height = getPolygonHeight(scaledFw);
        if (height > 10) { // Valid height
          totalHeight += height;
          count++;
        }
      }
    }
    if (count > 0) {
      const avgDetectedHeight = totalHeight / count;
      // Calculate scale relative to learned nutWidth
      // Account for taper: average fret is roughly at taperRatio * 0.7 of nutWidth
      const expectedAvgHeight = state.geometry.nutWidth * (1 + state.geometry.taperRatio) / 2;
      const scale = avgDetectedHeight / expectedAvgHeight;
      // Smooth the scale factor
      newState.currentScale = state.currentScale === 1
        ? scale
        : state.currentScale + (scale - state.currentScale) * SCALE_SMOOTHING;
    }
  }

  // === LEARN GEOMETRY (lock once stable for GEOMETRY_STABLE_TIME_MS) ===
  // During calibration, we learn nutWidth, taperRatio, fretCount, and scale length
  const now = Date.now();

  if (!state.geometry.isLocked) {
    // Collect all detected fret positions, filtering out false positives
    const detectedFretPositions: number[] = [];

    for (const fw of fretWires) {
      if (fw.points.length > 0) {
        const scaledFw = scalePoints(fw.points, scaleX, scaleY);
        const centroid = getCentroid(scaledFw);

        // Filter out frets too close to the nut (likely false positives)
        if (newState.nutX > 0 && newState.nutX - centroid.x < MIN_FRET_NUT_DISTANCE) {
          continue;
        }

        // Filter out frets too close to the soundhole/body (likely false positives)
        if (newState.soundholeX > 0 && centroid.x - newState.soundholeX < MIN_FRET_BODY_DISTANCE) {
          continue;
        }

        detectedFretPositions.push(centroid.x);
      }
    }

    // Sort positions from nut to body (descending X - nut has higher X)
    detectedFretPositions.sort((a, b) => b - a);

    // Store raw detections for rendering
    newState.detectedFretPositions = detectedFretPositions;

    // Analyze and interpolate missing frets
    const { count: estimatedFretCount, positions: interpolatedPositions } = newState.nutX > 0
      ? analyzeAndInterpolateFrets(newState.nutX, detectedFretPositions)
      : { count: detectedFretPositions.length, positions: detectedFretPositions };

    // Smooth fret positions against previous frame to prevent jumping
    const smoothedPositions = smoothFretPositions(interpolatedPositions, state.fretPositions);
    newState.fretPositions = smoothedPositions;

    // Get the position of the last fret
    const lastFretX = interpolatedPositions.length > 0
      ? interpolatedPositions[interpolatedPositions.length - 1]
      : Infinity;

    // Update maxFretsSeen (tracks the highest fret count we've estimated)
    if (estimatedFretCount > state.geometry.maxFretsSeen) {
      newState.geometry.maxFretsSeen = estimatedFretCount;
    }

    // Smooth the lastFretX position
    if (lastFretX < Infinity && interpolatedPositions.length > 0) {
      newState.geometry.lastFretX = smoothAnchor(state.geometry.lastFretX, lastFretX);
    }

    // Learn geometry when nut and soundhole are visible
    if (nut && soundhole && estimatedFretCount > 0) {
      const scaledNut = scalePoints(nut.points, scaleX, scaleY);
      const nutWidth = getPolygonHeight(scaledNut);

      // Update nut width (smoothed)
      if (nutWidth > 20) {
        newState.geometry.nutWidth = state.geometry.nutWidth === 0
          ? nutWidth
          : state.geometry.nutWidth * 0.8 + nutWidth * 0.2;
      }

      // Calculate taper ratio from fretboard polygon if available
      if (fretboard && fretboard.points.length > 0) {
        const scaledFretboard = scalePoints(fretboard.points, scaleX, scaleY);
        const scaledSoundhole = scalePoints(soundhole.points, scaleX, scaleY);
        const soundholeCentroid = getCentroid(scaledSoundhole);
        const pointsNearSoundhole = scaledFretboard.filter(
          p => Math.abs(p.x - soundholeCentroid.x) < 50
        );

        if (pointsNearSoundhole.length >= 2 && nutWidth > 0) {
          const endWidth = getPolygonHeight(pointsNearSoundhole);
          let taperRatio = endWidth / nutWidth;
          taperRatio = Math.max(0.5, Math.min(1.0, taperRatio));
          newState.geometry.taperRatio = state.geometry.taperRatio * 0.8 + taperRatio * 0.2;
        }
      }

      // Check fret count stability (this is the main stability criterion)
      const fretCountIsStable = estimatedFretCount === state.geometry.lastStableFretCount;

      if (fretCountIsStable) {
        // Fret count is stable - continue or start timer
        if (state.geometry.stableStartTime === 0) {
          newState.geometry.stableStartTime = now;
        }

        // Check if stable for long enough to lock
        const stableDuration = now - state.geometry.stableStartTime;
        if (stableDuration >= GEOMETRY_STABLE_TIME_MS) {
          newState.geometry.fretCount = estimatedFretCount;

          // Calculate scale length from the last fret position
          if (newState.nutX > 0 && newState.geometry.lastFretX > 0) {
            const lastFretDistance = Math.abs(newState.nutX - newState.geometry.lastFretX);
            const fretRatio = 1 - Math.pow(FRET_RATIO, newState.geometry.fretCount - 0.7);
            newState.geometry.scaleLength = lastFretDistance / fretRatio;
            newState.geometry.fretboardLength = lastFretDistance;
          }

          newState.geometry.isLocked = true;
        }
      } else {
        // Fret count changed - reset timer and update last stable count
        newState.geometry.stableStartTime = 0;
        newState.geometry.lastStableFretCount = estimatedFretCount;
      }
    } else {
      // Missing required detections - reset stability timer
      newState.geometry.stableStartTime = 0;
    }
  }

  // After geometry is locked, use nut stability to decide whether to recalculate frets
  if (state.geometry.isLocked) {
    // Still collect detected frets for visualization (yellow lines)
    const detectedFretPositions: number[] = [];
    for (const fw of fretWires) {
      if (fw.points.length > 0) {
        const scaledFw = scalePoints(fw.points, scaleX, scaleY);
        const centroid = getCentroid(scaledFw);

        if (newState.nutX > 0 && newState.nutX - centroid.x < MIN_FRET_NUT_DISTANCE) {
          continue;
        }
        if (newState.soundholeX > 0 && centroid.x - newState.soundholeX < MIN_FRET_BODY_DISTANCE) {
          continue;
        }
        detectedFretPositions.push(centroid.x);
      }
    }
    detectedFretPositions.sort((a, b) => b - a);
    newState.detectedFretPositions = detectedFretPositions;

    // Check if nut position is stable (guitar hasn't moved)
    const nutMovement = Math.abs(newState.nutX - state.nutX);
    const nutIsStable = nutMovement < NUT_STABILITY_THRESHOLD && state.fretPositions.length > 0;

    if (nutIsStable) {
      // Guitar is stable - keep previous fret positions, just adjust for small nut drift
      const nutDelta = newState.nutX - state.nutX;
      newState.fretPositions = state.fretPositions.map(x => x + nutDelta);
    } else if (newState.nutX > 0 && detectedFretPositions.length > 0) {
      // Guitar moved - recalculate from detections
      const { positions: interpolatedPositions } = analyzeAndInterpolateFrets(
        newState.nutX,
        detectedFretPositions,
        state.geometry.fretCount
      );

      // Extend to known fret count if last frets are not visible
      const extendedPositions = extendToFretCount(
        interpolatedPositions,
        state.geometry.fretCount
      );

      // Smooth against previous frame
      newState.fretPositions = smoothFretPositions(extendedPositions, state.fretPositions);
    }
  }

  // === VALIDATION ===
  newState.isValid =
    newState.nutX > 0 &&
    newState.nutCenterY > 0 &&
    newState.geometry.isLocked &&
    newState.fretPositions.length > 0;

  return newState;
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

    // Open string (fret 0) at nut
    const nutPos = getStringPosition(state, stringIndex, stringCount, nutX);
    positions.push({
      string: stringIndex + 1,
      fret: 0,
      x: nutPos.x,
      y: nutPos.y,
      note: openNote,
    });

    // Fretted notes - placed in the middle of fret spacing (where you press)
    const maxFret = Math.min(fretCount, fretPositions.length);
    for (let fret = 1; fret <= maxFret; fret++) {
      // Calculate midpoint between previous fret (or nut) and current fret wire
      const prevFretX = fret === 1 ? nutX : fretPositions[fret - 2];
      const currentFretX = fretPositions[fret - 1];
      const midFretX = (prevFretX + currentFretX) / 2;
      const notePos = getStringPosition(state, stringIndex, stringCount, midFretX);

      positions.push({
        string: stringIndex + 1,
        fret,
        x: notePos.x,
        y: notePos.y,
        note: getNoteAtFret(openNote, fret),
      });
    }
  }

  return positions;
}
