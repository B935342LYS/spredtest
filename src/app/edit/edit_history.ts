/**
 * score cell rawText edit을 undo/redo 가능한 patch history로 변환한다.
 */

import type { ScoreFile } from "../../core/score/types";
import type {
  CellHistoryPatch,
  UndoHistoryEntry,
  UndoHistoryState,
} from "../app_types";
import type {
  ScoreEditSelection,
  ScoreTextEdit,
} from "./edit_apply";

/** undo history stack에 보관할 기본 entry 수. */
export const DEFAULT_UNDO_HISTORY_MAX_ENTRIES = 50;

/**
 * score edit batch의 적용 전후 rawText 차이를 history patch로 만든다.
 * - 인수 : beforeScore : edit 적용 전 score JSON
 * - 인수 : afterScore : edit 적용 후 score JSON
 * - 인수 : edits : 적용을 시도한 score cell edit 목록
 * - 반환값 : 실제 rawText가 바뀐 cell patch 목록
 */
export function buildCellHistoryPatches(
  beforeScore: ScoreFile,
  afterScore: ScoreFile,
  edits: readonly ScoreTextEdit[],
): CellHistoryPatch[] {
  const targets = new Map<string, ScoreEditSelection>();

  // 같은 batch 안에서 같은 cell이 여러 번 나오면 최종 좌표 1개만 history 대상으로 남긴다.
  for (const edit of edits) {
    targets.set(createHistorySelectionKey(edit.selection), edit.selection);
  }

  const patches: CellHistoryPatch[] = [];

  for (const selection of targets.values()) {
    const beforeRawText = readCellRawText(beforeScore, selection);
    const afterRawText = readCellRawText(afterScore, selection);

    if (beforeRawText === afterRawText) {
      continue;
    }

    patches.push({
      selection,
      beforeRawText,
      afterRawText,
    });
  }

  return patches;
}

/**
 * 빈 undo/redo history 상태를 만든다.
 * - 인수 : maxEntries : 보관할 최대 undo entry 수
 * - 반환값 : 초기화된 history 상태
 */
export function createUndoHistoryState(
  maxEntries = DEFAULT_UNDO_HISTORY_MAX_ENTRIES,
): UndoHistoryState {
  return {
    undoStack: [],
    redoStack: [],
    maxEntries,
  };
}

/**
 * undo stack에 새 entry를 추가하고 redo stack을 비운다.
 * - 인수 : history : 기존 undo/redo history 상태
 * - 인수 : entry : 추가할 history entry
 * - 반환값 : 새 mutation 이후의 history 상태
 */
export function pushUndoHistoryEntry(
  history: UndoHistoryState,
  entry: UndoHistoryEntry,
): UndoHistoryState {
  if (entry.patches.length === 0) {
    return history;
  }

  const undoStack = [...history.undoStack, entry];
  const overflow = undoStack.length - history.maxEntries;

  return {
    ...history,
    undoStack: overflow > 0 ? undoStack.slice(overflow) : undoStack,
    redoStack: [],
  };
}

/**
 * undo stack에서 가장 최근 entry를 꺼내 redo stack으로 옮긴다.
 * - 인수 : history : 기존 undo/redo history 상태
 * - 반환값 : 적용할 entry와 stack 이동이 반영된 history 상태
 */
export function popUndoHistoryEntry(
  history: UndoHistoryState,
): { entry: UndoHistoryEntry | null; history: UndoHistoryState } {
  const entry = history.undoStack.at(-1) ?? null;

  if (entry === null) {
    return {
      entry,
      history,
    };
  }

  return {
    entry,
    history: {
      ...history,
      undoStack: history.undoStack.slice(0, -1),
      redoStack: [...history.redoStack, entry],
    },
  };
}

/**
 * redo stack에서 가장 최근 entry를 꺼내 undo stack으로 되돌린다.
 * - 인수 : history : 기존 undo/redo history 상태
 * - 반환값 : 적용할 entry와 stack 이동이 반영된 history 상태
 */
export function popRedoHistoryEntry(
  history: UndoHistoryState,
): { entry: UndoHistoryEntry | null; history: UndoHistoryState } {
  const entry = history.redoStack.at(-1) ?? null;

  if (entry === null) {
    return {
      entry,
      history,
    };
  }

  return {
    entry,
    history: {
      ...history,
      undoStack: [...history.undoStack, entry],
      redoStack: history.redoStack.slice(0, -1),
    },
  };
}

/**
 * history patch를 기존 score text edit batch 경로에 넣을 명령으로 변환한다.
 * - 인수 : patches : undo/redo 적용 대상 patch 목록
 * - 인수 : side : before는 undo, after는 redo 적용값
 * - 반환값 : rawText edit batch
 */
export function createScoreTextEditsFromHistoryPatches(
  patches: readonly CellHistoryPatch[],
  side: "before" | "after",
): ScoreTextEdit[] {
  return patches.map((patch) => ({
    selection: patch.selection,
    rawText: (side === "before" ? patch.beforeRawText : patch.afterRawText) ?? "",
  }));
}

/**
 * history entry id를 만든다.
 * - 인수 : prefix : id 앞에 붙일 짧은 구분자
 * - 반환값 : 세션 내 식별용 문자열
 */
export function createUndoHistoryEntryId(prefix = "edit"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * score에서 edit selection에 해당하는 cell rawText를 찾는다.
 * - 인수 : score : 조회할 score JSON
 * - 인수 : selection : 조회할 score cell 좌표
 * - 반환값 : 존재하는 rawText 또는 cell 없음
 */
function readCellRawText(
  score: ScoreFile,
  selection: ScoreEditSelection,
): string | null {
  if (selection.rowKind === "global") {
    return score.globalLines.cells.find((cell) =>
      cell.rowId === selection.rowId && cell.col === selection.col
    )?.rawText ?? null;
  }

  if (selection.rowKind !== "note") {
    return null;
  }

  return score.tracks
    .find((track) => track.trackId === selection.trackId)
    ?.cells.find((cell) =>
      cell.rowId === selection.rowId && cell.col === selection.col
    )?.rawText ?? null;
}

/**
 * history patch 병합에 사용할 score cell 좌표 key를 만든다.
 * - 인수 : selection : score edit 좌표
 * - 반환값 : row kind, track, row, column을 포함한 key
 */
function createHistorySelectionKey(selection: ScoreEditSelection): string {
  const trackKey = selection.rowKind === "global" ? "global" : selection.trackId;

  return `${selection.rowKind}|${trackKey}|${selection.rowId}|${selection.col}`;
}
