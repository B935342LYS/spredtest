/**
 * 게임 모드 런타임 상태를 player 영역의 practice panel에 반영한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import {
  type GamePitchFrame,
  type GameScoreSummary,
  formatGameSyncOffsetMs,
  getGameScoreSummary,
  isGameModeLocked,
  isGameModeOpen,
} from "./game_types";

/**
 * 게임 모드 상태를 사용자에게 표시할 짧은 status 문자열로 만든다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : practice panel status 문자열
 */
function formatGameStatus(state: AppState): string {
  switch (state.gameMode.kind) {
    case "off":
      return "off";
    case "preparing":
      return "preparing";
    case "countdown":
      return String(state.gameMode.count);
    case "ready":
      return "ready";
    case "playing":
      return "playing";
    case "paused":
      return "paused";
    case "finished":
      return "finished";
    case "error":
      return "error";
  }
}

/**
 * 게임 모드 panel과 practice mode 버튼을 현재 AppState에 맞춘다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncGameModeUi(dom: AppDom, state: AppState): void {
  const summary = getGameScoreSummary(state.gameMode);
  const isOpen = isGameModeOpen(state.gameMode);
  const isLocked = isGameModeLocked(state.gameMode);
  const isProMode = state.practiceJudgeMode === "pro";
  const statusText = state.gameMode.kind === "preparing"
    ? state.gameMode.message
    : state.gameMode.kind === "error"
      ? state.gameMode.message
      : formatGameStatus(state);

  dom.gamePanel.dataset.state = state.gameMode.kind;
  dom.gamePanel.dataset.judgeMode = state.practiceJudgeMode;
  dom.gameStatus.textContent = statusText;
  dom.gameStatus.title = statusText;
  dom.gameAccuracy.textContent = formatAccuracyPercent(summary.accuracyPercent);
  dom.gameTimingAccuracy.textContent = formatAccuracyPercent(summary.timingAccuracyPercent);
  dom.gamePerfectCount.textContent = String(summary.perfectCount);
  dom.gameOkCount.textContent = String(summary.okCount);
  dom.gameBadCount.textContent = String(summary.badCount);
  dom.gameMissCount.textContent = String(summary.missCount);
  dom.gameGlissBonusCount.textContent = String(summary.glissBonusCount);
  dom.gameVibBonusCount.textContent = String(summary.vibBonusCount);
  dom.gameTremBonusCount.textContent = String(summary.tremBonusCount);
  dom.gameCombo.textContent = String(summary.bestCombo);
  dom.gameScore.textContent = String(Math.round(summary.score));
  dom.gameSyncValue.textContent = formatGameSyncOffsetMs(state.gameSyncOffsetMs);
  dom.practiceSyncValue.textContent = formatGameSyncOffsetMs(state.gameSyncOffsetMs);
  dom.gameProButton.disabled = state.busy.kind !== "idle" ||
    (
      state.gameMode.kind !== "off" &&
      state.gameMode.kind !== "ready"
    );
  dom.gameProButton.textContent = isProMode ? "Pro on" : "Pro";
  dom.gameProButton.setAttribute("aria-pressed", String(isProMode));
  dom.gameProButton.classList.toggle("on", isProMode);
  dom.gameProButton.classList.toggle("off", !isProMode);
  syncGameDiagnostics(dom, getVisiblePitchFrame(state));
  dom.practiceModeButton.disabled = state.busy.kind !== "idle" && !isLocked;
  dom.practiceModeButton.textContent = isOpen ? "exit practice" : "practice mode (beta)";
  dom.practiceModeButton.setAttribute("aria-pressed", String(isOpen));
  dom.practiceModeButton.classList.toggle("on", isOpen);
  dom.practiceModeButton.classList.toggle("off", !isOpen);
}

/**
 * 현재 game mode 상태에서 표시 가능한 pitch frame을 꺼낸다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : pitch frame을 가진 상태이면 해당 frame, 아니면 null
 */
function getVisiblePitchFrame(state: AppState): GamePitchFrame | null {
  if (
    state.gameMode.kind === "ready" ||
    state.gameMode.kind === "countdown" ||
    state.gameMode.kind === "playing" ||
    state.gameMode.kind === "paused" ||
    state.gameMode.kind === "finished"
  ) {
    return state.gameMode.pitchFrame;
  }

  return null;
}

/**
 * practice panel의 마이크 입력 진단 값을 최신 pitch frame에 맞춰 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : frame : 최신 pitch frame 또는 null
 * - 반환값 : 없음
 */
function syncGameDiagnostics(dom: AppDom, frame: GamePitchFrame | null): void {
  if (frame === null) {
    dom.gameMicState.textContent = "--";
    dom.gameMicState.title = "";
    dom.gameRawFrequency.textContent = "--.-";
    dom.gameClarity.textContent = "-.--";
    dom.gameRms.textContent = "-.---";
    return;
  }

  const micState = formatMicState(frame);

  dom.gameMicState.textContent = micState;
  dom.gameMicState.title = frame.rejectReason ?? micState;
  dom.gameRawFrequency.textContent = frame.rawFrequencyHz === null
    ? "--.-"
    : frame.rawFrequencyHz.toFixed(1);
  dom.gameClarity.textContent = frame.clarity.toFixed(2);
  dom.gameRms.textContent = frame.rms.toFixed(3);
}

