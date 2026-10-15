/**
 * edit 결과를 ScoreFile에 적용하는 순수 mutation 경계를 제공한다.
 * parse/analyze/render rebuild는 이 모듈 밖에서 수행한다.
 */

import type {
  RowId,
  ScoreFile,
  ScoreCell,
  TrackId,
} from "../../core/score/types";
import { getScoreTextEditInvalidationKind, type EditRowKind, type ScoreEditSelection, type ScoreTextEdit } from "../../core/score/score_text_edit";
import { MAX_CELL_RAW_TEXT_LENGTH } from "../../core/score/score_limits";

/**
 * ScoreFile edit 적용 결과.
 * - 인수 : 없음
 * - 반환값 : 변경된 ScoreFile 또는 적용 실패 메시지. 성공 시 score가 원본 참조이면 무변경이다.
 */
export type ScoreEditApplyResult =
  | {
      ok: true;
      score: ScoreFile;
      isDelete: boolean;
      /** 실제 변경 수가 아닌 입력 요청 수. 변경 여부는 score의 원본 참조 유지로 판정한다. */
      updated: number;
    }
  | {
      ok: false;
      level: "warning" | "error";
      message: string;
    };

/**
 * ScoreFile JSON 구조를 편집용으로 깊은 복사한다.
 * - 인수 : score : 현재 score JSON
 * - 반환값 : mutation을 적용할 독립 score JSON
 */
export function cloneScoreFile(score: ScoreFile): ScoreFile {
  return JSON.parse(JSON.stringify(score)) as ScoreFile;
}

/**
 * active track의 note cell에 rawText를 upsert하거나 빈 문자열이면 삭제한다.
 * - 인수 : score : 현재 score JSON
 * - 인수 : selection : 사용자가 click한 score 좌표와 track
 * - 인수 : rawText : parser가 읽을 note cell rawText
 * - 반환값 : 변경된 score 또는 적용 실패 결과. 무변경 시 원본 score 참조를 유지한다.
 */
export function applyNoteCellRawText(
  score: ScoreFile,
  selection: ScoreEditSelection,
  rawText: string,
): ScoreEditApplyResult {
  return applyScoreCellRawText(score, selection, rawText);
}

/**
 * note 또는 global cell에 rawText를 upsert하거나 빈 문자열이면 삭제한다.
 * - 인수 : score : 현재 score JSON
 * - 인수 : selection : 사용자가 조작한 score 좌표와 track
 * - 인수 : rawText : parser가 읽을 cell rawText
 * - 반환값 : 변경된 score 또는 적용 실패 결과. 무변경 시 원본 score 참조를 유지한다.
 */
export function applyScoreCellRawText(
  score: ScoreFile,
  selection: ScoreEditSelection,
  rawText: string,
): ScoreEditApplyResult {
  return applyScoreCellRawTextBatch(score, [
    {
      selection,
      rawText,
    },
  ]);
}

/**
 * 여러 note/global cell rawText 편집을 하나의 ScoreFile clone에 모아 적용한다.
 * - 인수 : score : 현재 score JSON
 * - 인수 : edits : 적용할 score cell 편집 목록
 * - 반환값 : 변경된 score 또는 적용 실패 결과. 무변경 시 원본 score 참조를 유지한다.
 */
