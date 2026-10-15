import type { GamePitchFrame, GameTimingOnsetCandidate } from "./game_types";
import type { GameEffectFrame } from "./game_effect_judge";

const TIMING_ONSET_MIN_INTERVAL_SECONDS = 0.06;
const TIMING_ONSET_KEEP_SECONDS = 0.75;
const TIMING_PITCH_CHANGE_THRESHOLD_CENT = 80;
const EFFECT_FRAME_KEEP_SECONDS = 1.2;
/** Practice 입력 기록. 조회 배열은 읽기 전용이며 장기 snapshot이 아니다. */
export type GameInputHistory = {
  recordFrame(frame: GamePitchFrame | null, judgeScoreSeconds: number): void;
  reset(): void;
  getOnsets(): readonly GameTimingOnsetCandidate[];
  getEffectFrames(): readonly GameEffectFrame[];
};
/**
 * DOM이나 오디오 없이 판정용 입력 기록을 생성한다.
 * - 인수 : 없음
 * - 반환값 : 입력 기록과 초기화·조회 동작
 */
export function createGameInputHistory(): GameInputHistory {
  let lastTimingFrame: GamePitchFrame | null = null;
  let lastProcessedTimingFrameAtMs: number | null = null;
  let timingOnsetCandidates: GameTimingOnsetCandidate[] = [];
  let nextTimingOnsetId = 1;
  let effectFrames: GameEffectFrame[] = [];
  let lastProcessedEffectFrameAtMs: number | null = null;
  /**
   * 새 프레임을 주법 판정 기록에 추가하고 보관 창 밖의 기록을 제거한다.
   * - 인수 : frame : 현재 음정 프레임
   * - 인수 : judgeScoreSeconds : Sync 보정된 악보 시각
   * - 반환값 : 없음
   */
  const appendPracticeEffectFrame = (
    frame: GamePitchFrame | null,
    judgeScoreSeconds: number,
  ): void => {
    if (frame === null || lastProcessedEffectFrameAtMs === frame.capturedAtMs) {
      return;
    }

    lastProcessedEffectFrameAtMs = frame.capturedAtMs;
    // 현재 프레임을 추가하고 보정된 악보 시각에서 1.2초 이내의 기록을 유지한다.
    effectFrames.push({
      scoreSeconds: judgeScoreSeconds,
      frame,
    });
    effectFrames = effectFrames.filter((entry) =>
      judgeScoreSeconds - entry.scoreSeconds <= EFFECT_FRAME_KEEP_SECONDS
    );
  };

  return {
    /**
     * 중복 프레임을 제외하고 발음 시작 후보와 최근 입력을 기록한다.
     * - 인수 : frame : 현재 프레임. null이면 기록과 정리를 생략한다.
     * - 인수 : judgeScoreSeconds : Sync 보정된 악보 시각
     * - 반환값 : 없음
     */
    recordFrame(frame, judgeScoreSeconds): void {
      // 같은 검출 프레임을 RAF에서 다시 읽거나 입력이 없으면 기존 기록을 유지한다.
      if (
        frame === null ||
        lastProcessedTimingFrameAtMs === frame.capturedAtMs
      ) {
        return;
      }

      lastProcessedTimingFrameAtMs = frame.capturedAtMs;

      appendPracticeEffectFrame(frame, judgeScoreSeconds);

      // 유효한 유음 전환·음정 변화만 최소 간격을 확인한 뒤 후보로 저장한다.
      if (frame.isVoiced && frame.midi !== null && frame.centOffset !== null) {
        const shouldCreateOnset = isTimingOnsetFrame(lastTimingFrame, frame) &&
          canAppendTimingOnset(judgeScoreSeconds, timingOnsetCandidates);

        if (shouldCreateOnset) {
          timingOnsetCandidates.push({
            id: nextTimingOnsetId,
            scoreSeconds: judgeScoreSeconds,
            midi: frame.midi,
            centOffset: frame.centOffset,
          });
          nextTimingOnsetId += 1;
        }
      }

      lastTimingFrame = frame;
      // 중복 검사를 통과한 프레임을 처리한 경우에만 후보 보관 창을 정리한다.
      timingOnsetCandidates = pruneTimingOnsets(judgeScoreSeconds, timingOnsetCandidates);
    },
    /**
     * 새 연습을 위해 모든 기록과 후보 ID를 초기화한다.
     * - 인수 : 없음
     * - 반환값 : 없음
     */
    reset(): void {
      lastTimingFrame = null;
      lastProcessedTimingFrameAtMs = null;
      timingOnsetCandidates = [];
      nextTimingOnsetId = 1;
      effectFrames = [];
      lastProcessedEffectFrameAtMs = null;
    },
    /**
     * 현재 발음 시작 후보를 복제 없이 조회한다.
     * - 인수 : 없음
     * - 반환값 : 읽기 전용 후보 목록
     */
    getOnsets() { return timingOnsetCandidates; },
    /**
     * 현재 주법 판정 프레임을 복제 없이 조회한다.
     * - 인수 : 없음
     * - 반환값 : 읽기 전용 프레임 목록
     */
    getEffectFrames() { return effectFrames; },
  };
}
/**
 * pitch frame이 timing onset 후보로 볼 수 있는 변화인지 확인한다.
 * - 인수 : previousFrame : 직전에 처리한 pitch frame
 * - 인수 : currentFrame : 새로 처리할 pitch frame
 * - 반환값 : 무음에서 유음으로 바뀌었거나 pitch class가 충분히 바뀌었으면 true
 */
