/**
 * 레이아웃 편집 UI가 사용하는 draft, apply 결과 타입을 정의한다.
 */

import type {
  InstrumentData,
  NoteRowDefinition,
  GapRowDefinition,
  RowId,
  ScoreFile,
  StringId,
} from "../../core/score/types";

/** 레이아웃 편집 팝업에서 다루는 비전역 행 타입. */
export type LayoutEditableRowDefinition =
  | NoteRowDefinition
  | GapRowDefinition;

/**
 * 레이아웃 편집 팝업의 현재 draft 묶음.
 * - 인수 : 없음
 * - 반환값 : 편집 중인 악기 정보와 비전역 rowDefinitions, 선택 상태
 */
export type LayoutDraftBundle = {
  layoutPresetDisplayName: string;
  instData: InstrumentData;
  rowDefinitions: LayoutEditableRowDefinition[];
  selectedStringId: StringId | null;
  selectedRowId: RowId | null;
};

/**
 * 레이아웃 적용 전 삭제될 track cell 요약.
 * - 인수 : 없음
 * - 반환값 : rowId별 삭제 cell 수와 전체 삭제 cell 수
 */
export type LayoutCellDeletionSummary = {
  totalCount: number;
  countByRowId: Record<RowId, number>;
};

/**
 * 레이아웃 draft를 ScoreFile에 적용한 결과.
 * - 인수 : 없음
 * - 반환값 : 적용된 ScoreFile 또는 사용자에게 표시할 실패 메시지
 */
export type LayoutApplyResult =
  | {
      ok: true;
      score: ScoreFile;
      deletedCells: LayoutCellDeletionSummary;
    }
  | {
      ok: false;
      level: "warning" | "error";
      message: string;
    };
