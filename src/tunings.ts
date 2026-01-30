import type { Tuning } from './types';

// MIDI note numbers for open strings (string 6 to string 1, low E to high E)
export const tunings: Record<string, Tuning> = {
  standard: {
    name: 'Standard (EADGBE)',
    notes: [40, 45, 50, 55, 59, 64], // E2, A2, D3, G3, B3, E4
  },
  dropD: {
    name: 'Drop D (DADGBE)',
    notes: [38, 45, 50, 55, 59, 64], // D2, A2, D3, G3, B3, E4
  },
  halfStepDown: {
    name: 'Half Step Down (Eb)',
    notes: [39, 44, 49, 54, 58, 63], // Eb2, Ab2, Db3, Gb3, Bb3, Eb4
  },
  fullStepDown: {
    name: 'Full Step Down (D)',
    notes: [38, 43, 48, 53, 57, 62], // D2, G2, C3, F3, A3, D4
  },
  openG: {
    name: 'Open G (DGDGBD)',
    notes: [38, 43, 50, 55, 59, 62], // D2, G2, D3, G3, B3, D4
  },
  openD: {
    name: 'Open D (DADF#AD)',
    notes: [38, 45, 50, 54, 57, 62], // D2, A2, D3, F#3, A3, D4
  },
  dadgad: {
    name: 'DADGAD',
    notes: [38, 45, 50, 55, 57, 62], // D2, A2, D3, G3, A3, D4
  },
};

export function getNoteAtFret(openStringNote: number, fret: number): number {
  return openStringNote + fret;
}
