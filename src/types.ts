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
  nutWidth: number; // height of fretboard at nut (pixels)
  taperRatio: number; // width at soundhole / width at nut (< 1, fretboard narrows)
  fretCount: number; // number of frets visible on the fretboard
  fretboardLength: number; // X distance from nut to last fret (learned)
  scaleLength: number; // calculated scale length of the guitar
  isLocked: boolean;
  // Time-based stability tracking
  stableStartTime: number; // timestamp when stable measurements started
  lastMeasurement: { nutWidth: number; taperRatio: number };
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
  currentScale: number; // current Y scale factor based on detected heights

  // Learned geometry (locked once stable, includes fret count)
  geometry: FretboardGeometry;

  // Calculated from geometry
  fretPositions: number[]; // X positions of each fret wire

  lastUpdateTime: number;
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
