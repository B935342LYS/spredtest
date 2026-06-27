/**
 * 게임 모드 pitch detection과 화면 표시에서 공유하는 수학 helper이다.
 */

import type { CanvasScoreLayout } from "../../renderer/canvas_types";

const OCTAVE_CANDIDATE_MAX_ERROR_CENT = 100;
const TARGET_LOCK_GRACE_MS = 220;

/** pitch class 보정에 사용할 target 음정 후보. */
export type GamePitchClassTarget = {
  midi: number;
  centOffset: number;
};

/** 입력 pitch 보정에서 직전 target 잠금을 유지하기 위한 runtime state. */
export type GamePitchCorrectionState = {
  lockedTargetCent: number | null;
  lastMatchedAtMs: number | null;
  lastDisplayMidi: number | null;
};

/**
 * 입력 pitch 보정 상태를 새 세션 값으로 만든다.
 * - 인수 : 없음
 * - 반환값 : target 잠금이 없는 초기 보정 상태
 */
export function createGamePitchCorrectionState(): GamePitchCorrectionState {
  return {
    lockedTargetCent: null,
    lastMatchedAtMs: null,
    lastDisplayMidi: null,
  };
}

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
 * 입력 pitch를 현재 target 후보 중 가장 가까운 pitch class의 옥타브 주변으로 보정한다.
 * - 인수 : midi : 감지된 MIDI note number
 * - 인수 : centOffset : 감지된 MIDI note 기준 cent offset
 * - 인수 : targets : 현재 시점에 판정 후보가 되는 target pitch 목록
 * - 반환값 : 같은 pitch class 후보이면 target 주변으로 접은 실수 MIDI pitch. 후보가 없으면 원 입력 pitch
 */
export function resolveClosestPitchClassCandidateMidi(
  midi: number,
  centOffset: number,
  targets: readonly GamePitchClassTarget[],
): number {
  const inputCent = midi * 100 + centOffset;

  if (!Number.isFinite(inputCent) || targets.length === 0) {
    return midi + centOffset / 100;
  }

  let bestTargetCent: number | null = null;
  let bestErrorCent = Number.POSITIVE_INFINITY;

  // 현재 시점에 겹친 target 중 pitch class 오차가 가장 작은 후보 하나만 선택한다.
  for (const target of targets) {
    const targetCent = target.midi * 100 + target.centOffset;

    if (!Number.isFinite(targetCent)) {
      continue;
    }

    const errorCent = calculatePitchClassErrorCent(inputCent, targetCent);

    if (errorCent < bestErrorCent) {
      bestErrorCent = errorCent;
      bestTargetCent = targetCent;
    }
  }

  if (bestTargetCent === null || bestErrorCent >= OCTAVE_CANDIDATE_MAX_ERROR_CENT) {
    return midi + centOffset / 100;
  }

  const octaveOffsetCent = Math.round((inputCent - bestTargetCent) / 1200) * 1200;

  return (inputCent - octaveOffsetCent) / 100;
}

/**
 * 직전 target 잠금을 짧게 유지하면서 입력 pitch를 가장 가까운 pitch class target 주변으로 보정한다.
 * - 인수 : midi : 감지된 MIDI note number
 * - 인수 : centOffset : 감지된 MIDI note 기준 cent offset
 * - 인수 : targets : 현재 시점에 판정 후보가 되는 target pitch 목록
 * - 인수 : capturedAtMs : pitch frame 캡처 시각
 * - 인수 : state : 이전 frame에서 이어 받은 target 잠금 상태
 * - 반환값 : 같은 pitch class 후보이면 target 주변으로 접은 실수 MIDI pitch. 후보가 없으면 원 입력 pitch
 */
