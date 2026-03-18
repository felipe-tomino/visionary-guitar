export interface Point {
  x: number;
  y: number;
}

export interface Prediction {
  class: 'fretboard' | 'nut' | 'soundhole' | 'fret wire';
  class_id: number;
  confidence: number;
  points: Point[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PredictionData {
  image: {
    width: number;
    height: number;
  };
  predictions: Prediction[];
}

export interface Scale {
  name: string;
  intervals: number[];
}

export interface Tuning {
  name: string;
  notes: number[]; // MIDI note numbers for each string (low to high)
}

export interface NotePosition {
  string: number;
  fret: number;
  x: number;
  y: number;
  note: number; // MIDI note number
}

// Learned fretboard geometry - locked once stable during calibration
export interface FretboardGeometry {
  nutHeight: number; // height of fretboard at nut (pixels)
  taperRatio: number; // width at soundhole / width at nut (< 1, fretboard narrows)
  fretCount: number; // number of frets visible on the fretboard
  fretboardLength: number; // X distance from nut to last fret (learned)
  scaleLength: number; // calculated scale length of the guitar
  isLocked: boolean;
  // Time-based stability tracking (based on fret count)
  stableStartTime: number; // timestamp when stable fret count started
  lastStableFretCount: number; // last fret count that was stable
  // Tracking during calibration
  maxFretsSeen: number;
  lastFretX: number; // X position of the furthest fret from nut (during calibration)
}

export interface FretboardState {
  // Anchor positions (updated each frame when visible)
  nutX: number; // X position of nut
  nutCenterY: number; // Y center at nut position
  soundholeX: number; // X position of soundhole
  soundholeCenterY: number; // Y center at soundhole position

  // Real-time axis and scale (calculated from anchors)
  axisAngle: number; // angle of fretboard axis in radians
  heightScale: number; // real-time Y scale factor based on detected fret wire heights

  // Learned geometry (locked once stable, includes fret count)
  geometry: FretboardGeometry;

  // Calculated from geometry
  fretPositions: number[]; // X positions of each fret wire

  // Raw detected positions (for rendering during calibration)
  detectedFretPositions: number[]; // X positions of detected fret wires
  detectedNutY: { top: number; bottom: number }; // Y bounds of detected nut

  isValid: boolean;
}

export interface AppState {
  selectedScale: string;
  rootNote: number;
  selectedTuning: string;
  fretCount: number;
  fretCountOverride: boolean; // true if user manually changed fret count
  isConnected: boolean;
  isConnecting: boolean;
}
