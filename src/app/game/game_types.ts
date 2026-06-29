/**
 * 게임 모드 런타임 상태와 UI 표시용 집계 타입을 정의한다.
 */

import type { TrackId } from "../../core/score/types";

export const DEFAULT_GAME_SYNC_OFFSET_MS = 90;
export const MIN_GAME_SYNC_OFFSET_MS = -200;
export const MAX_GAME_SYNC_OFFSET_MS = 200;
export const GAME_SYNC_OFFSET_STEP_MS = 10;

/**
 * Sync 보정값을 허용 범위와 step에 맞춘다.
 * - 인수 : value : 사용자가 조정한 ms 값
 * - 반환값 : -200ms~+200ms 범위의 10ms 단위 값
 */
export function normalizeGameSyncOffsetMs(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_GAME_SYNC_OFFSET_MS;
  }

  const stepped = Math.round(value / GAME_SYNC_OFFSET_STEP_MS) * GAME_SYNC_OFFSET_STEP_MS;

  return Math.min(Math.max(stepped, MIN_GAME_SYNC_OFFSET_MS), MAX_GAME_SYNC_OFFSET_MS);
}

/**
 * Sync ms 값을 사용자 표시 문자열로 만든다.
 * - 인수 : value : Sync ms 값
 * - 반환값 : +90 ms 형식의 문자열
 */
export function formatGameSyncOffsetMs(value: number): string {
  const normalized = normalizeGameSyncOffsetMs(value);
  const sign = normalized >= 0 ? "+" : "";

  return `${sign}${normalized} ms`;
}

/** 게임 모드 화면에 표시할 scoring sample 집계값. */
export type GameScoreSummary = {
  accuracyPercent: number;
  timingAccuracyPercent: number;
  perfectCount: number;
  okCount: number;
  badCount: number;
  missCount: number;
  timingOnTimeCount: number;
  timingEarlyCount: number;
  timingLateCount: number;
  timingBadCount: number;
  timingMissCount: number;
  glissBonusCount: number;
  vibBonusCount: number;
  tremBonusCount: number;
  effectBonusScore: number;
  currentCombo: number;
  bestCombo: number;
  score: number;
};

/** 마이크 입력에서 추정한 단일 pitch frame. */
export type GamePitchFrame = {
  capturedAtMs: number;
  rawFrequencyHz: number | null;
  frequencyHz: number | null;
  midi: number | null;
  centOffset: number | null;
  clarity: number;
  rms: number;
  isVoiced: boolean;
  rejectReason: "invalid frequency" | "unclear pitch" | "low clarity" | "low rms" | "out of range" | null;
};

/** 게임 모드에서 현재 score time과 비교할 note 판정 대상. */
export type GameJudgeTarget = {
  eventId: string;
  trackId: TrackId;
  startSeconds: number;
  endSeconds: number;
  targetMidi: number;
  targetCentOffset: number;
  attackRequired: boolean;
};

/** timing 판정에 사용할 입력 시작 후보. */
export type GameTimingOnsetCandidate = {
  id: number;
  scoreSeconds: number;
  midi: number;
  centOffset: number;
};

/** scoring sample에 덧붙이는 timing 판정 결과. */
export type GameTimingJudgeResult =
  | { kind: "none"; offsetMs: null }
  | { kind: "early"; offsetMs: number }
  | { kind: "late"; offsetMs: number }
  | { kind: "bad"; direction: "early" | "late"; offsetMs: number }
  | { kind: "miss"; offsetMs: number };

/** practice mode의 판정 엄격도. */
export type PracticeJudgeMode = "standard" | "pro";

/** scoring interval 하나에서 생성된 판정 결과. */
export type GameScoringSampleResult = {
  targetEventId: string;
  trackId: TrackId;
  scoreSeconds: number;
  targetMidi: number;
  targetCentOffset: number;
  pitchAccuracy: number;
  label: "Perfect" | "Ok" | "Bad" | "Miss";
  status: "hit" | "miss";
  scoreEligible: boolean;
  scoreBlockedReason: "attackRequired" | null;
  scoreContribution: number;
  timing: GameTimingJudgeResult;
  timingOnsetId: number | null;
  timingJudgedEventId: string | null;
};

