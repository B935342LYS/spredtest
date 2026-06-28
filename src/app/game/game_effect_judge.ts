/**
 * practice mode의 gliss/vib/trem effect bonus 판정 후보와 gliss 1차 판정을 담당한다.
 */

import type {
  AnalysisResult,
  AnalyzedEvent,
  GlissEvent,
  NoteEvent,
} from "../../core/analyze/types";
import type { TrackId } from "../../core/score/types";
import type { TickTimeMapper } from "../../audio/audio_types";
import type {
  GameEffectBonusResult,
  GamePitchFrame,
} from "./game_types";

const GLISS_INTERVAL_SECONDS = 0.25;
const GLISS_INTERVAL_BONUS_MULTIPLIER = 0.25;
const GLISS_MAX_ERROR_CENT = 100;
const VIB_WINDOW_SECONDS = 0.8;
const VIB_MIN_WINDOW_SECONDS = 0.3;
const VIB_MIN_FRAME_COUNT = 4;
const VIB_MIN_AMPLITUDE_CENT = 10;
const VIB_MIN_DIRECTION_CHANGES = 2;
const VIB_MIN_RATE_HZ = 2;
const VIB_MAX_RATE_HZ = 9.5;
const VIB_MAX_AVERAGE_ERROR_CENT = 60;
const VIB_IN_TUNE_ERROR_CENT = 70;
const VIB_MIN_IN_TUNE_RATIO = 0.6;
const VIB_DERIVATIVE_DEAD_ZONE_CENT = 2;
const VIB_BONUS_MULTIPLIER = 0.5;

/** effect bonus 판정이 참조하는 pitch frame과 score time 묶음. */
export type GameEffectFrame = {
  scoreSeconds: number;
  frame: GamePitchFrame;
};

/** practice 중 interval 단위로 판정할 gliss effect bonus 대상. */
export type GameGlissBonusTarget = {
  kind: "gliss";
  targetId: string;
  trackId: TrackId;
  startSeconds: number;
  endSeconds: number;
  startMidi: number;
  startCentOffset: number;
  endMidi: number;
  endCentOffset: number;
};

/** practice 중 한 번만 판정할 vibrato effect bonus 대상. */
export type GameVibBonusTarget = {
  kind: "vib";
  targetId: string;
  trackId: TrackId;
  startSeconds: number;
  endSeconds: number;
  targetMidi: number;
  targetCentOffset: number;
};

/** practice 중 판정할 effect bonus 대상. */
export type GameEffectBonusTarget = GameGlissBonusTarget | GameVibBonusTarget;

/**
 * analyzer 결과에서 active track의 effect bonus target 목록을 만든다.
 * - 인수 : analysis : analyzer 결과
 * - 인수 : activeTrackIds : practice 대상 active track 목록
 * - 인수 : mapper : tick을 seconds로 바꾸는 tempo mapper
 * - 반환값 : gliss/vib/trem 확장용 effect bonus target 목록
 */
export function collectGameEffectBonusTargets(
  analysis: AnalysisResult,
  activeTrackIds: readonly TrackId[],
  mapper: TickTimeMapper,
): GameEffectBonusTarget[] {
  const activeTrackIdSet = new Set(activeTrackIds);
  const targets: GameEffectBonusTarget[] = [];

  for (const trackResult of analysis.trackResults) {
    if (!activeTrackIdSet.has(trackResult.trackId)) {
      continue;
    }

    for (const event of trackResult.events) {
      if (isGlissEvent(event)) {
        const startSeconds = mapper.tickToSeconds(event.startAnchorTick);
        const endSeconds = mapper.tickToSeconds(event.endAnchorTick);

        if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
          continue;
        }

        targets.push({
          kind: "gliss",
          targetId: event.eventId,
          trackId: event.trackId,
          startSeconds,
          endSeconds,
          startMidi: event.startSound.midi,
          startCentOffset: event.startSound.centOffset,
          endMidi: event.endSound.midi,
          endCentOffset: event.endSound.centOffset,
        });
      }

      if (isNoteEvent(event)) {
        collectVibBonusTargetsForNote(event, mapper, targets);
      }
    }
  }

  return targets;
}

