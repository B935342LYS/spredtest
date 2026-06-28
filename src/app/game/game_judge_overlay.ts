/**
 * 게임 모드 scoring sample 판정 텍스트를 score 영역의 DOM overlay로 표시한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import type { CanvasLayoutRow } from "../../renderer/canvas_types";
import type {
  GameEffectBonusResult,
  GameScoringSampleResult,
} from "./game_types";

const JUDGE_OVERLAY_DURATION_MS = 500;
const JUDGE_OVERLAY_X_OFFSET = 72;
const EFFECT_OVERLAY_X_OFFSET = 148;
const JUDGE_OVERLAY_Y_OFFSET = 12;
const JUDGE_OVERLAY_COMBO_LINE_HEIGHT = 18;
const JUDGE_OVERLAY_LABEL_LINE_HEIGHT = 26;
const JUDGE_OVERLAY_TIMING_LINE_HEIGHT = 14;
const JUDGE_OVERLAY_MIN_Y = 4;

let hideJudgeOverlayTimer: number | null = null;
let hideEffectOverlayTimer: number | null = null;

/**
 * scoring sample 하나를 판정 텍스트 overlay로 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : sample : 새 scoring sample 판정 결과
 * - 인수 : combo : sample 반영 이후 현재 combo
 * - 반환값 : 없음
 */
export function showGameJudgeOverlay(
  dom: AppDom,
  state: AppState,
  sample: GameScoringSampleResult,
  combo: number,
): void {
  removeGameOverlayNode(dom, "main");

  if (state.layout === null) {
    return;
  }

  const pitchMidi = sample.targetMidi + sample.targetCentOffset / 100;
  const targetY = resolvePitchY(state.layout.rows, pitchMidi);

  if (targetY === null) {
    return;
  }

  const label = document.createElement("div");
  const showCombo = sample.label === "Perfect" || sample.label === "Ok";
  const showTiming = sample.timing.kind === "early" ||
    sample.timing.kind === "late" ||
    sample.timing.kind === "bad";
  const labelHeight = JUDGE_OVERLAY_LABEL_LINE_HEIGHT +
    (showCombo ? JUDGE_OVERLAY_COMBO_LINE_HEIGHT : 0) +
    (showTiming ? JUDGE_OVERLAY_TIMING_LINE_HEIGHT : 0);

  label.dataset.overlayKind = "main";
  label.className = `game-judge-text game-judge-text-main game-judge-text-${sample.label.toLowerCase()}`;
  label.style.left = `${dom.scoreArea.scrollLeft + JUDGE_OVERLAY_X_OFFSET}px`;
  label.style.top = `${Math.max(JUDGE_OVERLAY_MIN_Y, targetY - labelHeight - JUDGE_OVERLAY_Y_OFFSET)}px`;

  if (showCombo) {
    const comboLine = document.createElement("div");

    comboLine.className = "game-judge-combo";
    comboLine.textContent = `COMBO ${combo}`;
    label.append(comboLine);
  }

  const resultLine = document.createElement("div");

  resultLine.className = "game-judge-label";
  resultLine.textContent = sample.label;
  label.append(resultLine);

  if (showTiming) {
    const timingLine = document.createElement("div");
    const timingText = sample.timing.kind === "bad"
      ? sample.timing.direction
      : sample.timing.kind;

    timingLine.className = `game-judge-timing game-judge-timing-${timingText}`;
    timingLine.textContent = timingText;
    label.append(timingLine);
  }

  dom.gameJudgeOverlay.append(label);
  scheduleMainJudgeOverlayHide(dom);
}

/**
 * effect bonus 성공 결과를 score 영역의 DOM overlay로 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : bonus : 성공한 effect bonus 결과
 * - 반환값 : 없음
 */
