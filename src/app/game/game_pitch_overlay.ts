/**
 * 게임 모드 pitch frame을 score 영역의 DOM overlay로 표시한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import type { CanvasLayoutRow } from "../../renderer/canvas_types";

/**
 * 현재 game mode pitch frame을 score canvas 위 초록색 dot으로 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncGamePitchOverlay(dom: AppDom, state: AppState): void {
  dom.gamePitchOverlay.replaceChildren();

  const frame = getVisiblePitchFrame(state);

  if (
    frame === null ||
    !frame.isVoiced ||
    frame.midi === null ||
    frame.centOffset === null ||
    state.layout === null
  ) {
    return;
  }

  const displayPitchMidi = frame.midi + frame.centOffset / 100;
  const y = resolvePitchY(state.layout.rows, displayPitchMidi);

  if (y === null) {
    return;
  }

  const dot = document.createElement("div");

  dot.className = "game-pitch-dot";
  dot.style.left = `${dom.scoreArea.scrollLeft}px`;
  dot.style.top = `${y}px`;
  dot.title = `${frame.frequencyHz?.toFixed(1) ?? "--"} Hz`;
  dom.gamePitchOverlay.append(dot);
}

/**
 * 현재 game mode 상태에서 화면에 표시할 pitch frame을 꺼낸다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 표시 가능한 pitch frame 또는 null
 */
function getVisiblePitchFrame(state: AppState) {
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