/**
 * gliss target의 현재 interval이 bonus 조건을 만족하는지 확인한다.
 * - 인수 : target : 판정할 gliss bonus 대상
 * - 인수 : frame : 현재 practice pitch frame
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 인수 : intervalIndex : gliss target 내부 interval 순서
 * - 인수 : trackDifficulty : track별 점수 가중 난이도
 * - 인수 : frames : Sync 보정 score time과 함께 저장된 최근 pitch frame 목록
 * - 반환값 : 성공하면 Gliss! bonus 결과, 아니면 null
 */
export function judgeGlissIntervalBonus(
  target: GameGlissBonusTarget,
  frame: GamePitchFrame | null,
  scoreSeconds: number,
  intervalIndex: number,
  trackDifficulty: Record<TrackId, number>,
  frames?: readonly GameEffectFrame[],
): GameEffectBonusResult | null {
  if (
    frame === null ||
    !frame.isVoiced ||
    frame.midi === null ||
    frame.centOffset === null ||
    scoreSeconds < target.startSeconds ||
    scoreSeconds > target.endSeconds ||
    intervalIndex < 0
  ) {
    return null;
  }

  if (frames !== undefined && hasUnvoicedFrameInGlissInterval(target, frames, scoreSeconds, intervalIndex)) {
    return null;
  }

  const displayPitch = calculateGlissTargetPitch(target, scoreSeconds);
  const errorCent = calculateGlissPitchErrorCent(target, frame, scoreSeconds);

  if (errorCent >= GLISS_MAX_ERROR_CENT) {
    return null;
  }

  return {
    kind: "gliss",
    targetId: target.targetId,
    trackId: target.trackId,
    scoreSeconds,
    targetMidi: displayPitch.midi,
    targetCentOffset: displayPitch.centOffset,
    bonusContribution: (trackDifficulty[target.trackId] ?? 1) * GLISS_INTERVAL_BONUS_MULTIPLIER,
    displayText: "Gliss!",
  };
}

/**
 * gliss target을 같은 practice 세션에서 더 이상 성공시킬 수 없는 실패 상태인지 확인한다.
 * - 인수 : target : 판정할 gliss bonus 대상
 * - 인수 : frame : 현재 practice pitch frame
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 인수 : intervalIndex : gliss target 내부 interval 순서
 * - 인수 : frames : Sync 보정 score time과 함께 저장된 최근 pitch frame 목록
 * - 반환값 : 끊김 또는 큰 pitch 오차가 확인되면 true
 */
export function shouldLockFailedGlissBonusTarget(
  target: GameGlissBonusTarget,
  frame: GamePitchFrame | null,
  scoreSeconds: number,
  intervalIndex: number,
  frames: readonly GameEffectFrame[],
): boolean {
  if (scoreSeconds < target.startSeconds || scoreSeconds > target.endSeconds || intervalIndex < 0) {
    return false;
  }

  if (hasUnvoicedFrameInGlissInterval(target, frames, scoreSeconds, intervalIndex)) {
    return true;
  }

  if (frame === null || !frame.isVoiced || frame.midi === null || frame.centOffset === null) {
    return false;
  }

  return calculateGlissPitchErrorCent(target, frame, scoreSeconds) >= GLISS_MAX_ERROR_CENT;
}

/**
 * vib target의 최근 pitch frame 창이 vibrato 흔들림 조건을 만족하는지 확인한다.
 * - 인수 : target : 판정할 vib bonus 대상
 * - 인수 : frames : Sync 보정 score time과 함께 저장된 최근 pitch frame 목록
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 인수 : trackDifficulty : track별 점수 가중 난이도
 * - 반환값 : 성공하면 Vib! bonus 결과, 아니면 null
 */
