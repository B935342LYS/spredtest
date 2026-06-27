/**
 * 게임 모드 pitch detection과 화면 표시에서 공유하는 수학 helper이다.
 */

import type { CanvasScoreLayout } from "../../renderer/canvas_types";

/**
 * frequency Hz 값을 가장 가까운 MIDI와 cent offset으로 변환한다.
 * - 인수 : frequencyHz : 분석된 주파수 Hz
 * - 반환값 : MIDI note와 cent offset. 유효하지 않으면 null
 */
export function frequencyToMidiPitch(
  frequencyHz: number,
): { midi: number; centOffset: number } | null {
  if (!Number.isFinite(frequencyHz) || frequencyHz <= 0) {
    return null;
  }

  const exactMidi = 69 + 12 * Math.log2(frequencyHz / 440);
  const midi = Math.round(exactMidi);
  const centOffset = (exactMidi - midi) * 100;

  if (!Number.isFinite(midi) || !Number.isFinite(centOffset)) {
    return null;
  }

  return {
    midi,
    centOffset,
  };
}

/**
 * Float32 waveform의 RMS 음량을 계산한다.
 * - 인수 : samples : time-domain sample 배열
 * - 반환값 : RMS 음량
 */
export function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;

  for (const sample of samples) {
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / samples.length);
}

/**
 * 현재 layout note row 범위에서 pitch detection frequency 허용 범위를 만든다.
 * - 인수 : layout : 현재 renderer layout
 * - 반환값 : 한 옥타브 여유를 둔 frequency range
 */
export function createFrequencyRangeFromLayout(
  layout: CanvasScoreLayout | null,
): { minFrequencyHz: number; maxFrequencyHz: number } {
  const noteMidis = layout?.rows
    .filter((row) => row.kind === "note" && row.midi !== undefined)
    .map((row) => row.midi ?? 0) ?? [];

  if (noteMidis.length === 0) {
    return {
      minFrequencyHz: 20,
      maxFrequencyHz: 5000,
    };
  }

  const minMidi = Math.min(...noteMidis) - 12;
  const maxMidi = Math.max(...noteMidis) + 12;

  return {
    minFrequencyHz: midiToFrequency(minMidi),
    maxFrequencyHz: midiToFrequency(maxMidi),
  };
}

/**
 * MIDI note number를 주파수 Hz로 변환한다.
 * - 인수 : midi : MIDI note number
 * - 반환값 : A4=440Hz 기준 주파수
 */
function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}
