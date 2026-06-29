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
  GameEffectBonusResult,
  GamePitchFrame,
  GameScoreSummary,
  GameScoringSampleResult,
  GameTimingJudgeResult,
  GameTimingOnsetCandidate,
} from "./game_types";

const PERFECT_ERROR_CENT = 50;
const OK_ERROR_CENT = 100;
const BAD_ERROR_CENT = 200;
const NEXT_NOTE_GRACE_SECONDS = 0.03334;
const PREVIOUS_NOTE_GRACE_SECONDS = 0.03334;
const TIMING_DISPLAY_THRESHOLD_MS = 80;
const TIMING_BAD_THRESHOLD_MS = 150;
const TIMING_MISS_THRESHOLD_MS = 250;
const TIMING_MAX_MATCH_MS = 500;
const DEFAULT_TRACK_DIFFICULTY: Record<TrackId, number> = {
  basic: 1,
  optional: 1.2,
  extra: 1.5,
};

/** scoring sample에 적용할 timing 판정 입력. */
export type GameTimingJudgeOptions = {
  onsetCandidates: readonly GameTimingOnsetCandidate[];
  judgedEventIds: ReadonlySet<string>;
  consumedOnsetIds: ReadonlySet<number>;
  attackSatisfiedEventIds: ReadonlySet<string>;
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

  // active track의 현재 NoteEvent와 짧은 전환 보정 구간의 이웃 NoteEvent를 판정 후보로 수집한다.
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

      if (
        scoreSeconds < startSeconds - NEXT_NOTE_GRACE_SECONDS ||
        scoreSeconds >= endSeconds + PREVIOUS_NOTE_GRACE_SECONDS
      ) {
        continue;
      }

      targets.push({
        eventId: event.eventId,
        trackId: event.trackId,
        startSeconds,
        endSeconds,
        targetMidi: event.sound.midi,
        targetCentOffset: event.sound.centOffset,
        attackRequired: isAttackRequiredNoteEvent(event),
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
 * - 반환값 : 유효 pitch와 target이 있으면 sample, 아니면 null
 */
export function judgeGameScoringSample(
  frame: GamePitchFrame | null,
  targets: readonly GameJudgeTarget[],
  scoreSeconds: number,
  trackDifficulty: Record<TrackId, number>,
  timing?: GameTimingJudgeOptions,
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

  const inputCent = frame.midi * 100 + frame.centOffset;
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

  const pitchLabel = classifyPitchError(selectedErrorCent);
  const timingMatch = timing === undefined
    ? createEmptyTimingMatch()
    : judgeTimingForTarget(selectedTarget, timing);
  const label = applyTimingDowngrade(pitchLabel, timingMatch.result);
  const pitchAccuracy = getPitchAccuracy(label);
  const difficulty = trackDifficulty[selectedTarget.trackId];
  const scoreEligible = isScoreEligibleForAttack(selectedTarget, label, timingMatch.onsetId, timing);
  const scoreContribution = label === "Miss" || !scoreEligible ? 0 : difficulty * pitchAccuracy;

  return {
    targetEventId: selectedTarget.eventId,
    trackId: selectedTarget.trackId,
    scoreSeconds,
    targetMidi: selectedTarget.targetMidi,
    targetCentOffset: selectedTarget.targetCentOffset,
    pitchAccuracy,
    label,
    status: label === "Miss" ? "miss" : "hit",
    scoreEligible,
    scoreBlockedReason: scoreEligible ? null : "attackRequired",
    scoreContribution,
    timing: timingMatch.result,
    timingOnsetId: timingMatch.onsetId,
    timingJudgedEventId: timingMatch.onsetId === null ? null : selectedTarget.eventId,
  };
}

/**
 * timing 후보가 없을 때 사용할 빈 timing 결과를 만든다.
 * - 인수 : 없음
 * - 반환값 : 표시와 label 강등이 없는 timing match
 */
function createEmptyTimingMatch(): {
  result: GameTimingJudgeResult;
  onsetId: number | null;
} {
  return {
    result: {
      kind: "none",
      offsetMs: null,
    },
    onsetId: null,
  };
}

/**
 * 선택된 note target의 시작 시각과 가장 가까운 onset 후보로 timing 판정을 만든다.
 * - 인수 : target : pitch 판정에서 선택된 note target
 * - 인수 : options : onset 후보와 이미 사용한 event/onset 상태
 * - 반환값 : timing 표시/강등 결과와 사용한 onset id
 */
function judgeTimingForTarget(
  target: GameJudgeTarget,
  options: GameTimingJudgeOptions,
): {
  result: GameTimingJudgeResult;
  onsetId: number | null;
} {
  if (options.judgedEventIds.has(target.eventId)) {
    return createEmptyTimingMatch();
  }

  let selectedOnset: GameTimingOnsetCandidate | null = null;
  let selectedAbsOffsetMs = Number.POSITIVE_INFINITY;

  // target 시작점과 가장 가까운 아직 쓰지 않은 onset 하나만 timing 판정에 배정한다.
  for (const onset of options.onsetCandidates) {
    if (options.consumedOnsetIds.has(onset.id)) {
      continue;
    }

    const offsetMs = (onset.scoreSeconds - target.startSeconds) * 1000;
    const absOffsetMs = Math.abs(offsetMs);

    if (absOffsetMs > TIMING_MAX_MATCH_MS || absOffsetMs >= selectedAbsOffsetMs) {
      continue;
    }

    selectedOnset = onset;
    selectedAbsOffsetMs = absOffsetMs;
  }

  if (selectedOnset === null) {
    return createEmptyTimingMatch();
  }

  const offsetMs = (selectedOnset.scoreSeconds - target.startSeconds) * 1000;
  const absOffsetMs = Math.abs(offsetMs);

  if (absOffsetMs >= TIMING_MISS_THRESHOLD_MS) {
    return {
      result: {
        kind: "miss",
        offsetMs,
      },
      onsetId: selectedOnset.id,
    };
  }

  if (absOffsetMs >= TIMING_BAD_THRESHOLD_MS) {
    return {
      result: {
        kind: "bad",
        direction: offsetMs < 0 ? "early" : "late",
        offsetMs,
      },
      onsetId: selectedOnset.id,
    };
  }

  if (absOffsetMs >= TIMING_DISPLAY_THRESHOLD_MS) {
    return {
      result: {
        kind: offsetMs < 0 ? "early" : "late",
        offsetMs,
      },
      onsetId: selectedOnset.id,
    };
  }

  return {
    result: {
      kind: "none",
      offsetMs: null,
    },
    onsetId: selectedOnset.id,
  };
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
  if (!sample.scoreEligible) {
    return summary;
  }

  const perfectCount = summary.perfectCount + (sample.label === "Perfect" ? 1 : 0);
  const okCount = summary.okCount + (sample.label === "Ok" ? 1 : 0);
  const badCount = summary.badCount + (sample.label === "Bad" ? 1 : 0);
  const missCount = summary.missCount + (sample.label === "Miss" ? 1 : 0);
  const timingOnTimeCount = summary.timingOnTimeCount +
    (sample.timingOnsetId !== null && sample.timing.kind === "none" ? 1 : 0);
  const timingEarlyCount = summary.timingEarlyCount + (sample.timing.kind === "early" ? 1 : 0);
  const timingLateCount = summary.timingLateCount + (sample.timing.kind === "late" ? 1 : 0);
  const timingBadCount = summary.timingBadCount + (sample.timing.kind === "bad" ? 1 : 0);
  const timingMissCount = summary.timingMissCount + (sample.timing.kind === "miss" ? 1 : 0);
  const currentCombo = sample.scoreEligible && sample.label !== "Miss"
    ? summary.currentCombo + 1
    : 0;
  const scoredSampleCount = perfectCount + okCount + badCount + missCount;
  const timingSampleCount = timingOnTimeCount +
    timingEarlyCount +
    timingLateCount +
    timingBadCount +
    timingMissCount;
  const previousAccuracySum = getAccuracySum(summary);
  const nextAccuracySum = previousAccuracySum + sample.pitchAccuracy;
  const previousTimingAccuracySum = getTimingAccuracySum(summary);
  const nextTimingAccuracySum = previousTimingAccuracySum + getTimingAccuracy(sample);

  return {
    accuracyPercent: scoredSampleCount === 0 ? 0 : (nextAccuracySum / scoredSampleCount) * 100,
    timingAccuracyPercent: timingSampleCount === 0 ? 0 : (nextTimingAccuracySum / timingSampleCount) * 100,
    perfectCount,
    okCount,
    badCount,
    missCount,
    timingOnTimeCount,
    timingEarlyCount,
    timingLateCount,
    timingBadCount,
    timingMissCount,
    glissBonusCount: summary.glissBonusCount,
    vibBonusCount: summary.vibBonusCount,
    tremBonusCount: summary.tremBonusCount,
    effectBonusScore: summary.effectBonusScore,
    currentCombo,
    bestCombo: Math.max(summary.bestCombo, currentCombo),
    score: summary.score + sample.scoreContribution,
  };
}

/**
 * effect bonus 성공 결과를 점수 집계에 더한다.
 * - 인수 : summary : 이전까지의 점수 집계
 * - 인수 : bonus : 성공한 effect bonus 결과
 * - 반환값 : bonus가 반영된 새 점수 집계
 */
export function applyGameEffectBonus(
  summary: GameScoreSummary,
  bonus: GameEffectBonusResult,
): GameScoreSummary {
  return {
    ...summary,
    glissBonusCount: summary.glissBonusCount + (bonus.kind === "gliss" ? 1 : 0),
    vibBonusCount: summary.vibBonusCount + (bonus.kind === "vib" ? 1 : 0),
    tremBonusCount: summary.tremBonusCount + (bonus.kind === "trem" ? 1 : 0),
    effectBonusScore: summary.effectBonusScore + bonus.bonusContribution,
    score: summary.score + bonus.bonusContribution,
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
 * note event가 새 attack 확인을 요구하는지 판단한다.
 * - 인수 : event : 판정 target으로 변환할 note event
 * - 반환값 : gliss 종료 anchor처럼 legato 문맥이면 false, 일반 note이면 true
 */
function isAttackRequiredNoteEvent(event: NoteEvent): boolean {
  return event.glissRole?.role !== "end";
}

/**
 * attack credit 기준으로 scoring sample이 점수와 combo를 받을 수 있는지 판단한다.
 * - 인수 : target : pitch 판정에서 선택된 note target
 * - 인수 : label : pitch/timing을 반영한 최종 label
 * - 인수 : timingOnsetId : 이번 sample에 배정된 onset id
 * - 인수 : timing : timing/attack 판정 런타임 상태
 * - 반환값 : 점수와 combo 지급 가능 여부
 */
function isScoreEligibleForAttack(
  target: GameJudgeTarget,
  label: GameScoringSampleResult["label"],
  timingOnsetId: number | null,
  timing: GameTimingJudgeOptions | undefined,
): boolean {
  if (label === "Miss" || timing === undefined || !target.attackRequired) {
    return true;
  }

  return timingOnsetId !== null || timing.attackSatisfiedEventIds.has(target.eventId);
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
 * timing 판정 결과를 최종 pitch label 강등에 반영한다.
 * - 인수 : pitchLabel : pitch 오차만으로 계산한 판정 label
 * - 인수 : timing : onset timing 판정 결과
 * - 반환값 : timing miss/bad 강등을 반영한 최종 label
 */
function applyTimingDowngrade(
  pitchLabel: GameScoringSampleResult["label"],
  timing: GameTimingJudgeResult,
): GameScoringSampleResult["label"] {
  if (timing.kind === "miss") {
    return "Miss";
  }

  if (timing.kind === "bad" && (pitchLabel === "Perfect" || pitchLabel === "Ok")) {
    return "Bad";
  }

  return pitchLabel;
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
      return 2 / 3;
    case "Bad":
      return 1 / 3;
    case "Miss":
      return 0;
  }
}

/**
 * timing 판정 결과를 timing accuracy 계산용 값으로 바꾼다.
 * - 인수 : sample : scoring sample 결과
 * - 반환값 : timing onset이 매칭되었으면 0 이상 1 이하 값, 아니면 0
 */
function getTimingAccuracy(sample: GameScoringSampleResult): number {
  if (sample.timingOnsetId === null) {
    return 0;
  }

  switch (sample.timing.kind) {
    case "none":
      return 1;
    case "early":
    case "late":
      return 2 / 3;
    case "bad":
      return 1 / 3;
    case "miss":
      return 0;
  }
}

/**
 * summary에 누적된 scoring sample accuracy 합계를 복원한다.
 * - 인수 : summary : 현재 점수 집계
 * - 반환값 : Miss를 0% 샘플로 포함한 accuracy 합계
 */
function getAccuracySum(summary: GameScoreSummary): number {
  const scoredSampleCount = summary.perfectCount +
    summary.okCount +
    summary.badCount +
    summary.missCount;

  return scoredSampleCount === 0
    ? 0
    : (summary.accuracyPercent / 100) * scoredSampleCount;
}

/**
 * summary에 누적된 timing accuracy 합계를 복원한다.
 * - 인수 : summary : 현재 점수 집계
 * - 반환값 : timing 판정 sample의 accuracy 합계
 */
function getTimingAccuracySum(summary: GameScoreSummary): number {
  const timingSampleCount = summary.timingOnTimeCount +
    summary.timingEarlyCount +
    summary.timingLateCount +
    summary.timingBadCount +
    summary.timingMissCount;

  return timingSampleCount === 0
    ? 0
    : (summary.timingAccuracyPercent / 100) * timingSampleCount;
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
