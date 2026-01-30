import type { Point, PredictionData, FretboardState, FretboardGeometry, NotePosition } from './types';
import { tunings, getNoteAtFret } from './tunings';

const CONFIDENCE_THRESHOLD = 0.5;
const FRET_CONFIDENCE_THRESHOLD = 0.65; // Higher confidence for fret wires to avoid false positives
const FRET_RATIO = Math.pow(2, -1 / 12); // ~0.9439
const ANCHOR_SMOOTHING = 0.5; // smoothing for real-time nut tracking
const SCALE_SMOOTHING = 0.4; // smoothing for height scale factor
const GEOMETRY_STABLE_TIME_MS = 1500; // 1.5 seconds of stable readings to lock geometry
const GEOMETRY_TOLERANCE_WIDTH = 15; // pixels tolerance for nutWidth consistency
const GEOMETRY_TOLERANCE_TAPER = 0.15; // tolerance for taperRatio consistency

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
    lastMeasurement: { nutWidth: 0, taperRatio: 0 },
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

// Count frets from detected positions
// TODO: Add interpolation for missed fret detections based on spacing analysis
function estimateFretCount(_nutX: number, fretPositions: number[]): number {
  return fretPositions.length;
}

// Calculate fret X positions from nut position using scale length
// minX is the detected last fret position - frets beyond this are not rendered
function calculateFretPositions(nutX: number, scaleLength: number, fretCount: number, minX: number = 0): number[] {
  if (nutX <= 0 || fretCount <= 0 || scaleLength <= 0) return [];

  const positions: number[] = [];
  for (let fret = 1; fret <= fretCount; fret++) {
    const distFromNut = scaleLength * (1 - Math.pow(FRET_RATIO, fret));
    const fretX = nutX - distFromNut;
    // Stop adding frets beyond the detected last fret position
    if (minX > 0 && fretX < minX) break;
    positions.push(fretX);
  }
  return positions;
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

// Get string Y position at X, accounting for axis angle and scale
function getStringY(
  state: FretboardState,
  stringIndex: number,
  stringCount: number,
  x: number
): number {
  const { nutX, nutCenterY, soundholeX, axisAngle, currentScale, geometry } = state;

  // Calculate the Y center at this X position following the axis angle
  const dx = x - nutX;
  const centerYAtX = nutCenterY + dx * Math.tan(axisAngle);

  // Get width at this X position and apply current scale
  const baseWidth = getWidthAtX(geometry, nutX, soundholeX, x);
  const scaledWidth = baseWidth * currentScale;
  const halfWidth = scaledWidth / 2;

  // String 0 at top, string (count-1) at bottom
  const t = stringIndex / (stringCount - 1);
  return centerYAtX - halfWidth + t * scaledWidth;
}

export function processPredictions(
  data: PredictionData,
  state: FretboardState,
  fretCount: number,
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

  // Add nut centroid
  if (nut && nut.points.length > 0) {
    const scaledNut = scalePoints(nut.points, scaleX, scaleY);
    const centroid = getCentroid(scaledNut);
    newState.nutX = smoothAnchor(state.nutX, centroid.x);
    newState.nutCenterY = smoothAnchor(state.nutCenterY, centroid.y);
    axisPoints.push({ x: centroid.x, y: centroid.y });
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
    // Collect all detected fret positions
    const detectedFretPositions: number[] = [];
    let minFretX = Infinity; // Furthest from nut = smallest X

    for (const fw of fretWires) {
      if (fw.points.length > 0) {
        const scaledFw = scalePoints(fw.points, scaleX, scaleY);
        const centroid = getCentroid(scaledFw);
        detectedFretPositions.push(centroid.x);
        if (centroid.x < minFretX) {
          minFretX = centroid.x;
        }
      }
    }

    // Estimate actual fret count by analyzing spacing (accounts for missed detections)
    const estimatedFretCount = newState.nutX > 0
      ? estimateFretCount(newState.nutX, detectedFretPositions)
      : detectedFretPositions.length;

    // Update maxFretsSeen and lastFretX when we have a good estimate
    if (estimatedFretCount >= state.geometry.maxFretsSeen && detectedFretPositions.length > 0 && newState.nutX > 0) {
      if (estimatedFretCount > state.geometry.maxFretsSeen) {
        newState.geometry.maxFretsSeen = estimatedFretCount;
      }

      if (minFretX < Infinity) {
        newState.geometry.lastFretX = smoothAnchor(state.geometry.lastFretX, minFretX);
      }
    } else if (estimatedFretCount > state.geometry.maxFretsSeen) {
      newState.geometry.maxFretsSeen = estimatedFretCount;
    }

    // Learn geometry when nut and soundhole are visible
    // Fretboard polygon is optional - we can estimate from nut and fret wires
    if (nut && soundhole) {
      const scaledNut = scalePoints(nut.points, scaleX, scaleY);

      // Get width at nut (from nut polygon)
      const nutWidth = getPolygonHeight(scaledNut);

      // Calculate taper ratio from fretboard polygon if available, otherwise use default
      let taperRatio = state.geometry.taperRatio;
      if (fretboard && fretboard.points.length > 0) {
        const scaledFretboard = scalePoints(fretboard.points, scaleX, scaleY);
        const scaledSoundhole = scalePoints(soundhole.points, scaleX, scaleY);
        const soundholeCentroid = getCentroid(scaledSoundhole);
        const pointsNearSoundhole = scaledFretboard.filter(
          p => Math.abs(p.x - soundholeCentroid.x) < 50
        );

        if (pointsNearSoundhole.length >= 2 && nutWidth > 0) {
          const endWidth = getPolygonHeight(pointsNearSoundhole);
          taperRatio = endWidth / nutWidth;
          // Clamp to reasonable range
          taperRatio = Math.max(0.5, Math.min(1.0, taperRatio));
        }
      }
      // If no fretboard polygon, use default taperRatio (0.75)

      if (nutWidth > 20) { // Valid measurement
        // Check if measurement is consistent with last measurement
        const { lastMeasurement } = state.geometry;
        const widthDiff = Math.abs(nutWidth - lastMeasurement.nutWidth);
        const taperDiff = Math.abs(taperRatio - lastMeasurement.taperRatio);
        const isConsistent = lastMeasurement.nutWidth === 0 ||
          (widthDiff < GEOMETRY_TOLERANCE_WIDTH && taperDiff < GEOMETRY_TOLERANCE_TAPER);

        if (isConsistent) {
          // Consistent measurement - smooth update
          newState.geometry.nutWidth = lastMeasurement.nutWidth === 0
            ? nutWidth
            : state.geometry.nutWidth * 0.8 + nutWidth * 0.2;
          newState.geometry.taperRatio = lastMeasurement.taperRatio === 0
            ? taperRatio
            : state.geometry.taperRatio * 0.8 + taperRatio * 0.2;
          newState.geometry.lastMeasurement = { nutWidth, taperRatio };

          // Start or continue stability timer
          if (state.geometry.stableStartTime === 0) {
            newState.geometry.stableStartTime = now;
          }

          // Check if stable for long enough
          const stableDuration = now - newState.geometry.stableStartTime;
          if (stableDuration >= GEOMETRY_STABLE_TIME_MS && newState.geometry.maxFretsSeen > 0) {
            newState.geometry.fretCount = newState.geometry.maxFretsSeen;

            // Calculate scale length from the last fret position
            // Formula: lastFretDistance = scaleLength * (1 - FRET_RATIO^fretCount)
            if (newState.nutX > 0 && newState.geometry.lastFretX > 0) {
              const lastFretDistance = Math.abs(newState.nutX - newState.geometry.lastFretX);
              const fretRatio = 1 - Math.pow(FRET_RATIO, newState.geometry.fretCount - 0.7);
              newState.geometry.scaleLength = lastFretDistance / fretRatio;
              newState.geometry.fretboardLength = lastFretDistance;
            }

            // Save soundhole distance for end boundary
            if (newState.nutX > 0 && newState.soundholeX > 0) {
              // Keep soundholeX for visual boundary, but scale length is from last fret
            }
            newState.geometry.isLocked = true;
          }
        } else {
          // Inconsistent - reset stability timer and update measurement
          newState.geometry.nutWidth = nutWidth;
          newState.geometry.taperRatio = taperRatio;
          newState.geometry.lastMeasurement = { nutWidth, taperRatio };
          newState.geometry.stableStartTime = now;
        }
      }
    } else {
      // Missing required detections - reset stability timer
      if (state.geometry.stableStartTime !== 0) {
        newState.geometry.stableStartTime = 0;
      }
    }
  }

  // Use locked fret count from geometry, or fallback to provided fretCount during calibration
  const effectiveFretCount = newState.geometry.isLocked
    ? newState.geometry.fretCount
    : Math.max(fretCount, newState.geometry.maxFretsSeen);

  // === CALCULATE FRET POSITIONS ===
  if (newState.nutX > 0 && newState.geometry.scaleLength > 0) {
    // Use the detected last fret position as the limit (frets can't go past actual frets)
    const minFretX = newState.geometry.lastFretX > 0 ? newState.geometry.lastFretX : 0;
    newState.fretPositions = calculateFretPositions(
      newState.nutX,
      newState.geometry.scaleLength,
      effectiveFretCount,
      minFretX
    );
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
    const nutY = getStringY(state, stringIndex, stringCount, nutX);
    positions.push({
      string: stringIndex + 1,
      fret: 0,
      x: nutX,
      y: nutY,
      note: openNote,
    });

    // Fretted notes - placed at the fret wire position
    const maxFret = Math.min(fretCount, fretPositions.length);
    for (let fret = 1; fret <= maxFret; fret++) {
      const noteX = fretPositions[fret - 1];
      const noteY = getStringY(state, stringIndex, stringCount, noteX);

      positions.push({
        string: stringIndex + 1,
        fret,
        x: noteX,
        y: noteY,
        note: getNoteAtFret(openNote, fret),
      });
    }
  }

  return positions;
}