export function judgeVibWindowBonus(
  target: GameVibBonusTarget,
  frames: readonly GameEffectFrame[],
  scoreSeconds: number,
  trackDifficulty: Record<TrackId, number>,
): GameEffectBonusResult | null {
  if (scoreSeconds < target.startSeconds || scoreSeconds > target.endSeconds) {
    return null;
  }

  const windowStartSeconds = Math.max(target.startSeconds, scoreSeconds - VIB_WINDOW_SECONDS);
  const usableFrames = frames.filter((entry) =>
    entry.scoreSeconds >= windowStartSeconds &&
    entry.scoreSeconds <= scoreSeconds &&
    entry.scoreSeconds >= target.startSeconds &&
    entry.scoreSeconds <= target.endSeconds &&
    entry.frame.isVoiced &&
    entry.frame.midi !== null &&
    entry.frame.centOffset !== null
  );

  if (usableFrames.length < VIB_MIN_FRAME_COUNT) {
    return null;
  }

  const firstFrame = usableFrames[0];
  const lastFrame = usableFrames[usableFrames.length - 1];

  if (
    firstFrame === undefined ||
    lastFrame === undefined ||
    lastFrame.scoreSeconds - firstFrame.scoreSeconds < VIB_MIN_WINDOW_SECONDS
  ) {
    return null;
  }

  const targetCent = target.targetMidi * 100 + target.targetCentOffset;
  const deviations = usableFrames.map((entry) =>
    calculateSignedPitchClassErrorCent(
      (entry.frame.midi ?? 0) * 100 + (entry.frame.centOffset ?? 0),
      targetCent,
    )
  );
  const averageAbsErrorCent = deviations.reduce((sum, value) => sum + Math.abs(value), 0) / deviations.length;
  const inTuneFrameCount = deviations.filter((value) => Math.abs(value) <= VIB_IN_TUNE_ERROR_CENT).length;
  const inTuneRatio = inTuneFrameCount / deviations.length;
  const detrendedDeviations = detrendPitchDeviations(usableFrames, deviations);
  const minDetrendedDeviation = Math.min(...detrendedDeviations);
  const maxDetrendedDeviation = Math.max(...detrendedDeviations);
  const directionChangeCount = countDirectionChanges(detrendedDeviations);
  const amplitudeCent = (maxDetrendedDeviation - minDetrendedDeviation) / 2;
  const durationSeconds = Math.max(1e-6, lastFrame.scoreSeconds - firstFrame.scoreSeconds);
  const rateHz = (directionChangeCount / 2) / durationSeconds;

  if (
    averageAbsErrorCent > VIB_MAX_AVERAGE_ERROR_CENT ||
    inTuneRatio < VIB_MIN_IN_TUNE_RATIO ||
    amplitudeCent < VIB_MIN_AMPLITUDE_CENT ||
    rateHz < VIB_MIN_RATE_HZ ||
    rateHz > VIB_MAX_RATE_HZ ||
    directionChangeCount < VIB_MIN_DIRECTION_CHANGES
  ) {
    return null;
  }

  return {
    kind: "vib",
    targetId: target.targetId,
    trackId: target.trackId,
    scoreSeconds,
    targetMidi: target.targetMidi,
    targetCentOffset: target.targetCentOffset,
    bonusContribution: (trackDifficulty[target.trackId] ?? 1) * VIB_BONUS_MULTIPLIER,
    displayText: "Vib!",
  };
}

/**
 * pitch contour에서 느린 선형 drift를 제거한다.
 * - 인수 : frames : 분석에 사용할 pitch frame 목록
 * - 인수 : deviations : target 기준 signed cent 오차 목록
 * - 반환값 : 선형 추세를 뺀 cent deviation 목록
 */
function detrendPitchDeviations(
  frames: readonly GameEffectFrame[],
  deviations: readonly number[],
): number[] {
  if (frames.length !== deviations.length || frames.length < 2) {
    return [...deviations];
  }

  const originSeconds = frames[0]?.scoreSeconds ?? 0;
  const timeOffsets = frames.map((entry) => entry.scoreSeconds - originSeconds);
  const meanTime = timeOffsets.reduce((sum, value) => sum + value, 0) / timeOffsets.length;
  const meanDeviation = deviations.reduce((sum, value) => sum + value, 0) / deviations.length;
  let numerator = 0;
  let denominator = 0;

  // 최소제곱 직선으로 느린 pitch drift를 근사하고 residual만 vibrato 진폭/rate 판정에 사용한다.
  for (let index = 0; index < deviations.length; index += 1) {
    const time = timeOffsets[index] ?? 0;
    const deviation = deviations[index] ?? 0;
    const centeredTime = time - meanTime;

    numerator += centeredTime * (deviation - meanDeviation);
    denominator += centeredTime * centeredTime;
  }

  const slope = denominator <= 1e-9 ? 0 : numerator / denominator;
  const intercept = meanDeviation - slope * meanTime;

  return deviations.map((deviation, index) => {
    const time = timeOffsets[index] ?? 0;

    return deviation - (slope * time + intercept);
  });
}

