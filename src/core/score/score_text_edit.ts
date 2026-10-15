/** 앱 입력과 산출물 조율이 공유하는 셀 편집 명령 및 영역 분류 계약이다. */
import type { RowId, TrackId } from "./types";

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
 * 입력 검증은 수행하지 않는다. 빈 목록이나 gap만 있는 목록의 기존 기본값은 noteCell이다.
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

