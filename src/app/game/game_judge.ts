/**
 * 게임 모드의 NoteEvent 대상 조회와 pitch scoring sample 판정을 담당한다.
 */

import type {
  AnalysisResult,
  AnalyzedEvent,
  NoteEvent,
} from "../../core/analyze/types";
import type { TrackId } from "../../core/score/types";
import type { TickTimeMapper } from "../../audio/audio_types";
import type {
  GameJudgeTarget,
  GamePitchFrame,
  GameScoreSummary,
  GameScoringSampleResult,
} from "./game_types";
import {
  resolvePitchClassCandidateMidiWithHysteresis,
  type GamePitchCorrectionState,
} from "./game_pitch_math";

const PERFECT_ERROR_CENT = 50;
const OK_ERROR_CENT = 100;
const BAD_ERROR_CENT = 200;
const DEFAULT_TRACK_DIFFICULTY: Record<TrackId, number> = {
  basic: 1,
  optional: 1.2,
  extra: 1.5,
};

/** scoring sample 판정에 적용할 입력 pitch 보정 옵션. */
export type GameScoringCorrectionOptions = {
  state: GamePitchCorrectionState;
};

/**
 * Sync 입력 지연 보정값을 적용한 판정용 score seconds를 만든다.
 * - 인수 : scoreSeconds : playback controller가 보고한 현재 score time
 * - 인수 : syncOffsetMs : 사용자가 조정한 Sync ms 값
 * - 반환값 : 0초 이상으로 clamp된 판정용 score time
 */
export function applyGameSyncOffsetSeconds(
  scoreSeconds: number,
  syncOffsetMs: number,
): number {
  if (!Number.isFinite(scoreSeconds)) {
    return 0;
  }

  const boundedOffsetMs = Number.isFinite(syncOffsetMs) ? syncOffsetMs : 0;

  return Math.max(0, scoreSeconds - boundedOffsetMs / 1000);
}

/**
 * 현재 score seconds에 걸친 active track note target을 만든다.
 * - 인수 : analysis : analyzer 결과
 * - 인수 : activeTrackIds : 현재 practice 대상 active track 목록
 * - 인수 : mapper : tick을 seconds로 바꾸는 tempo mapper
 * - 인수 : scoreSeconds : 조회할 현재 score time
 * - 반환값 : 현재 시간에 발음 중인 note target 목록
 */
export function collectGameJudgeTargetsAtSeconds(
  analysis: AnalysisResult,
  activeTrackIds: readonly TrackId[],
  mapper: TickTimeMapper,
  scoreSeconds: number,
): GameJudgeTarget[] {
  if (!Number.isFinite(scoreSeconds) || activeTrackIds.length === 0) {
    return [];
  }

  const activeTrackIdSet = new Set(activeTrackIds);
  const targets: GameJudgeTarget[] = [];

  // active track의 현재 NoteEvent만 판정 후보로 수집한다.
  for (const trackResult of analysis.trackResults) {
    if (!activeTrackIdSet.has(trackResult.trackId)) {
      continue;
    }

    for (const event of trackResult.events) {
      if (!isNoteEvent(event)) {
        continue;
      }

      const startSeconds = mapper.tickToSeconds(event.time.startTick);
      const endSeconds = mapper.tickToSeconds(event.time.endTick);

      if (scoreSeconds < startSeconds || scoreSeconds >= endSeconds) {
        continue;
      }

      targets.push({
        eventId: event.eventId,
        trackId: event.trackId,
        startSeconds,
        endSeconds,
        targetMidi: event.sound.midi,
        targetCentOffset: event.sound.centOffset,
      });
    }
  }

  return targets;
}

/**
 * 현재 score time 이후 더 판정할 note target이 남아 있는지 확인한다.
 * - 인수 : analysis : analyzer 결과
 * - 인수 : activeTrackIds : 현재 practice 대상 active track 목록
 * - 인수 : mapper : tick을 seconds로 바꾸는 tempo mapper
 * - 인수 : scoreSeconds : 현재 score time
 * - 반환값 : 현재 이후 끝나지 않은 active note가 있으면 true
 */
