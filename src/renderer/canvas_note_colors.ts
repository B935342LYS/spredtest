/**
 * note pitch class에 대응되는 canvas 색상 팔레트를 제공한다.
 */

const NOTE_COLORS: Record<number, { main: string; alt: string }> = {
  0: { main: "#ff3b30", alt: "#b62a22" },
  1: { main: "#ff3b30", alt: "#b62a22" },
  2: { main: "#ff9500", alt: "#b56a00" },
  3: { main: "#ff9500", alt: "#b56a00" },
  4: { main: "#ffcc00", alt: "#b89200" },
  5: { main: "#34c759", alt: "#23873c" },
  6: { main: "#34c759", alt: "#23873c" },
  7: { main: "#5ac8fa", alt: "#2a7ea6" },
  8: { main: "#5ac8fa", alt: "#2a7ea6" },
  9: { main: "#007aff", alt: "#0052ad" },
  10: { main: "#007aff", alt: "#0052ad" },
  11: { main: "#af52de", alt: "#6f3390" },
};
const NOTE_COLORS_OPTIONAL: Record<number, { main: string; alt: string }> = {
  0: { main: "#ff9f99", alt: "#ffc1bd" },
  1: { main: "#ff9f99", alt: "#ffc1bd" },
  2: { main: "#ffbf80", alt: "#ffd6a8" },
  3: { main: "#ffbf80", alt: "#ffd6a8" },
  4: { main: "#ffe699", alt: "#fff0bf" },
  5: { main: "#8fe1a6", alt: "#b3edc3" },
  6: { main: "#8fe1a6", alt: "#b3edc3" },
  7: { main: "#9fd8f5", alt: "#c3e9fb" },
  8: { main: "#9fd8f5", alt: "#c3e9fb" },
  9: { main: "#9fbfff", alt: "#c3d6ff" },
  10: { main: "#9fbfff", alt: "#c3d6ff" },
  11: { main: "#d6b0f0", alt: "#e6cff7" },
};
const NOTE_COLORS_LABEL: Record<number, { main: string; alt: string }> = {
  0: { main: "#8f2f2b", alt: "#692723" },
  1: { main: "#8f2f2b", alt: "#692723" },
  2: { main: "#99601c", alt: "#704816" },
  3: { main: "#99601c", alt: "#704816" },
  4: { main: "#958022", alt: "#6f611b" },
  5: { main: "#2f7f49", alt: "#275f3b" },
  6: { main: "#2f7f49", alt: "#275f3b" },
  7: { main: "#397f9d", alt: "#315f75" },
  8: { main: "#397f9d", alt: "#315f75" },
  9: { main: "#2f548f", alt: "#283f6a" },
  10: { main: "#2f548f", alt: "#283f6a" },
  11: { main: "#704187", alt: "#563464" },
};
const NATURAL_PITCH_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);

/**
 * basic track 또는 layout label에 사용할 MIDI 대응 색상을 반환한다.
 * - 인수 : midi : note MIDI 번호
 * - 반환값 : pitch class와 natural/accidental 구분이 반영된 색상
 */
export function colorForBasicMidi(midi: number): string {
  return colorForMidi(midi, NOTE_COLORS);
}

/**
 * optional track에 사용할 MIDI 대응 색상을 반환한다.
 * - 인수 : midi : note MIDI 번호
 * - 반환값 : pitch class와 natural/accidental 구분이 반영된 optional 색상
 */
export function colorForOptionalMidi(midi: number): string {
  return colorForMidi(midi, NOTE_COLORS_OPTIONAL);
}

/**
 * layout label 열에 사용할 탁한 MIDI 대응 색상을 반환한다.
 * - 인수 : midi : note MIDI 번호
 * - 반환값 : classic palette hue를 유지하되 라벨 배경용으로 낮춘 색상
 */
export function colorForLabelMidi(midi: number): string {
  return colorForMidi(midi, NOTE_COLORS_LABEL);
}

/**
 * midi pitch class를 팔레트 색상으로 변환한다.
 * - 인수 : midi : note MIDI 번호
 * - 인수 : palette : 변환에 사용할 pitch class 팔레트
 * - 반환값 : natural/accidental 구분이 반영된 색상
 */
function colorForMidi(
  midi: number,
  palette: Record<number, { main: string; alt: string }>,
): string {
  const pitchClass = getPitchClass(midi);
  const color = palette[pitchClass];

  // 자연음은 main 색, 변화음은 같은 계열의 alt 색으로 표시한다.
  return NATURAL_PITCH_CLASSES.has(pitchClass) ? color.main : color.alt;
}

/**
 * midi 값을 0-11 pitch class로 정규화한다.
 * - 인수 : midi : note MIDI 번호
 * - 반환값 : 0-11 범위의 pitch class
 */
function getPitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}