export function showGameEffectBonusOverlay(
  dom: AppDom,
  state: AppState,
  bonus: GameEffectBonusResult,
): void {
  removeGameOverlayNode(dom, "effect");

  if (state.layout === null) {
    return;
  }

  const pitchMidi = bonus.targetMidi + bonus.targetCentOffset / 100;
  const targetY = resolvePitchY(state.layout.rows, pitchMidi);

  if (targetY === null) {
    return;
  }

  const label = document.createElement("div");

  label.dataset.overlayKind = "effect";
  label.className = `game-judge-text game-judge-text-effect game-judge-text-${bonus.kind}`;
  label.style.left = `${dom.scoreArea.scrollLeft + EFFECT_OVERLAY_X_OFFSET}px`;
  label.style.top = `${Math.max(JUDGE_OVERLAY_MIN_Y, targetY - JUDGE_OVERLAY_LABEL_LINE_HEIGHT - JUDGE_OVERLAY_Y_OFFSET)}px`;
  label.textContent = bonus.displayText;

  dom.gameJudgeOverlay.append(label);
  scheduleEffectOverlayHide(dom);
}

/**
 * 남아 있는 판정 텍스트를 즉시 지운다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
export function clearGameJudgeOverlay(dom: AppDom): void {
  if (hideJudgeOverlayTimer !== null) {
    window.clearTimeout(hideJudgeOverlayTimer);
    hideJudgeOverlayTimer = null;
  }

  if (hideEffectOverlayTimer !== null) {
    window.clearTimeout(hideEffectOverlayTimer);
    hideEffectOverlayTimer = null;
  }

  dom.gameJudgeOverlay.replaceChildren();
}

/**
 * 기본 판정 텍스트가 일정 시간 뒤 자동으로 사라지게 예약한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
function scheduleMainJudgeOverlayHide(dom: AppDom): void {
  if (hideJudgeOverlayTimer !== null) {
    window.clearTimeout(hideJudgeOverlayTimer);
  }

  hideJudgeOverlayTimer = window.setTimeout(() => {
    removeGameOverlayNode(dom, "main");
    hideJudgeOverlayTimer = null;
  }, JUDGE_OVERLAY_DURATION_MS);
}

/**
 * 효과 보너스 텍스트가 일정 시간 뒤 자동으로 사라지게 예약한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
function scheduleEffectOverlayHide(dom: AppDom): void {
  if (hideEffectOverlayTimer !== null) {
    window.clearTimeout(hideEffectOverlayTimer);
  }

  hideEffectOverlayTimer = window.setTimeout(() => {
    removeGameOverlayNode(dom, "effect");
    hideEffectOverlayTimer = null;
  }, JUDGE_OVERLAY_DURATION_MS);
}

/**
 * overlay 안에서 지정한 종류의 판정 텍스트만 제거한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : overlayKind : 제거할 overlay node 종류
 * - 반환값 : 없음
 */
function removeGameOverlayNode(
  dom: AppDom,
  overlayKind: "main" | "effect",
): void {
  const existingNode = dom.gameJudgeOverlay.querySelector(`[data-overlay-kind="${overlayKind}"]`);

  existingNode?.remove();
}

/**
 * MIDI pitch를 현재 layout의 y 좌표로 변환한다.
 * - 인수 : rows : 현재 renderer layout row 목록
 * - 인수 : pitchMidi : cent offset을 포함한 실수 MIDI pitch
 * - 반환값 : score stage CSS pixel y 좌표
 */
function resolvePitchY(rows: readonly CanvasLayoutRow[], pitchMidi: number): number | null {
  const noteRows = rows
    .filter((row) => row.kind === "note" && row.midi !== undefined)
    .map((row) => ({
      midi: row.midi ?? 0,
      centerY: row.y + row.height / 2,
    }))
    .sort((a, b) => a.midi - b.midi);

  if (noteRows.length === 0) {
    return null;
  }

  const first = noteRows[0];
  const last = noteRows[noteRows.length - 1];

  if (first === undefined || last === undefined) {
    return null;
  }

  if (pitchMidi <= first.midi) {
    return first.centerY;
  }

  if (pitchMidi >= last.midi) {
    return last.centerY;
  }

  for (let index = 0; index < noteRows.length - 1; index += 1) {
    const lower = noteRows[index];
    const upper = noteRows[index + 1];

    if (lower === undefined || upper === undefined) {
      continue;
    }

    if (lower.midi <= pitchMidi && pitchMidi <= upper.midi) {
      const ratio = (pitchMidi - lower.midi) / Math.max(1e-6, upper.midi - lower.midi);

      return lower.centerY + (upper.centerY - lower.centerY) * ratio;
    }
  }

  return null;
}
