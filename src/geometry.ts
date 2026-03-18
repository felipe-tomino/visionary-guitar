import type { Point, FretboardGeometry, FretboardState } from './types';

// Equal temperament fret ratio: each fret spacing is 2^(-1/12) of the previous
export const FRET_RATIO = Math.pow(2, -1 / 12); // ~0.9439

// String positioning
const STRING_SPREAD_MARGIN = 0.9; // reduce string spread to stay within fretboard
const ANGLE_SPREAD_FACTOR = 0.5; // how much axis angle affects string spread

// Smoothing
const FRET_POSITION_SMOOTHING = 0.6;

// === Point utilities ===

export function scalePoints(points: Point[], scaleX: number, scaleY: number): Point[] {
  return points.map(p => ({ x: p.x * scaleX, y: p.y * scaleY }));
}

export function getCentroid(points: Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

export function getPolygonHeight(points: Point[]): number {
  if (points.length < 2) return 0;
  const ys = points.map(p => p.y);
  return Math.max(...ys) - Math.min(...ys);
}

// Exponential moving average for real-time smoothing
export function smoothValue(current: number, newValue: number, factor: number): number {
  if (current === 0) return newValue;
  return current + (newValue - current) * factor;
}

// === Line fitting ===

// Fit a line through points using linear regression, return angle in radians
export function fitLineAngle(points: Point[]): number {
  if (points.length < 2) return 0;

  const n = points.length;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.x - meanX) * (p.y - meanY);
    denominator += (p.x - meanX) ** 2;
  }

  if (Math.abs(denominator) < 0.001) return -Math.PI / 2;
  return Math.atan(numerator / denominator);
}

// === Fret geometry ===

// Calculate expected first fret spacing from locked geometry
export function calculateFirstFretSpacing(geometry: FretboardGeometry): number {
  if (!geometry.isLocked || geometry.fretboardLength <= 0 || geometry.fretCount <= 0) {
    return 0;
  }
  // fretboardLength = firstSpacing * (1 - FRET_RATIO^fretCount) / (1 - FRET_RATIO)
  const seriesSum = (1 - Math.pow(FRET_RATIO, geometry.fretCount)) / (1 - FRET_RATIO);
  return geometry.fretboardLength / seriesSum;
}

// Analyze detected fret positions and interpolate missing frets using geometric series
export function analyzeAndInterpolateFrets(
  nutX: number,
  detectedPositions: number[],
  maxFrets: number = 24,
  referenceFirstFretSpacing: number = 0
): { count: number; positions: number[] } {
  if (detectedPositions.length === 0) return { count: 0, positions: [] };
  if (detectedPositions.length === 1) return { count: 1, positions: [...detectedPositions] };

  const resultPositions: number[] = [];
  let prevX = nutX;

  // Use reference spacing if provided (from known geometry), otherwise derive from first detection
  const firstGap = nutX - detectedPositions[0];
  let expectedNextFretSpacing = referenceFirstFretSpacing > 0
    ? referenceFirstFretSpacing
    : firstGap;

  for (let i = 0; i < detectedPositions.length; i++) {
    const detectedX = detectedPositions[i];
    const gapSize = prevX - detectedX;
    if (gapSize <= 0) continue;

    // Determine how many frets fit in this gap
    let numFrets = 1;
    for (let n = 1; n <= 6; n++) {
      const expectedGapN = expectedNextFretSpacing * (1 - Math.pow(FRET_RATIO, n)) / (1 - FRET_RATIO);
      const expectedGapN1 = expectedNextFretSpacing * (1 - Math.pow(FRET_RATIO, n + 1)) / (1 - FRET_RATIO);

      if (gapSize < expectedGapN * 0.85) {
        numFrets = Math.max(1, n - 1);
        break;
      }

      // Threshold at 40% between n and n+1 (bias toward more frets)
      const threshold = expectedGapN + (expectedGapN1 - expectedGapN) * 0.4;
      if (gapSize < threshold) {
        numFrets = n;
        break;
      }

      numFrets = n + 1;
    }

    numFrets = Math.max(1, Math.min(numFrets, 6));

    if (numFrets === 1) {
      resultPositions.push(detectedX);
      expectedNextFretSpacing = gapSize * FRET_RATIO;
    } else {
      // Multiple frets - interpolate using geometric progression
      const totalRatioSum = (1 - Math.pow(FRET_RATIO, numFrets)) / (1 - FRET_RATIO);
      const firstFretInGapSpacing = gapSize / totalRatioSum;

      for (let j = 1; j <= numFrets; j++) {
        let accumulatedRatio = 0;
        for (let k = 0; k < j; k++) {
          accumulatedRatio += Math.pow(FRET_RATIO, k);
        }
        const t = accumulatedRatio / totalRatioSum;
        const interpolatedX = prevX - gapSize * t;
        // Last fret anchors to actual detection
        resultPositions.push(j === numFrets ? detectedX : interpolatedX);
      }

      expectedNextFretSpacing = firstFretInGapSpacing * Math.pow(FRET_RATIO, numFrets);
    }

    prevX = detectedX;
    if (resultPositions.length >= maxFrets) break;
  }

  return { count: resultPositions.length, positions: resultPositions };
}