export function applyScoreCellRawTextBatch(
  score: ScoreFile,
  edits: ScoreTextEdit[],
): ScoreEditApplyResult {
  if (edits.length === 0) {
    return {
      ok: true,
      score,
      isDelete: false,
      updated: 0,
    };
  }

  for (const edit of edits) {
    if (edit.rawText.length > MAX_CELL_RAW_TEXT_LENGTH) {
      return {
        ok: false,
        level: "warning",
        message: `Cell rawText must be ${MAX_CELL_RAW_TEXT_LENGTH} characters or fewer.`,
      };
    }

    if (isProtectedGlobalStartCellDelete(edit)) {
      return {
        ok: false,
        level: "warning",
        message: "Global row column 0 values can be changed but cannot be deleted.",
      };
    }
  }

  const nextScore = cloneScoreFileForTextEdits(score, edits);
  const groupedEdits = groupScoreTextEdits(edits);
  const deletedCount = groupedEdits.deleteCount;
  let changed = false;

  for (const rowKind of groupedEdits.rowKinds) {
    if (rowKind === "gap") {
      return {
        ok: false,
        level: "warning",
        message: "Only note rows can be edited in this step.",
      };
    }
  }

  for (const [trackId, trackEdits] of groupedEdits.noteEditsByTrack) {
    const result = applyTrackCellRawTextBatchToClonedScore(nextScore, trackId, trackEdits);

    if (!result.ok) {
      return result;
    }
    changed ||= result.changed;
  }

  if (groupedEdits.globalEdits.length > 0) {
    const globalChanged = applyGlobalCellRawTextBatchToClonedScore(nextScore, groupedEdits.globalEdits);
    changed ||= globalChanged;
  }

  return {
    ok: true,
    // 최종 셀 값이 같으면 원본 참조로 무변경 계약을 전달한다.
    score: changed ? nextScore : score,
    isDelete: deletedCount === edits.length,
    updated: edits.length,
  };
}

type GroupedScoreTextEdits = {
  rowKinds: Set<EditRowKind>;
  noteEditsByTrack: Map<TrackId, ScoreTextEdit[]>;
  globalEdits: ScoreTextEdit[];
  deleteCount: number;
};

/**
 * 전역 행의 첫 열 값을 삭제하려는 edit인지 확인한다.
 * - 인수 : edit : 적용할 score cell 편집 명령
 * - 반환값 : global row col 0 삭제이면 true
 */
function isProtectedGlobalStartCellDelete(edit: ScoreTextEdit): boolean {
  return edit.selection.rowKind === "global" &&
    edit.selection.col === 0 &&
    edit.rawText.trim().length === 0;
}

/**
 * score text edit batch를 적용 대상별로 묶는다.
 * - 인수 : edits : 적용할 score cell 편집 목록
 * - 반환값 : track/global별로 묶은 edit batch
 */
function groupScoreTextEdits(edits: readonly ScoreTextEdit[]): GroupedScoreTextEdits {
  const rowKinds = new Set<EditRowKind>();
  const noteEditsByTrack = new Map<TrackId, ScoreTextEdit[]>();
  const globalEdits: ScoreTextEdit[] = [];
  let deleteCount = 0;

  // 같은 batch 안의 중복 좌표는 순서대로 적용하되, 마지막 값만 최종 cell에 남긴다.
  for (const edit of edits) {
    rowKinds.add(edit.selection.rowKind);

    if (edit.rawText.trim().length === 0) {
      deleteCount += 1;
    }

    if (edit.selection.rowKind === "note") {
      const trackEdits = noteEditsByTrack.get(edit.selection.trackId) ?? [];

      trackEdits.push(edit);
      noteEditsByTrack.set(edit.selection.trackId, trackEdits);
    } else if (edit.selection.rowKind === "global") {
      globalEdits.push(edit);
    }
  }

  return {
    rowKinds,
    noteEditsByTrack,
    globalEdits,
    deleteCount,
  };
}

/**
 * score text edit 적용에 필요한 ScoreFile 부분만 복제한다.
 * - 인수 : score : 현재 score JSON
 * - 인수 : edits : 적용할 score cell 편집 목록
 * - 반환값 : 편집 대상 track/global cell 배열만 독립 복제한 score JSON
 */
function cloneScoreFileForTextEdits(
  score: ScoreFile,
  edits: readonly ScoreTextEdit[],
): ScoreFile {
  const invalidationKind = getScoreTextEditInvalidationKind(edits);
  const shouldCloneGlobalLines =
    invalidationKind === "globalCell" || invalidationKind === "mixedCell";
  const shouldCloneTracks =
    invalidationKind === "noteCell" || invalidationKind === "mixedCell";
  const editedTrackIds = new Set(
    edits
      .filter((edit) => edit.selection.rowKind === "note")
      .map((edit) => edit.selection.trackId),
  );

  return {
    ...score,
    globalLines: shouldCloneGlobalLines
      ? {
          ...score.globalLines,
          cells: [...score.globalLines.cells],
        }
      : score.globalLines,
    tracks: shouldCloneTracks
      ? score.tracks.map((track) =>
          editedTrackIds.has(track.trackId)
            ? {
                ...track,
                cells: [...track.cells],
              }
            : track
        )
      : score.tracks,
  };
}

