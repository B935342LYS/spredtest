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
  const statusText = state.gameMode.kind === "preparing"
    ? state.gameMode.message
    : state.gameMode.kind === "error"
      ? state.gameMode.message
      : formatGameStatus(state);

  dom.gamePanel.dataset.state = state.gameMode.kind;
  dom.gameStatus.textContent = statusText;
  dom.gameStatus.title = statusText;
  dom.gameAccuracy.textContent = formatAccuracyPercent(summary.accuracyPercent);
  dom.gamePerfectCount.textContent = String(summary.perfectCount);
  dom.gameOkCount.textContent = String(summary.okCount);
  dom.gameBadCount.textContent = String(summary.badCount);
  dom.gameMissCount.textContent = String(summary.missCount);
  dom.gameCombo.textContent = String(summary.bestCombo);
  dom.gameScore.textContent = String(Math.round(summary.score));
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
    dom.gameRawFrequency.textContent = "--";
    dom.gameClarity.textContent = "--";
    dom.gameRms.textContent = "--";
    return;
  }

  const micState = frame.isVoiced ? "voiced" : frame.rejectReason ?? "rejected";

  dom.gameMicState.textContent = micState;
  dom.gameRawFrequency.textContent = frame.rawFrequencyHz === null
    ? "--"
    : frame.rawFrequencyHz.toFixed(1);
  dom.gameClarity.textContent = frame.clarity.toFixed(2);
  dom.gameRms.textContent = frame.rms.toFixed(3);
}

/**
 * practice result dialog에 최종 점수 집계를 표시한 뒤 연다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : summary : finished 상태에서 보여줄 점수 집계
 * - 반환값 : 없음
 */
export function openPracticeResultDialog(dom: AppDom, summary: GameScoreSummary): void {
  dom.resultAccuracy.textContent = formatAccuracyPercent(summary.accuracyPercent);
  dom.resultScore.textContent = String(Math.round(summary.score));
  dom.resultPerfectCount.textContent = String(summary.perfectCount);
  dom.resultOkCount.textContent = String(summary.okCount);
  dom.resultBadCount.textContent = String(summary.badCount);
  dom.resultMissCount.textContent = String(summary.missCount);
  dom.resultBestCombo.textContent = String(summary.bestCombo);

  if (!dom.practiceResultDialog.open) {
    dom.practiceResultDialog.showModal();
  }
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