// Smooth fret positions between frames to prevent jumping
export function smoothFretPositions(
  newPositions: number[],
  previousPositions: number[]
): number[] {
  if (previousPositions.length === 0) return newPositions;
  return newPositions.map((pos, i) =>
    i < previousPositions.length
      ? previousPositions[i] + (pos - previousPositions[i]) * FRET_POSITION_SMOOTHING
      : pos
  );
}

// Extend interpolated positions to target fret count using geometric progression
export function extendToFretCount(
  positions: number[],
  targetFretCount: number
): number[] {
  if (positions.length === 0 || positions.length >= targetFretCount) {
    return positions;
  }
  if (positions.length < 2) return positions;

  const extended = [...positions];
  let lastSpacing = positions[positions.length - 2] - positions[positions.length - 1];
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

// === Fretboard shape ===

// Get fretboard height at a given X position (perpendicular to axis)
export function getHeightAtX(geometry: FretboardGeometry, nutX: number, soundholeX: number, x: number): number {
  if (!geometry.isLocked || geometry.nutHeight === 0) return geometry.nutHeight || 50;

  const fretboardLength = nutX - soundholeX;
  if (fretboardLength <= 0) return geometry.nutHeight;

  // Linear interpolation from nut height to tapered height
  const t = Math.max(0, Math.min(1, (nutX - x) / fretboardLength));
  return geometry.nutHeight * (1 - t * (1 - geometry.taperRatio));
}

// Get string position at X, accounting for axis angle and taper
export function getStringPosition(
  state: FretboardState,
  stringIndex: number,
  stringCount: number,
  fretX: number
): { x: number; y: number } {
  const { nutX, nutCenterY, soundholeX, axisAngle, heightScale, geometry } = state;

  // Center point at this fret position following the axis angle
  const dx = fretX - nutX;
  const centerYAtFret = nutCenterY + dx * Math.tan(axisAngle);

  // Width at this position, scaled and with margin
  const baseWidth = getHeightAtX(geometry, nutX, soundholeX, fretX);
  const scaledWidth = baseWidth * heightScale * STRING_SPREAD_MARGIN;
  const halfWidth = scaledWidth / 2;

  // String 0 at top, string (count-1) at bottom
  const t = stringIndex / (stringCount - 1);
  const offsetFromCenter = -halfWidth + t * scaledWidth;

  // Blend between vertical and full perpendicular spread
  const effectiveAngle = axisAngle * ANGLE_SPREAD_FACTOR;
  const perpX = -Math.sin(effectiveAngle) * offsetFromCenter;
  const perpY = Math.cos(effectiveAngle) * offsetFromCenter;

  return {
    x: fretX + perpX,
    y: centerYAtFret + perpY,
  };
}