/**
 * clone된 ScoreFile의 active track note cell batch를 upsert/delete한다.
 * - 인수 : score : 이미 clone된 ScoreFile
 * - 인수 : trackId : 적용 대상 track id
 * - 인수 : edits : 같은 track에 적용할 note cell edit 목록
 * - 반환값 : 적용 성공 여부와 최종 셀 값의 변경 여부
 */
function applyTrackCellRawTextBatchToClonedScore(
  score: ScoreFile,
  trackId: TrackId,
  edits: readonly ScoreTextEdit[],
):
  | {
      ok: true;
      changed: boolean;
    }
  | {
      ok: false;
      level: "warning" | "error";
      message: string;
    } {
  const track = score.tracks.find(
    (candidate) => candidate.trackId === trackId,
  );

  if (track === undefined) {
    return {
      ok: false,
      level: "error",
      message: `Track not found: ${trackId}`,
    };
  }

  const previousCells = track.cells;
  track.cells = applyCellEdits(previousCells, edits);
  return { ok: true, changed: track.cells !== previousCells };
}

/**
 * clone된 ScoreFile의 global cell batch를 적용하고 실제 변경을 반환한다.
 * - 인수 : score : 이미 clone된 ScoreFile
 * - 인수 : edits : 전역 셀 편집 목록
 * - 반환값 : 최종 셀 값의 변경 여부
 */
function applyGlobalCellRawTextBatchToClonedScore(
  score: ScoreFile,
  edits: readonly ScoreTextEdit[],
): boolean {
  const previousCells = score.globalLines.cells;
  score.globalLines.cells = applyCellEdits(previousCells, edits);
  return score.globalLines.cells !== previousCells;
}

/**
 * 기존 좌표 Map에 최종 요청을 적용하며 실제 변경이 없으면 입력 배열을 유지한다.
 * - 인수 : cells : 편집 전 셀 배열
 * - 인수 : edits : 검증을 통과한 동일 저장 영역의 편집 요청
 * - 반환값 : 변경 시 정렬한 새 배열, 무변경 시 입력 배열
 */
function applyCellEdits(cells: ScoreCell[], edits: readonly ScoreTextEdit[]): ScoreCell[] {
  const cellsByCoord = new Map(cells.map((cell) => [createCellCoordKey(cell.rowId, cell.col), cell]));
  const finalEdits = new Map<string, ScoreTextEdit>();
  // 입력 검증 후에만 중복 좌표를 합쳐 원래 값으로 돌아온 batch도 판정한다.
  for (const edit of edits) {
    finalEdits.set(createCellCoordKey(edit.selection.rowId, edit.selection.col), edit);
  }
  let changed = false;
  for (const [key, edit] of finalEdits) {
    const previous = cellsByCoord.get(key);
    if (edit.rawText.trim().length === 0) {
      changed = cellsByCoord.delete(key) || changed;
    } else if (previous?.rawText !== edit.rawText) {
      changed = true;
      cellsByCoord.set(key, { rowId: edit.selection.rowId, col: edit.selection.col, rawText: edit.rawText });
    }
  }
  if (!changed) return cells;
  // 기존과 같은 col/rowId 순서를 유지하며 실제 변경이 있을 때만 배열을 만든다.
  return [...cellsByCoord.values()].sort((left, right) =>
    left.col - right.col || left.rowId.localeCompare(right.rowId));
}

/**
 * cell 좌표를 Map key로 변환한다.
 * - 인수 : rowId : cell row id
 * - 인수 : col : cell column
 * - 반환값 : rowId와 column을 함께 담은 key
 */
function createCellCoordKey(rowId: RowId, col: number): string {
  return `${rowId}|${col}`;
}