function isTimingOnsetFrame(
  previousFrame: GamePitchFrame | null,
  currentFrame: GamePitchFrame,
): boolean {
  if (
    !currentFrame.isVoiced ||
    currentFrame.midi === null ||
    currentFrame.centOffset === null
  ) {
    return false;
  }

  if (
    previousFrame === null ||
    !previousFrame.isVoiced ||
    previousFrame.midi === null ||
    previousFrame.centOffset === null
  ) {
    return true;
  }

  const previousCent = previousFrame.midi * 100 + previousFrame.centOffset;
  const currentCent = currentFrame.midi * 100 + currentFrame.centOffset;

  return calculatePitchClassErrorCent(previousCent, currentCent) >= TIMING_PITCH_CHANGE_THRESHOLD_CENT;
}

/**
 * 마지막 onset 후보와 충분히 떨어져 새 onset 후보를 추가할 수 있는지 확인한다.
 * - 인수 : onsetScoreSeconds : 새 onset 후보의 score time
 * - 인수 : candidates : 현재 저장된 onset 후보 목록
 * - 반환값 : 후보가 없거나 최소 간격 이상 떨어져 있으면 true
 */
function canAppendTimingOnset(
  onsetScoreSeconds: number,
  candidates: readonly GameTimingOnsetCandidate[],
): boolean {
  const lastCandidate = candidates[candidates.length - 1];

  if (lastCandidate === undefined) {
    return true;
  }

  return onsetScoreSeconds - lastCandidate.scoreSeconds >= TIMING_ONSET_MIN_INTERVAL_SECONDS;
}

/**
 * 현재 score time에서 더 이상 매칭하지 않을 오래된 onset 후보를 제거한다.
 * - 인수 : currentScoreSeconds : 현재 판정용 score time
 * - 인수 : candidates : 현재 onset 후보 목록
 * - 반환값 : 유지할 onset 후보 목록
 */
function pruneTimingOnsets(
  currentScoreSeconds: number,
  candidates: readonly GameTimingOnsetCandidate[],
): GameTimingOnsetCandidate[] {
  return candidates.filter((candidate) =>
    Math.abs(currentScoreSeconds - candidate.scoreSeconds) <= TIMING_ONSET_KEEP_SECONDS
  );
}

/**
 * 두 cent pitch 사이의 pitch class 기준 최소 오차를 계산한다.
 * - 인수 : inputCent : 입력 pitch의 절대 cent 값
 * - 인수 : targetCent : 비교할 pitch의 절대 cent 값
 * - 반환값 : 0 이상 600 이하의 pitch class 오차 cent
 */
function calculatePitchClassErrorCent(inputCent: number, targetCent: number): number {
  const wrapped = Math.abs(inputCent - targetCent) % 1200;

  return Math.min(wrapped, 1200 - wrapped);
}

