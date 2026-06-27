/**
 * 마이크 MediaStream을 Pitchy 기반 pitch frame으로 변환한다.
 */

import { PitchDetector } from "pitchy";
import type { CanvasScoreLayout } from "../../renderer/canvas_types";
import type { GamePitchFrame } from "./game_types";
import {
  calculateRms,
  createFrequencyRangeFromLayout,
  frequencyToMidiPitch,
} from "./game_pitch_math";

const PITCH_ANALYZER_FFT_SIZE = 4096;
const MIN_CLARITY = 0.75;
const MIN_RMS = 0.01;

/** pitch input runtime이 app 쪽에 제공하는 제어 객체. */
export type GamePitchInputRuntime = {
  dispose(): void;
};

/**
 * 현재 renderer layout을 조회하는 callback이다.
 * - 인수 : 없음
 * - 반환값 : 최신 CanvasScoreLayout 또는 null
 */
export type GamePitchLayoutProvider = () => CanvasScoreLayout | null;

/**
 * 마이크 stream에서 pitch frame 생성 루프를 시작한다.
 * - 인수 : stream : getUserMedia가 반환한 마이크 MediaStream
 * - 인수 : getLayout : frequency range 계산에 사용할 최신 layout 조회 callback
 * - 인수 : onFrame : 새 pitch frame을 전달받는 callback
 * - 반환값 : pitch input 정리용 runtime
 */
export function createGamePitchInputRuntime(
  stream: MediaStream,
  getLayout: GamePitchLayoutProvider,
  onFrame: (frame: GamePitchFrame) => void,
): GamePitchInputRuntime {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  const samples = new Float32Array(PITCH_ANALYZER_FFT_SIZE);
  const detector = PitchDetector.forFloat32Array(PITCH_ANALYZER_FFT_SIZE);
  let rafId: number | null = null;
  let disposed = false;

  analyser.fftSize = PITCH_ANALYZER_FFT_SIZE;
  detector.clarityThreshold = MIN_CLARITY;
  source.connect(analyser);

  const analyzeFrame = (): void => {
    if (disposed) {
      return;
    }

    analyser.getFloatTimeDomainData(samples);

    const capturedAtMs = performance.now();
    const rms = calculateRms(samples);
    const [frequencyHz, clarity] = detector.findPitch(samples, audioContext.sampleRate);
    const range = createFrequencyRangeFromLayout(getLayout());
    const midiPitch = frequencyToMidiPitch(frequencyHz);
    const isFrequencyInRange = frequencyHz >= range.minFrequencyHz &&
      frequencyHz <= range.maxFrequencyHz;
    const isVoiced = midiPitch !== null &&
      clarity >= MIN_CLARITY &&
      rms >= MIN_RMS &&
      isFrequencyInRange;
    const rejectReason = resolvePitchRejectReason({
      midiPitch,
      clarity,
      rms,
      isFrequencyInRange,
    });

    // Pitchy가 반환한 clarity와 앱의 RMS/range 필터를 조합해 판정 가능한 frame만 voiced로 표시한다.
    onFrame({
      capturedAtMs,
      rawFrequencyHz: Number.isFinite(frequencyHz) && frequencyHz > 0 ? frequencyHz : null,
      frequencyHz: isVoiced ? frequencyHz : null,
      midi: isVoiced ? midiPitch.midi : null,
      centOffset: isVoiced ? midiPitch.centOffset : null,
      clarity,
      rms,
      isVoiced,
      rejectReason: isVoiced ? null : rejectReason,
    });

    rafId = requestAnimationFrame(analyzeFrame);
  };

  void audioContext.resume();
  rafId = requestAnimationFrame(analyzeFrame);

  return {
    dispose(): void {
      disposed = true;

      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      source.disconnect();
      analyser.disconnect();
      void audioContext.close();
    },
  };
}

/**
 * pitch frame이 voiced로 채택되지 않은 첫 번째 이유를 고른다.
 * - 인수 : input : pitch detector 결과와 앱 필터 결과
 * - 반환값 : voiced 탈락 이유. 탈락하지 않았으면 null
 */
function resolvePitchRejectReason(input: {
  midiPitch: { midi: number; centOffset: number } | null;
  clarity: number;
  rms: number;
  isFrequencyInRange: boolean;
}): GamePitchFrame["rejectReason"] {
  if (input.midiPitch === null) {
    return input.rms >= MIN_RMS ? "unclear pitch" : "invalid frequency";
  }

  if (input.clarity < MIN_CLARITY) {
    return "low clarity";
  }

  if (input.rms < MIN_RMS) {
    return "low rms";
  }

  if (!input.isFrequencyInRange) {
    return "out of range";
  }

  return null;
}
