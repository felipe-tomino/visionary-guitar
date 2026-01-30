import type { Scale } from './types';

export const scales: Record<string, Scale> = {
  major: {
    name: 'Major',
    intervals: [0, 2, 4, 5, 7, 9, 11],
  },
  minor: {
    name: 'Minor (Natural)',
    intervals: [0, 2, 3, 5, 7, 8, 10],
  },
  pentatonicMajor: {
    name: 'Pentatonic Major',
    intervals: [0, 2, 4, 7, 9],
  },
  pentatonicMinor: {
    name: 'Pentatonic Minor',
    intervals: [0, 3, 5, 7, 10],
  },
  blues: {
    name: 'Blues',
    intervals: [0, 3, 5, 6, 7, 10],
  },
  harmonicMinor: {
    name: 'Harmonic Minor',
    intervals: [0, 2, 3, 5, 7, 8, 11],
  },
  melodicMinor: {
    name: 'Melodic Minor',
    intervals: [0, 2, 3, 5, 7, 9, 11],
  },
  dorian: {
    name: 'Dorian',
    intervals: [0, 2, 3, 5, 7, 9, 10],
  },
  mixolydian: {
    name: 'Mixolydian',
    intervals: [0, 2, 4, 5, 7, 9, 10],
  },
  phrygian: {
    name: 'Phrygian',
    intervals: [0, 1, 3, 5, 7, 8, 10],
  },
};

export const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function getNoteName(midiNote: number): string {
  return noteNames[midiNote % 12];
}

export function isNoteInScale(midiNote: number, rootNote: number, scaleIntervals: number[]): boolean {
  const interval = ((midiNote - rootNote) % 12 + 12) % 12;
  return scaleIntervals.includes(interval);
}

export function isRootNote(midiNote: number, rootNote: number): boolean {
  return midiNote % 12 === rootNote % 12;
}
