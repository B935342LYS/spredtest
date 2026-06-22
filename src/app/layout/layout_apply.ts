/**
 * 레이아웃 draft를 ScoreFile에 적용하는 순수 mutation 경계를 제공한다.
 * UI 확인창, 저장, runtime rebuild는 이 모듈 밖에서 수행한다.
 */

import { validateScoreFile } from "../../core/score/score_validate";
import type {
  InstrumentData,
  RowDefinition,
  RowId,
  ScoreFile,
  Track,
} from "../../core/score/types";
import type {
  LayoutApplyResult,
  LayoutCellDeletionSummary,
  LayoutDraftBundle,
  LayoutEditableRowDefinition,
} from "./layout_types";

/**
 * 레이아웃 draft 적용 옵션.
 * - 인수 : 없음
 * - 반환값 : 삭제될 track cell이 있을 때 적용을 허용할지 여부
 */
export type LayoutApplyOptions = {
  allowCellDeletion?: boolean;
};

/**
 * draft 적용 시 삭제될 track cell 수를 계산한다.
 * - 인수 : score : 현재 ScoreFile
 * - 인수 : draft : 레이아웃 편집 UI에서 만든 draft
 * - 반환값 : 삭제될 셀의 전체 수와 rowId별 수량
 */
export function calculateLayoutCellDeletionSummary(
  score: ScoreFile,
  draft: LayoutDraftBundle,
): LayoutCellDeletionSummary {
  const nextNoteRowIds = createNoteRowIdSet(draft.rowDefinitions);
  const countByRowId: Record<RowId, number> = {};
  let totalCount = 0;

  // tracks의 모든 cell을 순회하며 draft 적용 후 존재하지 않을 note row 참조를 집계한다.
  for (const track of score.tracks) {
    for (const cell of track.cells) {
      if (nextNoteRowIds.has(cell.rowId)) {
        continue;
      }

      countByRowId[cell.rowId] = (countByRowId[cell.rowId] ?? 0) + 1;
      totalCount += 1;
    }
  }

  return {
    totalCount,
    countByRowId,
  };
}

/**
 * 레이아웃 draft를 ScoreFile의 부분 복사본에 적용한다.
 * - 인수 : score : 현재 ScoreFile
 * - 인수 : draft : 레이아웃 편집 UI에서 만든 draft
 * - 인수 : options : 삭제될 track cell이 있을 때 적용을 허용할지 여부
 * - 반환값 : 적용된 ScoreFile 또는 사용자에게 표시할 실패 메시지
 */
export function applyLayoutDraftToScore(
  score: ScoreFile,
  draft: LayoutDraftBundle,
  options: LayoutApplyOptions = {},
): LayoutApplyResult {
  const deletedCells = calculateLayoutCellDeletionSummary(score, draft);

  if (deletedCells.totalCount > 0 && options.allowCellDeletion !== true) {
    return {
      ok: false,
      level: "warning",
      message: `Layout change would delete ${deletedCells.totalCount} track cell(s).`,
    };
  }

  const nextEditableRows = cloneEditableRows(draft.rowDefinitions);
  const nextNoteRowIds = createNoteRowIdSet(nextEditableRows);
  const nextRowDefinitions = [
    ...cloneGlobalRows(score.layout.rowDefinitions),
    ...nextEditableRows,
  ];
  const nextInstData = cloneInstrumentData(draft.instData);
  const nextTracks = createNextTracks(score.tracks, nextNoteRowIds, deletedCells.totalCount);

  nextInstData.instName = draft.layoutPresetDisplayName;

  // layout apply는 큰 ScoreFile 전체를 deep clone하지 않고, 바뀌는 경계만 새 객체로 교체한다.
  const nextScore: ScoreFile = {
    ...score,
    instData: nextInstData,
    layout: {
      ...score.layout,
      rowDefinitions: nextRowDefinitions,
    },
    tracks: nextTracks,
  };

  const validation = validateScoreFile(nextScore);

  if (!validation.ok) {
    return {
      ok: false,
      level: "error",
      message: `Applied layout failed validation: ${validation.error.message}`,
    };
  }

  return {
    ok: true,
    score: validation.score,
    deletedCells,
  };
}

/**
 * layout 적용 후 유지할 track 배열을 만든다.
 * - 인수 : tracks : 현재 ScoreFile의 track 배열
 * - 인수 : nextNoteRowIds : 적용 후 유효한 note rowId 집합
 * - 인수 : deletedCellCount : 삭제될 cell 전체 수
 * - 반환값 : 삭제가 없으면 기존 tracks, 삭제가 있으면 cell이 필터링된 새 tracks
 */
function createNextTracks(
  tracks: Track[],
  nextNoteRowIds: Set<RowId>,
  deletedCellCount: number,
): Track[] {
  if (deletedCellCount === 0) {
    return tracks;
  }

  // 삭제가 필요한 경우에만 track/cells를 복사하여 원본 ScoreFile을 보존한다.
  return tracks.map((track) => ({
    ...track,
    cells: track.cells.filter((cell) => nextNoteRowIds.has(cell.rowId)),
  }));
}

/**
 * rowDefinitions에서 note rowId 집합을 만든다.
 * - 인수 : rows : draft의 비전역 rowDefinitions
 * - 반환값 : 적용 후 track cell이 참조할 수 있는 note rowId 집합
 */
function createNoteRowIdSet(rows: LayoutEditableRowDefinition[]): Set<RowId> {
  const rowIds = new Set<RowId>();

  // gap row에는 track cell이 붙을 수 없으므로 note row만 유효 참조 대상으로 등록한다.
  for (const row of rows) {
    if (row.type === "note") {
      rowIds.add(row.rowId);
    }
  }

  return rowIds;
}

/**
 * 기존 ScoreFile의 전역 행 정의를 복사한다.
 * - 인수 : rows : 현재 ScoreFile의 전체 rowDefinitions
 * - 반환값 : draft 적용 후에도 유지할 global rowDefinitions
 */
function cloneGlobalRows(rows: RowDefinition[]): RowDefinition[] {
  return rows
    .filter((row) => row.type === "global")
    .map((row) => ({ ...row }));
}

/**
 * draft의 악기 정보를 ScoreFile에 넣을 수 있도록 복사한다.
 * - 인수 : instData : draft의 악기 정보
 * - 반환값 : ScoreFile에 저장할 독립 악기 정보
 */
function cloneInstrumentData(instData: InstrumentData): InstrumentData {
  return {
    ...instData,
    strings: instData.strings.map((string) => ({ ...string })),
  };
}

/**
 * draft의 note/gap 행 정의를 ScoreFile에 넣을 수 있도록 복사한다.
 * - 인수 : rows : draft의 비전역 rowDefinitions
 * - 반환값 : ScoreFile layout에 저장할 note/gap rowDefinitions
 */
function cloneEditableRows(
  rows: LayoutEditableRowDefinition[],
): LayoutEditableRowDefinition[] {
  return rows.map((row) => ({ ...row }));
}