/**
 * 현재 gliss 진행 위치의 예상 pitch와 입력 pitch 사이의 pitch class 오차를 계산한다.
 * - 인수 : target : 판정할 gliss bonus 대상
 * - 인수 : frame : 현재 practice pitch frame
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 반환값 : 0 이상 600 이하의 pitch class 오차 cent
 */
function calculateGlissPitchErrorCent(
  target: GameGlissBonusTarget,
  frame: GamePitchFrame,
  scoreSeconds: number,
): number {
  const displayPitch = calculateGlissTargetPitch(target, scoreSeconds);
  const inputCent = (frame.midi ?? 0) * 100 + (frame.centOffset ?? 0);
  const targetCent = displayPitch.midi * 100 + displayPitch.centOffset;

  return Math.abs(calculateSignedPitchClassErrorCent(inputCent, targetCent));
}

/**
 * gliss target의 현재 interval index를 계산한다.
 * - 인수 : target : 판정을 기다리는 effect bonus 대상
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 반환값 : gliss 구간 안이면 0 이상 interval index, 아니면 null
 */
export function getGlissIntervalIndexAtSeconds(
  target: GameEffectBonusTarget,
  scoreSeconds: number,
): number | null {
  if (target.kind !== "gliss") {
    return null;
  }

  if (scoreSeconds < target.startSeconds || scoreSeconds > target.endSeconds) {
    return null;
  }

  return Math.floor((scoreSeconds - target.startSeconds) / GLISS_INTERVAL_SECONDS);
}

/**
 * analyzer event를 GlissEvent로 좁힌다.
 * - 인수 : event : 검사할 analyzer event
 * - 반환값 : GlissEvent이면 true
 */
function isGlissEvent(event: AnalyzedEvent): event is GlissEvent {
  return event.eventKind === "gliss";
}

/**
 * analyzer event를 NoteEvent로 좁힌다.
 * - 인수 : event : 검사할 analyzer event
 * - 반환값 : NoteEvent이면 true
 */
function isNoteEvent(event: AnalyzedEvent): event is NoteEvent {
  return event.eventKind === "note";
}

/**
 * gliss interval 안에 무성/무효 frame이 있었는지 확인한다.
 * - 인수 : target : 판정할 gliss bonus 대상
 * - 인수 : frames : 최근 practice pitch frame 목록
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 인수 : intervalIndex : gliss target 내부 interval 순서
 * - 반환값 : 현재 interval 안에 끊긴 입력이 있으면 true
 */
function hasUnvoicedFrameInGlissInterval(
  target: GameGlissBonusTarget,
  frames: readonly GameEffectFrame[],
  scoreSeconds: number,
  intervalIndex: number,
): boolean {
  const intervalStartSeconds = target.startSeconds + intervalIndex * GLISS_INTERVAL_SECONDS;
  const intervalEndSeconds = Math.min(
    target.endSeconds,
    intervalStartSeconds + GLISS_INTERVAL_SECONDS,
    scoreSeconds,
  );
  const intervalFrames = frames.filter((entry) =>
    entry.scoreSeconds >= intervalStartSeconds &&
    entry.scoreSeconds <= intervalEndSeconds
  );

  // interval 중간에 low rms/unclear pitch 등으로 무효 frame이 들어오면 gliss 연속 성공으로 보지 않는다.
  return intervalFrames.some((entry) =>
    !entry.frame.isVoiced ||
    entry.frame.midi === null ||
    entry.frame.centOffset === null
  );
}

/**
 * note event의 vib effect segment를 practice bonus target으로 변환한다.
 * - 인수 : event : vib effect를 검사할 note event
 * - 인수 : mapper : tick을 seconds로 바꾸는 tempo mapper
 * - 인수 : targets : 변환 결과를 추가할 target 배열
 * - 반환값 : 없음
 */
