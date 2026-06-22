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
  }

  const nextScore = cloneScoreFile(score);
  let deletedCount = 0;

  for (const edit of edits) {
    const result = applySingleEditToClonedScore(nextScore, edit.selection, edit.rawText);

    if (!result.ok) {
      return result;
    }

    if (result.isDelete) {
      deletedCount += 1;
    }
  }

  return {
    ok: true,
    score: nextScore,
    isDelete: deletedCount === edits.length,
    updated: edits.length,
  };
}

/**
 * clone된 ScoreFile에 단일 편집을 직접 적용한다.
 * - 인수 : score : 이미 clone된 ScoreFile
 * - 인수 : selection : 편집 좌표
 * - 인수 : rawText : 적용할 rawText
 * - 반환값 : 적용 성공 여부와 삭제 여부
 */
function applySingleEditToClonedScore(
  score: ScoreFile,
  selection: ScoreEditSelection,
  rawText: string,
):
  | {
      ok: true;
      isDelete: boolean;
    }
  | {
      ok: false;
      level: "warning" | "error";
      message: string;
    } {
  if (selection.rowKind !== "note") {
    if (selection.rowKind === "global") {
      return applyGlobalCellRawTextToClonedScore(score, selection, rawText);
    }

    return {
      ok: false,
      level: "warning",
      message: "Only note rows can be edited in this step.",
    };
  }

  return applyNoteCellRawTextToClonedScore(score, selection, rawText);
}

/**
 * clone된 ScoreFile의 active track note cell을 upsert/delete한다.
 * - 인수 : score : 이미 clone된 ScoreFile
 * - 인수 : selection : note cell 좌표
 * - 인수 : rawText : 적용할 note rawText
 * - 반환값 : 적용 성공 여부와 삭제 여부
 */
function applyNoteCellRawTextToClonedScore(
  score: ScoreFile,
  selection: ScoreEditSelection,
  rawText: string,
):
  | {
      ok: true;
      isDelete: boolean;
    }
  | {
      ok: false;
      level: "warning" | "error";
      message: string;
    } {
  const track = score.tracks.find(
    (candidate) => candidate.trackId === selection.trackId,
  );

  if (track === undefined) {
    return {
      ok: false,
      level: "error",
      message: `Track not found: ${selection.trackId}`,
    };
  }

  // 같은 좌표의 기존 cell을 제거한 뒤 입력값이 있으면 새 cell 하나를 넣어 중복 좌표를 방지한다.
  const nextCells = track.cells.filter(
    (cell) => !(cell.rowId === selection.rowId && cell.col === selection.col),
  );
  const isDelete = rawText.trim().length === 0;

  if (!isDelete) {
    nextCells.push({
      rowId: selection.rowId,
      col: selection.col,
      rawText,
    });
  }

  // parser/analyzer 순회와 JSON 확인이 안정적이도록 track cell을 col, rowId 순서로 정렬한다.
  track.cells = nextCells.sort(
    (left, right) =>
      left.col - right.col || left.rowId.localeCompare(right.rowId),
  );

  return {
    ok: true,
    isDelete,
  };
}

/**
 * clone된 ScoreFile의 global cell을 upsert/delete한다.
 * - 인수 : score : 이미 clone된 ScoreFile
 * - 인수 : selection : global cell 좌표
 * - 인수 : rawText : 적용할 global rawText
 * - 반환값 : 적용 성공 여부와 삭제 여부
 */
function applyGlobalCellRawTextToClonedScore(
  score: ScoreFile,
  selection: ScoreEditSelection,
  rawText: string,
): {
  ok: true;
  isDelete: boolean;
} {
  // 같은 좌표의 기존 global cell을 제거한 뒤 입력값이 있으면 새 cell 하나를 넣어 중복 좌표를 방지한다.
  const nextCells = score.globalLines.cells.filter(
    (cell) => !(cell.rowId === selection.rowId && cell.col === selection.col),
  );
  const isDelete = rawText.trim().length === 0;

  if (!isDelete) {
    nextCells.push({
      rowId: selection.rowId,
      col: selection.col,
      rawText,
    });
  }

  // 전역 셀도 col, rowId 순서로 정렬해 parser/analyzer 입력 순서를 안정화한다.
  score.globalLines.cells = nextCells.sort(
    (left, right) =>
      left.col - right.col || left.rowId.localeCompare(right.rowId),
  );

  return {
    ok: true,
    isDelete,
  };
}