export function hasRemainingGameJudgeTarget(
  analysis: AnalysisResult,
  activeTrackIds: readonly TrackId[],
  mapper: TickTimeMapper,
  scoreSeconds: number,
): boolean {
  if (!Number.isFinite(scoreSeconds) || activeTrackIds.length === 0) {
    return false;
  }

  const activeTrackIdSet = new Set(activeTrackIds);

  for (const trackResult of analysis.trackResults) {
    if (!activeTrackIdSet.has(trackResult.trackId)) {
      continue;
    }

    for (const event of trackResult.events) {
      if (!isNoteEvent(event)) {
        continue;
      }

      const endSeconds = mapper.tickToSeconds(event.time.endTick);

      if (scoreSeconds < endSeconds) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 현재 pitch frame과 note target 후보에서 scoring sample 하나를 만든다.
 * - 인수 : frame : 최신 마이크 pitch frame
 * - 인수 : targets : 현재 score time에 겹친 판정 후보 목록
 * - 인수 : scoreSeconds : 현재 score time
 * - 인수 : trackDifficulty : track별 점수 가중 난이도
 * - 인수 : correction : 표시용 pitch dot과 같은 hysteresis 보정을 적용할 선택 옵션
 * - 반환값 : 유효 pitch와 target이 있으면 sample, 아니면 null
 */
export function judgeGameScoringSample(
  frame: GamePitchFrame | null,
  targets: readonly GameJudgeTarget[],
  scoreSeconds: number,
  trackDifficulty: Record<TrackId, number>,
  correction?: GameScoringCorrectionOptions,
): GameScoringSampleResult | null {
  if (
    frame === null ||
    !frame.isVoiced ||
    frame.midi === null ||
    frame.centOffset === null ||
    targets.length === 0
  ) {
    return null;
  }

  const inputCent = resolveScoringInputCent(
    frame.midi,
    frame.centOffset,
    frame.capturedAtMs,
    targets,
    correction,
  );
  let selectedTarget: GameJudgeTarget | null = null;
  let selectedErrorCent = Number.POSITIVE_INFINITY;

  // 동시에 여러 active note가 있으면 pitch class 오차가 가장 작은 target 하나를 선택한다.
  for (const target of targets) {
    const targetCent = target.targetMidi * 100 + target.targetCentOffset;
    const errorCent = calculatePitchClassErrorCent(inputCent, targetCent);

    if (errorCent < selectedErrorCent) {
      selectedErrorCent = errorCent;
      selectedTarget = target;
    }
  }

  if (selectedTarget === null) {
    return null;
  }

  const label = classifyPitchError(selectedErrorCent);
  const pitchAccuracy = getPitchAccuracy(label);
  const difficulty = trackDifficulty[selectedTarget.trackId];
  const scoreContribution = label === "Miss" ? 0 : difficulty * pitchAccuracy;

  return {
    targetEventId: selectedTarget.eventId,
    trackId: selectedTarget.trackId,
    scoreSeconds,
    targetMidi: selectedTarget.targetMidi,
    targetCentOffset: selectedTarget.targetCentOffset,
    pitchAccuracy,
    label,
    status: label === "Miss" ? "miss" : "hit",
    scoreContribution,
  };
}

/**
 * scoring에 사용할 입력 pitch cent 값을 만든다.
 * - 인수 : midi : 최신 마이크 pitch frame의 MIDI note
 * - 인수 : centOffset : 최신 마이크 pitch frame의 cent offset
 * - 인수 : capturedAtMs : 최신 마이크 pitch frame 캡처 시각
 * - 인수 : targets : 현재 score time에 겹친 판정 후보 목록
 * - 인수 : correction : hysteresis 기반 보정 옵션
 * - 반환값 : 원 입력 또는 target 옥타브 주변으로 보정된 절대 cent 값
 */
function resolveScoringInputCent(
  midi: number,
  centOffset: number,
  capturedAtMs: number,
  targets: readonly GameJudgeTarget[],
  correction: GameScoringCorrectionOptions | undefined,
): number {
  if (correction === undefined) {
    return midi * 100 + centOffset;
  }

  // 표시용 pitch dot과 같은 target 후보를 사용해 짧은 detector octave/jump 흔들림을 점수에서도 완화한다.
  const correctedMidi = resolvePitchClassCandidateMidiWithHysteresis(
    midi,
    centOffset,
    targets.map((target) => ({
      midi: target.targetMidi,
      centOffset: target.targetCentOffset,
    })),
    capturedAtMs,
    correction.state,
  );

  return correctedMidi * 100;
}

/**
 * scoreDifficulty 저장값을 사용자 표시용 track difficulty로 정규화한다.
 * - 인수 : scoreDifficulty : ScoreFile musicData의 track별 난이도 값
 * - 반환값 : 0, 누락, 비정상 값을 기본 난이도로 대체한 map
 */
export function normalizeGameTrackDifficulty(
  scoreDifficulty: Partial<Record<TrackId, number>>,
): Record<TrackId, number> {
  return {
    basic: normalizeTrackDifficulty("basic", scoreDifficulty.basic),
    optional: normalizeTrackDifficulty("optional", scoreDifficulty.optional),
    extra: normalizeTrackDifficulty("extra", scoreDifficulty.extra),
  };
}

/**
 * scoring sample 결과를 누적 summary에 반영한다.
 * - 인수 : summary : 이전까지의 점수 집계
 * - 인수 : sample : 새 scoring sample
 * - 반환값 : sample이 반영된 새 점수 집계
 */
export function applyGameScoringSample(
  summary: GameScoreSummary,
  sample: GameScoringSampleResult,
): GameScoreSummary {
  const perfectCount = summary.perfectCount + (sample.label === "Perfect" ? 1 : 0);
  const okCount = summary.okCount + (sample.label === "Ok" ? 1 : 0);
  const badCount = summary.badCount + (sample.label === "Bad" ? 1 : 0);
  const missCount = summary.missCount + (sample.label === "Miss" ? 1 : 0);
  const currentCombo = sample.label === "Perfect" || sample.label === "Ok"
    ? summary.currentCombo + 1
    : 0;
  const hitSampleCount = perfectCount + okCount + badCount;
  const previousAccuracySum = getAccuracySum(summary);
  const nextAccuracySum = sample.label === "Miss"
    ? previousAccuracySum
    : previousAccuracySum + sample.pitchAccuracy;

  return {
    accuracyPercent: hitSampleCount === 0 ? 0 : (nextAccuracySum / hitSampleCount) * 100,
    perfectCount,
    okCount,
    badCount,
    missCount,
    currentCombo,
    bestCombo: Math.max(summary.bestCombo, currentCombo),
    score: summary.score + sample.scoreContribution,
  };
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
 * track별 difficulty 값을 게임 점수 계산용 값으로 정규화한다.
 * - 인수 : trackId : fallback을 고를 track id
 * - 인수 : value : ScoreFile에서 읽은 난이도 값
 * - 반환값 : 양의 유한수이면 원본 값, 아니면 기본 difficulty
 */
function normalizeTrackDifficulty(trackId: TrackId, value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TRACK_DIFFICULTY[trackId];
  }

  return value;
}

/**
 * pitch class 기준 cent 오차를 판정 label로 바꾼다.
 * - 인수 : errorCent : 0 이상 pitch class 오차 cent
 * - 반환값 : 표시할 판정 label
 */
function classifyPitchError(errorCent: number): GameScoringSampleResult["label"] {
  if (errorCent < PERFECT_ERROR_CENT) {
    return "Perfect";
  }

  if (errorCent < OK_ERROR_CENT) {
    return "Ok";
  }

  if (errorCent < BAD_ERROR_CENT) {
    return "Bad";
  }

  return "Miss";
}

/**
 * 판정 label을 점수 계산용 정확도로 바꾼다.
 * - 인수 : label : scoring sample 판정 label
 * - 반환값 : 0 이상 1 이하 pitch accuracy
 */
function getPitchAccuracy(label: GameScoringSampleResult["label"]): number {
  switch (label) {
    case "Perfect":
      return 1;
    case "Ok":
      return 0.6;
    case "Bad":
      return 0.2;
    case "Miss":
      return 0;
  }
}

/**
 * summary에 누적된 hit sample accuracy 합계를 복원한다.
 * - 인수 : summary : 현재 점수 집계
 * - 반환값 : hit sample accuracy 합계
 */
function getAccuracySum(summary: GameScoreSummary): number {
  const hitSampleCount = summary.perfectCount + summary.okCount + summary.badCount;

  return hitSampleCount === 0
    ? 0
    : (summary.accuracyPercent / 100) * hitSampleCount;
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