function collectVibBonusTargetsForNote(
  event: NoteEvent,
  mapper: TickTimeMapper,
  targets: GameEffectBonusTarget[],
): void {
  let activeStartSeconds: number | null = null;
  let activeEndSeconds: number | null = null;
  let activeStartIndex = 0;

  for (let index = 0; index <= event.effects.length; index += 1) {
    const effect = event.effects[index];

    if (effect !== undefined && effect.vib) {
      const startSeconds = mapper.tickToSeconds(effect.time.startTick);
      const endSeconds = mapper.tickToSeconds(effect.time.endTick);

      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        continue;
      }

      if (activeStartSeconds === null || activeEndSeconds === null) {
        activeStartSeconds = startSeconds;
        activeEndSeconds = endSeconds;
        activeStartIndex = index;
        continue;
      }

      if (Math.abs(startSeconds - activeEndSeconds) <= 1e-6) {
        activeEndSeconds = endSeconds;
        continue;
      }

      pushVibBonusTarget(event, targets, activeStartIndex, activeStartSeconds, activeEndSeconds);
      activeStartSeconds = startSeconds;
      activeEndSeconds = endSeconds;
      activeStartIndex = index;
      continue;
    }

    if (activeStartSeconds !== null && activeEndSeconds !== null) {
      pushVibBonusTarget(event, targets, activeStartIndex, activeStartSeconds, activeEndSeconds);
      activeStartSeconds = null;
      activeEndSeconds = null;
    }
  }
}

/**
 * 병합된 연속 vib 구간 하나를 practice bonus target으로 추가한다.
 * - 인수 : event : vib effect가 들어 있는 note event
 * - 인수 : targets : 변환 결과를 추가할 target 배열
 * - 인수 : startIndex : 병합 구간의 첫 effect segment index
 * - 인수 : startSeconds : 병합 구간 시작 score seconds
 * - 인수 : endSeconds : 병합 구간 끝 score seconds
 * - 반환값 : 없음
 */
function pushVibBonusTarget(
  event: NoteEvent,
  targets: GameEffectBonusTarget[],
  startIndex: number,
  startSeconds: number,
  endSeconds: number,
): void {
  targets.push({
    kind: "vib",
    targetId: `${event.eventId}:vib:${startIndex}`,
    trackId: event.trackId,
    startSeconds,
    endSeconds,
    targetMidi: event.sound.midi,
    targetCentOffset: event.sound.centOffset,
  });
}

/**
 * gliss 진행 시간에 대응하는 target pitch를 선형 보간한다.
 * - 인수 : target : 보간할 gliss bonus 대상
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 반환값 : overlay 표시 위치로 사용할 target MIDI와 cent offset
 */
function calculateGlissTargetPitch(
  target: GameGlissBonusTarget,
  scoreSeconds: number,
): {
  midi: number;
  centOffset: number;
} {
  const durationSeconds = Math.max(1e-6, target.endSeconds - target.startSeconds);
  const ratio = Math.min(Math.max((scoreSeconds - target.startSeconds) / durationSeconds, 0), 1);
  const startCent = target.startMidi * 100 + target.startCentOffset;
  const endCent = target.endMidi * 100 + target.endCentOffset;
  const interpolatedCent = startCent + (endCent - startCent) * ratio;
  const midi = Math.round(interpolatedCent / 100);

  return {
    midi,
    centOffset: interpolatedCent - midi * 100,
  };
}

/**
 * input pitch와 target pitch의 pitch class 기준 signed cent 오차를 계산한다.
 * - 인수 : inputCent : 입력 pitch의 절대 cent 값
 * - 인수 : targetCent : target pitch의 절대 cent 값
 * - 반환값 : -600 이상 600 이하의 signed pitch class 오차
 */
function calculateSignedPitchClassErrorCent(inputCent: number, targetCent: number): number {
  let diff = (inputCent - targetCent) % 1200;

  if (diff > 600) {
    diff -= 1200;
  } else if (diff < -600) {
    diff += 1200;
  }

  return diff;
}

/**
 * pitch deviation 배열에서 상승/하강 방향 전환 수를 센다.
 * - 인수 : deviations : target 중심 signed cent 오차 목록
 * - 반환값 : dead zone보다 큰 기울기 방향이 바뀐 횟수
 */
function countDirectionChanges(deviations: readonly number[]): number {
  let previousDirection: -1 | 1 | null = null;
  let directionChangeCount = 0;

  for (let index = 1; index < deviations.length; index += 1) {
    const previous = deviations[index - 1];
    const current = deviations[index];

    if (previous === undefined || current === undefined) {
      continue;
    }

    const delta = current - previous;

    if (Math.abs(delta) < VIB_DERIVATIVE_DEAD_ZONE_CENT) {
      continue;
    }

    const direction: -1 | 1 = delta > 0 ? 1 : -1;

    if (previousDirection !== null && direction !== previousDirection) {
      directionChangeCount += 1;
    }

    previousDirection = direction;
  }

  return directionChangeCount;
}
