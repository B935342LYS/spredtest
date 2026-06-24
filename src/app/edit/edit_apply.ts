/**
 * edit 결과를 ScoreFile에 적용하는 순수 mutation 경계를 제공한다.
 * parse/analyze/render rebuild는 이 모듈 밖에서 수행한다.
 */

import type {
  RowId,
  ScoreFile,
  TrackId,
} from "../../core/score/types";
import { MAX_CELL_RAW_TEXT_LENGTH } from "../../core/score/score_limits";

/** edit 적용 대상 row 종류. */
export type EditRowKind = "global" | "note" | "gap";

/** score text edit batch가 무효화하는 런타임 산출물 종류. */
export type EditInvalidationKind = "noteCell" | "globalCell" | "mixedCell";

/**
 * score edit 적용 대상 좌표.
 * - 인수 : 없음
 * - 반환값 : track, row, column, row kind를 포함한 좌표
 */
export type ScoreEditSelection = {
  trackId: TrackId;
  rowId: RowId;
  col: number;
  rowKind: EditRowKind;
};

/**
 * ScoreFile edit 적용 결과.
 * - 인수 : 없음
 * - 반환값 : 변경된 ScoreFile 또는 적용 실패 메시지
 */
export type ScoreEditApplyResult =
  | {
      ok: true;
      score: ScoreFile;
      isDelete: boolean;
      updated: number;
    }
  | {
      ok: false;
      level: "warning" | "error";
      message: string;
    };

/**
 * 하나의 score cell에 적용할 rawText 편집 명령.
 * - 인수 : 없음
 * - 반환값 : 편집 좌표와 rawText를 포함한 명령
 */
export type ScoreTextEdit = {
  selection: ScoreEditSelection;
  rawText: string;
};

/**
 * edit batch가 note/global 중 어느 영역을 바꾸는지 분류한다.
 * - 인수 : edits : 적용할 score cell 편집 목록
 * - 반환값 : note/global/mixed invalidation 종류
 */
export function getScoreTextEditInvalidationKind(
  edits: readonly ScoreTextEdit[],
): EditInvalidationKind {
  let hasNote = false;
  let hasGlobal = false;

  // edit 목록을 순회하며 note/global rowKind가 함께 들어왔는지 확인한다.
  for (const edit of edits) {
    if (edit.selection.rowKind === "note") {
      hasNote = true;
    } else if (edit.selection.rowKind === "global") {
      hasGlobal = true;
    }

    if (hasNote && hasGlobal) {
      return "mixedCell";
    }
  }

  if (hasGlobal) {
    return "globalCell";
  }

  return "noteCell";
}

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
 * - 반환값 : 변경된 score 또는 적용 실패 결과
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
 * - 반환값 : 변경된 score 또는 적용 실패 결과
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
 * - 반환값 : 변경된 score 또는 적용 실패 결과
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
  let deletedCount = groupedEdits.deleteCount;

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
  }

  if (groupedEdits.globalEdits.length > 0) {
    applyGlobalCellRawTextBatchToClonedScore(nextScore, groupedEdits.globalEdits);
  }

  return {
    ok: true,
    score: nextScore,
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
 * - 반환값 : 적용 성공 여부
 */
function applyTrackCellRawTextBatchToClonedScore(
  score: ScoreFile,
  trackId: TrackId,
  edits: readonly ScoreTextEdit[],
):
  | {
      ok: true;
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

  const cellsByCoord = new Map(track.cells.map((cell) => [
    createCellCoordKey(cell.rowId, cell.col),
    cell,
  ]));

  // batch 안의 upsert/delete를 Map에 모은 뒤 track별로 한 번만 정렬한다.
  for (const edit of edits) {
    const key = createCellCoordKey(edit.selection.rowId, edit.selection.col);

    if (edit.rawText.trim().length === 0) {
      cellsByCoord.delete(key);
      continue;
    }

    cellsByCoord.set(key, {
      rowId: edit.selection.rowId,
      col: edit.selection.col,
      rawText: edit.rawText,
    });
  }

  // parser/analyzer 순회와 JSON 확인이 안정적이도록 track cell을 col, rowId 순서로 정렬한다.
  track.cells = [...cellsByCoord.values()].sort(
    (left, right) =>
      left.col - right.col || left.rowId.localeCompare(right.rowId),
  );

  return {
    ok: true,
  };
}

/**
 * clone된 ScoreFile의 global cell batch를 upsert/delete한다.
 * - 인수 : score : 이미 clone된 ScoreFile
 * - 인수 : edits : 전역 셀에 적용할 edit 목록
 * - 반환값 : 없음
 */
function applyGlobalCellRawTextBatchToClonedScore(
  score: ScoreFile,
  edits: readonly ScoreTextEdit[],
): void {
  const cellsByCoord = new Map(score.globalLines.cells.map((cell) => [
    createCellCoordKey(cell.rowId, cell.col),
    cell,
  ]));

  // 전역 edit도 좌표 Map에 모아 한 번만 정렬한다.
  for (const edit of edits) {
    const key = createCellCoordKey(edit.selection.rowId, edit.selection.col);

    if (edit.rawText.trim().length === 0) {
      cellsByCoord.delete(key);
      continue;
    }

    cellsByCoord.set(key, {
      rowId: edit.selection.rowId,
      col: edit.selection.col,
      rawText: edit.rawText,
    });
  }

  score.globalLines.cells = [...cellsByCoord.values()].sort(
    (left, right) =>
      left.col - right.col || left.rowId.localeCompare(right.rowId),
  );
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
