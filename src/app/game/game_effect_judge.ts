/**
 * practice mode의 gliss/vib/trem effect bonus 판정 후보와 gliss 1차 판정을 담당한다.
 */

import type {
  AnalysisResult,
  AnalyzedEvent,
  GlissEvent,
} from "../../core/analyze/types";
import type { TrackId } from "../../core/score/types";
import type { TickTimeMapper } from "../../audio/audio_types";
import type {
  GameEffectBonusResult,
  GamePitchFrame,
} from "./game_types";

const GLISS_INTERVAL_SECONDS = 0.25;
const GLISS_INTERVAL_BONUS_MULTIPLIER = 0.25;

/** effect bonus 판정이 참조하는 pitch frame과 score time 묶음. */
export type GameEffectFrame = {
  scoreSeconds: number;
  frame: GamePitchFrame;
};

/** practice 중 한 번만 판정할 effect bonus 대상. */
export type GameEffectBonusTarget = {
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
      if (!isGlissEvent(event)) {
        continue;
      }

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
 * - 반환값 : 성공하면 Gliss! bonus 결과, 아니면 null
 */
export function judgeGlissIntervalBonus(
  target: GameEffectBonusTarget,
  frame: GamePitchFrame | null,
  scoreSeconds: number,
  intervalIndex: number,
  trackDifficulty: Record<TrackId, number>,
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

  const displayPitch = calculateGlissTargetPitch(target, scoreSeconds);

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
 * gliss target의 현재 interval index를 계산한다.
 * - 인수 : target : 판정을 기다리는 effect bonus 대상
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 반환값 : gliss 구간 안이면 0 이상 interval index, 아니면 null
 */
export function getGlissIntervalIndexAtSeconds(
  target: GameEffectBonusTarget,
  scoreSeconds: number,
): number | null {
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
 * gliss 진행 시간에 대응하는 target pitch를 선형 보간한다.
 * - 인수 : target : 보간할 gliss bonus 대상
 * - 인수 : scoreSeconds : 현재 Sync 보정 score time
 * - 반환값 : overlay 표시 위치로 사용할 target MIDI와 cent offset
 */
function calculateGlissTargetPitch(
  target: GameEffectBonusTarget,
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
