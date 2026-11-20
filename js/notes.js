// Pitch helpers. MIDI: middle C (C4) = 60, A4 = 69 = 440 Hz. B♭1 = 34, B♭5 = 82.

const NAMES_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function midiName(m, preferSharps = false) {
  const r = Math.round(m);
  const names = preferSharps ? NAMES_SHARP : NAMES_FLAT;
  return names[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

/** Written-to-concert offsets (semitones added to the written pitch to get sounding pitch). */
export const TRANSPOSITIONS = {
  auto: { label: 'Auto-detect', semis: null },
  concert: { label: 'Concert pitch (bass/tenor clef)', semis: 0 },
  bbTreble: { label: 'B♭ treble clef (sounds a 9th lower)', semis: -14 },
  bbTreble8va: { label: 'B♭ treble, sounding 8va (sounds a 2nd lower)', semis: -2 },
};