/**
 * pitch frame의 입력 상태를 짧은 고정 폭 label로 만든다.
 * - 인수 : frame : 최신 pitch frame
 * - 반환값 : practice panel에 표시할 짧은 mic 상태 문자열
 */
function formatMicState(frame: GamePitchFrame): string {
  if (frame.isVoiced) {
    return "voice";
  }

  switch (frame.rejectReason) {
    case "low rms":
      return "quiet";
    case "low clarity":
    case "unclear pitch":
      return "unclear";
    case "out of range":
      return "range";
    case "invalid frequency":
      return "invalid";
    case null:
      return "reject";
  }
}

/**
 * practice result dialog에 최종 점수 집계를 표시한 뒤 연다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : summary : finished 상태에서 보여줄 점수 집계
 * - 반환값 : 없음
 */
export function openPracticeResultDialog(dom: AppDom, summary: GameScoreSummary): void {
  dom.resultMode.textContent = "Standard";
  dom.resultAccuracy.textContent = formatAccuracyPercent(summary.accuracyPercent);
  dom.resultTimingAccuracy.textContent = formatAccuracyPercent(summary.timingAccuracyPercent);
  dom.resultScore.textContent = String(Math.round(summary.score));
  dom.resultPerfectCount.textContent = String(summary.perfectCount);
  dom.resultOkCount.textContent = String(summary.okCount);
  dom.resultBadCount.textContent = String(summary.badCount);
  dom.resultMissCount.textContent = String(summary.missCount);
  dom.resultTimingEarlyCount.textContent = String(summary.timingEarlyCount);
  dom.resultTimingLateCount.textContent = String(summary.timingLateCount);
  dom.resultTimingBadCount.textContent = String(summary.timingBadCount);
  dom.resultTimingMissCount.textContent = String(summary.timingMissCount);
  dom.resultGlissBonusCount.textContent = String(summary.glissBonusCount);
  dom.resultVibBonusCount.textContent = String(summary.vibBonusCount);
  dom.resultTremBonusCount.textContent = String(summary.tremBonusCount);
  dom.resultEffectBonusScore.textContent = `+${Math.round(summary.effectBonusScore)}`;
  dom.resultBestCombo.textContent = String(summary.bestCombo);

  if (!dom.practiceResultDialog.open) {
    dom.practiceResultDialog.showModal();
  }
}

/**
 * practice result dialog에 score metadata와 최종 점수 집계를 표시한 뒤 연다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : finished 상태에서 보여줄 앱 상태
 * - 반환값 : 없음
 */
export function openPracticeResultDialogForState(dom: AppDom, state: AppState): void {
  const summary = getGameScoreSummary(state.gameMode);
  const title = formatResultMetadataText(state.document.score.musicData.musicTitle);
  const artist = formatResultMetadataText(state.document.score.musicData.musicArtist);

  dom.resultTitle.textContent = title;
  dom.resultTitle.title = title;
  dom.resultArtist.textContent = artist;
  dom.resultArtist.title = artist;
  dom.resultMode.textContent = state.practiceJudgeMode === "pro" ? "Pro" : "Standard";
  dom.resultAccuracy.textContent = formatAccuracyPercent(summary.accuracyPercent);
  dom.resultTimingAccuracy.textContent = formatAccuracyPercent(summary.timingAccuracyPercent);
  dom.resultScore.textContent = String(Math.round(summary.score));
  dom.resultPerfectCount.textContent = String(summary.perfectCount);
  dom.resultOkCount.textContent = String(summary.okCount);
  dom.resultBadCount.textContent = String(summary.badCount);
  dom.resultMissCount.textContent = String(summary.missCount);
  dom.resultTimingEarlyCount.textContent = String(summary.timingEarlyCount);
  dom.resultTimingLateCount.textContent = String(summary.timingLateCount);
  dom.resultTimingBadCount.textContent = String(summary.timingBadCount);
  dom.resultTimingMissCount.textContent = String(summary.timingMissCount);
  dom.resultGlissBonusCount.textContent = String(summary.glissBonusCount);
  dom.resultVibBonusCount.textContent = String(summary.vibBonusCount);
  dom.resultTremBonusCount.textContent = String(summary.tremBonusCount);
  dom.resultEffectBonusScore.textContent = `+${Math.round(summary.effectBonusScore)}`;
  dom.resultBestCombo.textContent = String(summary.bestCombo);

  if (!dom.practiceResultDialog.open) {
    dom.practiceResultDialog.showModal();
  }
}

/**
 * result dialog에 넣을 score metadata 문자열을 정리한다.
 * - 인수 : value : ScoreFile musicData 원본 문자열
 * - 반환값 : 빈 값이면 unknown, 아니면 trim된 문자열
 */
function formatResultMetadataText(value: string): string {
  const trimmed = value.trim();

  return trimmed.length === 0 ? "unknown" : trimmed;
}

/**
 * accuracy percent를 소수점 이하 1자리 표시 문자열로 만든다.
 * - 인수 : value : 0 이상 100 기준 accuracy percent
 * - 반환값 : 소수점 1자리 percent 문자열
 */
function formatAccuracyPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "0.0%";
  }

  return `${value.toFixed(1)}%`;
}