export function resolvePitchClassCandidateMidiWithHysteresis(
  midi: number,
  centOffset: number,
  targets: readonly GamePitchClassTarget[],
  capturedAtMs: number,
  state: GamePitchCorrectionState,
): number {
  const inputCent = midi * 100 + centOffset;

  if (!Number.isFinite(inputCent)) {
    state.lockedTargetCent = null;
    state.lastMatchedAtMs = null;
    state.lastDisplayMidi = null;
    return midi + centOffset / 100;
  }

  const bestTargetCent = findBestPitchClassTargetCent(inputCent, targets);

  if (bestTargetCent !== null) {
    const lockedTargetCent = chooseLockedTargetCent(inputCent, bestTargetCent, state);
    const displayMidi = foldInputCentToTargetOctave(inputCent, lockedTargetCent);

    state.lockedTargetCent = lockedTargetCent;
    state.lastMatchedAtMs = capturedAtMs;
    state.lastDisplayMidi = displayMidi;

    return displayMidi;
  }

  if (
    state.lockedTargetCent !== null &&
    state.lastMatchedAtMs !== null &&
    capturedAtMs - state.lastMatchedAtMs <= TARGET_LOCK_GRACE_MS
  ) {
    const lockedErrorCent = calculatePitchClassErrorCent(inputCent, state.lockedTargetCent);

    // target 후보가 한두 frame 비어도 같은 pitch class 입력이면 직전 target 옥타브 기준을 유지한다.
    if (lockedErrorCent < OCTAVE_CANDIDATE_MAX_ERROR_CENT) {
      const displayMidi = foldInputCentToTargetOctave(inputCent, state.lockedTargetCent);

      state.lastDisplayMidi = displayMidi;

      return displayMidi;
    }

    // detector가 한두 frame 다른 계이름으로 튀면 dot을 원 입력으로 보내지 않고 직전 안정 위치에 묶는다.
    if (state.lastDisplayMidi !== null) {
      return state.lastDisplayMidi;
    }
  }

  if (
    state.lastMatchedAtMs !== null &&
    capturedAtMs - state.lastMatchedAtMs > TARGET_LOCK_GRACE_MS
  ) {
    state.lockedTargetCent = null;
    state.lastMatchedAtMs = null;
    state.lastDisplayMidi = null;
  }

  return midi + centOffset / 100;
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

/**
 * 현재 입력 pitch와 pitch class가 가장 가까운 target의 절대 cent 값을 찾는다.
 * - 인수 : inputCent : 입력 pitch의 절대 cent 값
 * - 인수 : targets : 비교할 target pitch 목록
 * - 반환값 : octave fold 후보 target cent 또는 없으면 null
 */
function findBestPitchClassTargetCent(
  inputCent: number,
  targets: readonly GamePitchClassTarget[],
): number | null {
  let bestTargetCent: number | null = null;
  let bestErrorCent = Number.POSITIVE_INFINITY;

  for (const target of targets) {
    const targetCent = target.midi * 100 + target.centOffset;

    if (!Number.isFinite(targetCent)) {
      continue;
    }

    const errorCent = calculatePitchClassErrorCent(inputCent, targetCent);

    if (errorCent < bestErrorCent) {
      bestErrorCent = errorCent;
      bestTargetCent = targetCent;
    }
  }

  if (bestTargetCent === null || bestErrorCent >= OCTAVE_CANDIDATE_MAX_ERROR_CENT) {
    return null;
  }

  return bestTargetCent;
}

/**
 * 현재 frame의 후보와 직전 잠금 후보 중 유지할 target을 고른다.
 * - 인수 : inputCent : 입력 pitch의 절대 cent 값
 * - 인수 : bestTargetCent : 현재 frame에서 가장 가까운 target cent
 * - 인수 : state : 직전 frame에서 이어 받은 target 잠금 상태
 * - 반환값 : 이번 frame에서 사용할 target cent
 */
function chooseLockedTargetCent(
  inputCent: number,
  bestTargetCent: number,
  state: GamePitchCorrectionState,
): number {
  if (state.lockedTargetCent === null) {
    return bestTargetCent;
  }

  const lockedErrorCent = calculatePitchClassErrorCent(inputCent, state.lockedTargetCent);

  if (lockedErrorCent < OCTAVE_CANDIDATE_MAX_ERROR_CENT) {
    return state.lockedTargetCent;
  }

  return bestTargetCent;
}

/**
 * 입력 pitch를 target pitch와 가장 가까운 옥타브의 실수 MIDI 값으로 접는다.
 * - 인수 : inputCent : 입력 pitch의 절대 cent 값
 * - 인수 : targetCent : 기준 target pitch의 절대 cent 값
 * - 반환값 : target 옥타브 주변으로 보정한 실수 MIDI pitch
 */
function foldInputCentToTargetOctave(inputCent: number, targetCent: number): number {
  const octaveOffsetCent = Math.round((inputCent - targetCent) / 1200) * 1200;

  return (inputCent - octaveOffsetCent) / 100;
}

/**
 * 두 cent pitch 사이의 pitch class 기준 최소 오차를 계산한다.
 * - 인수 : inputCent : 입력 pitch의 절대 cent 값
 * - 인수 : targetCent : target pitch의 절대 cent 값
 * - 반환값 : 0 이상 600 이하의 pitch class 오차 cent
 */
function calculatePitchClassErrorCent(inputCent: number, targetCent: number): number {
  const wrapped = Math.abs(inputCent - targetCent) % 1200;

  return Math.min(wrapped, 1200 - wrapped);
}
