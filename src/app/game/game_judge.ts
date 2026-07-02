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
import { timeFractionToNumber } from "../../audio/tick_time_mapper";
import type {
  GameJudgeTarget,
  GameEffectBonusResult,
  GamePitchFrame,
  PracticeJudgeMode,
  GameScoreSummary,
  GameScoringSampleResult,
  GameTimingJudgeResult,
  GameTimingOnsetCandidate,
} from "./game_types";

const NOTE_TRANSITION_GRACE_SECONDS = 0.12;
const NEXT_NOTE_GRACE_SECONDS = NOTE_TRANSITION_GRACE_SECONDS;
const PREVIOUS_NOTE_GRACE_SECONDS = NOTE_TRANSITION_GRACE_SECONDS;
const RAPID_REPEAT_TREM_MIN_COUNT = 3;
const RAPID_REPEAT_TREM_MAX_NOTE_TICKS = 1;
const RAPID_REPEAT_TREM_MAX_GAP_TICKS = 1e-6;
const EXPLICIT_TREM_RELAX_MIN_DIVISION = 2;
const EXPLICIT_TREM_RELAX_MAX_DIVISION = 4;
const SYNTHETIC_TREM_TIMING_ONSET_ID = -1;
const TIMING_MAX_MATCH_MS = 500;
const JUDGE_THRESHOLDS: Record<PracticeJudgeMode, {
  perfectErrorCent: number;
  okErrorCent: number;
  badErrorCent: number;
  timingDisplayMs: number;
  timingBadMs: number;
  timingMissMs: number;
}> = {
  easy: {
    perfectErrorCent: 50,
    okErrorCent: 100,
    badErrorCent: 200,
    timingDisplayMs: 80,
    timingBadMs: 150,
    timingMissMs: 250,
  },
  standard: {
    perfectErrorCent: 50,
    okErrorCent: 100,
    badErrorCent: 200,
    timingDisplayMs: 80,
    timingBadMs: 150,
    timingMissMs: 250,
  },
  pro: {
    perfectErrorCent: 30,
    okErrorCent: 60,
    badErrorCent: 100,
    timingDisplayMs: 50,
    timingBadMs: 100,
    timingMissMs: 150,
  },
};
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

    const rapidRepeatTremEventIds = collectRapidRepeatTremEventIds(trackResult.events);

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

      const explicitTremTargetId = getExplicitTremRelaxedTargetIdAtSeconds(event, mapper, scoreSeconds);
      const isRapidRepeatTrem = rapidRepeatTremEventIds.has(event.eventId);
      const isTremRelaxed = explicitTremTargetId !== null || isRapidRepeatTrem;

      targets.push({
        eventId: explicitTremTargetId ?? event.eventId,
        trackId: event.trackId,
        startSeconds,
        endSeconds,
        targetMidi: event.sound.midi,
        targetCentOffset: event.sound.centOffset,
        attackRequired: isAttackRequiredNoteEvent(event),
        tremRelaxed: isTremRelaxed,
        rapidRepeatTrem: isRapidRepeatTrem,
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
  judgeMode: PracticeJudgeMode = "standard",
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

  // 동시에 여러 active note가 있으면 pitch class 오차와 현재 note 구간 우선순위로 target 하나를 선택한다.
  for (const target of targets) {
    const targetCent = target.targetMidi * 100 + target.targetCentOffset;
    const errorCent = calculatePitchClassErrorCent(inputCent, targetCent);

    if (isPreferredJudgeTarget(target, errorCent, selectedTarget, selectedErrorCent, scoreSeconds)) {
      selectedErrorCent = errorCent;
      selectedTarget = target;
    }
  }

  if (selectedTarget === null) {
    return null;
  }

  const thresholds = JUDGE_THRESHOLDS[judgeMode];
  const pitchLabel = classifyPitchError(selectedErrorCent, thresholds);
  const isTremRelaxedHit = selectedTarget.tremRelaxed === true && pitchLabel !== "Miss";
  const timingMatch = judgeMode === "easy" || timing === undefined || isTremRelaxedHit
    ? createEmptyTimingMatch()
    : judgeTimingForTarget(selectedTarget, timing, thresholds);
  const label = isTremRelaxedHit ? "Perfect" : applyTimingDowngrade(pitchLabel, timingMatch.result);
  const pitchAccuracy = getPitchAccuracy(label);
  const difficulty = trackDifficulty[selectedTarget.trackId];
  const scoreEligible = judgeMode === "easy" ||
    isTremRelaxedHit ||
    isScoreEligibleForAttack(selectedTarget, label, timingMatch.onsetId, timing);
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
    timingOnsetId: isTremRelaxedHit ? SYNTHETIC_TREM_TIMING_ONSET_ID : timingMatch.onsetId,
    timingJudgedEventId: isTremRelaxedHit || timingMatch.onsetId !== null ? selectedTarget.eventId : null,
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
 * pitch 오차와 현재 score time 기준으로 더 적합한 note target인지 판단한다.
 * - 인수 : candidate : 새로 비교할 target
 * - 인수 : candidateErrorCent : candidate의 pitch class 오차
 * - 인수 : selected : 기존 선택 target
 * - 인수 : selectedErrorCent : 기존 선택 target의 pitch class 오차
 * - 인수 : scoreSeconds : 현재 판정 score time
 * - 반환값 : candidate를 새 target으로 선택해야 하면 true
 */
function isPreferredJudgeTarget(
  candidate: GameJudgeTarget,
  candidateErrorCent: number,
  selected: GameJudgeTarget | null,
  selectedErrorCent: number,
  scoreSeconds: number,
): boolean {
  if (selected === null) {
    return true;
  }

  if (candidateErrorCent < selectedErrorCent) {
    return true;
  }

  if (candidateErrorCent > selectedErrorCent) {
    return false;
  }

  const candidateActive = isTargetActiveAtSeconds(candidate, scoreSeconds);
  const selectedActive = isTargetActiveAtSeconds(selected, scoreSeconds);

  // 동일 pitch에서는 grace로 남은 이전 note보다 실제 현재 구간에 들어온 note를 우선한다.
  if (candidateActive !== selectedActive) {
    return candidateActive;
  }

  return false;
}

/**
 * target의 원래 note 발음 구간 안에 현재 score time이 있는지 확인한다.
 * - 인수 : target : 검사할 판정 target
 * - 인수 : scoreSeconds : 현재 판정 score time
 * - 반환값 : grace 구간이 아니라 실제 note 구간이면 true
 */
function isTargetActiveAtSeconds(
  target: GameJudgeTarget,
  scoreSeconds: number,
): boolean {
  return scoreSeconds >= target.startSeconds && scoreSeconds < target.endSeconds;
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
  thresholds: (typeof JUDGE_THRESHOLDS)[PracticeJudgeMode],
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

  if (absOffsetMs >= thresholds.timingMissMs) {
    return {
      result: {
        kind: "miss",
        offsetMs,
      },
      onsetId: selectedOnset.id,
    };
  }

  if (absOffsetMs >= thresholds.timingBadMs) {
    return {
      result: {
        kind: "bad",
        direction: offsetMs < 0 ? "early" : "late",
        offsetMs,
      },
      onsetId: selectedOnset.id,
    };
  }

  if (absOffsetMs >= thresholds.timingDisplayMs) {
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
  judgeMode: PracticeJudgeMode = "standard",
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
  const currentCombo = shouldContinueGameCombo(sample, judgeMode) ? summary.currentCombo + 1 : 0;
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
 * active track event 목록에서 1tick rapid-repeat trem run에 속한 note event id를 수집한다.
 * - 인수 : events : analyzer가 만든 track event 목록
 * - 반환값 : rapid-repeat trem으로 완화 판정을 적용할 note event id 집합
 */
function collectRapidRepeatTremEventIds(events: readonly AnalyzedEvent[]): Set<string> {
  const noteEvents = events
    .filter(isNoteEvent)
    .sort((left, right) =>
      timeFractionToNumber(left.time.startTick) - timeFractionToNumber(right.time.startTick)
    );
  const eventIds = new Set<string>();
  let runStartIndex = 0;

  for (let index = 1; index <= noteEvents.length; index += 1) {
    const previous = noteEvents[index - 1];
    const current = noteEvents[index];

    if (
      previous !== undefined &&
      current !== undefined &&
      canContinueRapidRepeatTremRun(previous, current)
    ) {
      continue;
    }

    addRapidRepeatTremRunEventIds(noteEvents, runStartIndex, index, eventIds);
    runStartIndex = index;
  }

  return eventIds;
}

/**
 * 두 note event가 rapid-repeat trem run으로 이어질 수 있는지 확인한다.
 * - 인수 : left : 앞 note event
 * - 인수 : right : 뒤 note event
 * - 반환값 : 같은 pitch class의 1tick 이하 연속 note이면 true
 */
function canContinueRapidRepeatTremRun(left: NoteEvent, right: NoteEvent): boolean {
  const leftStartTick = timeFractionToNumber(left.time.startTick);
  const leftEndTick = timeFractionToNumber(left.time.endTick);
  const rightStartTick = timeFractionToNumber(right.time.startTick);
  const rightEndTick = timeFractionToNumber(right.time.endTick);

  return !hasExplicitTremEffect(left) &&
    !hasExplicitTremEffect(right) &&
    left.trackId === right.trackId &&
    left.sound.midi % 12 === right.sound.midi % 12 &&
    leftEndTick - leftStartTick <= RAPID_REPEAT_TREM_MAX_NOTE_TICKS + RAPID_REPEAT_TREM_MAX_GAP_TICKS &&
    rightEndTick - rightStartTick <= RAPID_REPEAT_TREM_MAX_NOTE_TICKS + RAPID_REPEAT_TREM_MAX_GAP_TICKS &&
    Math.abs(rightStartTick - leftEndTick) <= RAPID_REPEAT_TREM_MAX_GAP_TICKS;
}

/**
 * 충분히 긴 rapid-repeat run의 note event id를 결과 집합에 추가한다.
 * - 인수 : noteEvents : 시작 tick으로 정렬된 note event 목록
 * - 인수 : startIndex : run 시작 index
 * - 인수 : endIndex : run 끝 다음 index
 * - 인수 : eventIds : 결과를 누적할 id 집합
 * - 반환값 : 없음
 */
function addRapidRepeatTremRunEventIds(
  noteEvents: readonly NoteEvent[],
  startIndex: number,
  endIndex: number,
  eventIds: Set<string>,
): void {
  if (endIndex - startIndex < RAPID_REPEAT_TREM_MIN_COUNT) {
    return;
  }

  for (let index = startIndex; index < endIndex; index += 1) {
    const event = noteEvents[index];

    if (event !== undefined) {
      eventIds.add(event.eventId);
    }
  }
}

/**
 * note event가 explicit trem modifier segment를 포함하는지 확인한다.
 * - 인수 : event : 검사할 note event
 * - 반환값 : trem effect segment가 하나라도 있으면 true
 */
function hasExplicitTremEffect(event: NoteEvent): boolean {
  return event.effects.some((effect) => effect.trem !== null && effect.trem !== undefined);
}

/**
 * 현재 score time이 속한 2~4 division explicit trem 내부 hit 식별자를 만든다.
 * - 인수 : event : 검사할 note event
 * - 인수 : mapper : tick을 seconds로 바꾸는 tempo mapper
 * - 인수 : scoreSeconds : 현재 판정 score seconds
 * - 반환값 : trem 내부 hit 식별자. 해당하지 않으면 null
 */
function getExplicitTremRelaxedTargetIdAtSeconds(
  event: NoteEvent,
  mapper: TickTimeMapper,
  scoreSeconds: number,
): string | null {
  for (let index = 0; index < event.effects.length; index += 1) {
    const effect = event.effects[index];

    if (
      effect === undefined ||
      effect.trem === null ||
      effect.trem === undefined ||
      effect.trem.division < EXPLICIT_TREM_RELAX_MIN_DIVISION ||
      effect.trem.division > EXPLICIT_TREM_RELAX_MAX_DIVISION
    ) {
      continue;
    }

    const startSeconds = mapper.tickToSeconds(effect.time.startTick);
    const endSeconds = mapper.tickToSeconds(effect.time.endTick);

    if (scoreSeconds >= startSeconds && scoreSeconds < endSeconds) {
      const durationSeconds = endSeconds - startSeconds;
      const localRatio = durationSeconds <= 0 ? 0 : (scoreSeconds - startSeconds) / durationSeconds;
      const hitIndex = Math.min(
        effect.trem.division - 1,
        Math.max(0, Math.floor(localRatio * effect.trem.division)),
      );

      return `${event.eventId}:trem-relaxed:${index}:${hitIndex}`;
    }
  }

  return null;
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
function classifyPitchError(
  errorCent: number,
  thresholds: (typeof JUDGE_THRESHOLDS)[PracticeJudgeMode],
): GameScoringSampleResult["label"] {
  if (errorCent < thresholds.perfectErrorCent) {
    return "Perfect";
  }

  if (errorCent < thresholds.okErrorCent) {
    return "Ok";
  }

  if (errorCent < thresholds.badErrorCent) {
    return "Bad";
  }

  return "Miss";
}

/**
 * 현재 judge mode에서 sample이 combo를 이어갈 수 있는지 확인한다.
 * - 인수 : sample : 점수 반영 대상 sample
 * - 인수 : judgeMode : easy/standard/pro 판정 엄격도
 * - 반환값 : combo 증가 대상이면 true
 */
function shouldContinueGameCombo(
  sample: GameScoringSampleResult,
  judgeMode: PracticeJudgeMode,
): boolean {
  if (!sample.scoreEligible || sample.label === "Miss") {
    return false;
  }

  return judgeMode !== "pro" || sample.label !== "Bad";
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