/** practice effect bonus 판정 결과. 실패 판정은 만들지 않고 성공 시에만 생성한다. */
export type GameEffectBonusResult = {
  kind: "gliss" | "vib" | "trem";
  targetId: string;
  trackId: TrackId;
  scoreSeconds: number;
  targetMidi: number;
  targetCentOffset: number;
  bonusContribution: number;
  displayText: "Gliss!" | "Vib!" | "Trem!";
};

/** score JSON에 저장하지 않는 게임 모드 세션 상태. */
export type GameModeState =
  | { kind: "off" }
  | { kind: "preparing"; message: string }
  | { kind: "countdown"; count: number; summary: GameScoreSummary; pitchFrame: GamePitchFrame | null }
  | { kind: "ready"; summary: GameScoreSummary; pitchFrame: GamePitchFrame | null }
  | { kind: "playing"; summary: GameScoreSummary; pitchFrame: GamePitchFrame | null }
  | { kind: "paused"; summary: GameScoreSummary; pitchFrame: GamePitchFrame | null }
  | { kind: "finished"; summary: GameScoreSummary; pitchFrame: GamePitchFrame | null }
  | { kind: "error"; message: string };

/** 새 게임 모드 세션에서 사용할 빈 점수 집계를 만든다. */
export function createEmptyGameScoreSummary(): GameScoreSummary {
  return {
    accuracyPercent: 0,
    timingAccuracyPercent: 0,
    perfectCount: 0,
    okCount: 0,
    badCount: 0,
    missCount: 0,
    timingOnTimeCount: 0,
    timingEarlyCount: 0,
    timingLateCount: 0,
    timingBadCount: 0,
    timingMissCount: 0,
    glissBonusCount: 0,
    vibBonusCount: 0,
    tremBonusCount: 0,
    effectBonusScore: 0,
    currentCombo: 0,
    bestCombo: 0,
    score: 0,
  };
}

/**
 * 게임 모드 panel을 표시해야 하는지 확인한다.
 * - 인수 : state : 현재 게임 모드 상태
 * - 반환값 : off가 아니면 true
 */
export function isGameModeOpen(state: GameModeState): boolean {
  return state.kind !== "off";
}

/**
 * 게임 모드가 score 구조나 시간축 조작을 막아야 하는 상태인지 확인한다.
 * - 인수 : state : 현재 게임 모드 상태
 * - 반환값 : 세션이 준비/진행/정지/완료 상태이면 true
 */
export function isGameModeLocked(state: GameModeState): boolean {
  return state.kind === "preparing" ||
    state.kind === "countdown" ||
    state.kind === "ready" ||
    state.kind === "playing" ||
    state.kind === "paused" ||
    state.kind === "finished";
}

/**
 * 게임 모드가 active track 변경을 막아야 하는 상태인지 확인한다.
 * - 인수 : state : 현재 게임 모드 상태
 * - 반환값 : practice ready/off/error 외 상태이면 true
 */
export function isGameModeTrackChangeLocked(state: GameModeState): boolean {
  return state.kind === "preparing" ||
    state.kind === "countdown" ||
    state.kind === "playing" ||
    state.kind === "paused" ||
    state.kind === "finished";
}

/**
 * 게임 모드 상태에서 표시 가능한 점수 집계를 꺼낸다.
 * - 인수 : state : 현재 게임 모드 상태
 * - 반환값 : 점수 집계가 있는 상태이면 해당 집계, 아니면 빈 집계
 */
export function getGameScoreSummary(state: GameModeState): GameScoreSummary {
  if (
    state.kind === "ready" ||
    state.kind === "countdown" ||
    state.kind === "playing" ||
    state.kind === "paused" ||
    state.kind === "finished"
  ) {
    return state.summary;
  }

  return createEmptyGameScoreSummary();
}
