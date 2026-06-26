/**
 * Ctrl+drag range selection과 bulk delete/copy/paste helper를 제공한다.
 */

import type {
  RowId,
  ScoreFile,
  TrackId,
} from "../../core/score/types";
import type { CanvasScoreLayout } from "../../renderer/canvas_types";
import type {
  ScoreHit,
  ScoreRangeClipboard,
  ScoreRangeSelection,
  ScoreSelection,
} from "../app_types";
import type { ScoreTextEdit } from "./edit_apply";

/** range delete helper 결과. */
export type RangeDeleteEditResult = {
  edits: ScoreTextEdit[];
  protectedGlobalStartCellCount: number;
};

/**
 * anchor/current hit과 현재 layout에서 score range selection을 만든다.
 * - 인수 : layout : renderer가 계산한 현재 row/column 좌표계
 * - 인수 : activeTrackIds : note range 선택 당시의 active track 목록
 * - 인수 : anchorHit : Ctrl+drag 시작 cell hit
 * - 인수 : currentHit : Ctrl+drag 현재 cell hit
 * - 반환값 : 정규화된 range selection 또는 선택 불가 결과
 */
export function createScoreRangeSelection(
  layout: CanvasScoreLayout,
  activeTrackIds: readonly TrackId[],
  anchorHit: ScoreHit,
  currentHit: ScoreHit,
): ScoreRangeSelection | null {
  if (!isSelectableRangeRowKind(anchorHit.rowKind)) {
    return null;
  }

  const rowKind = anchorHit.rowKind;
  const rowIds = collectRangeRowIds(layout, anchorHit.rowId, currentHit.rowId, rowKind);

  if (rowIds.length === 0) {
    return null;
  }

  const startCol = Math.max(0, Math.min(anchorHit.col, currentHit.col));
  const endColExclusive = Math.min(
    layout.columnCount,
    Math.max(anchorHit.col, currentHit.col) + 1,
  );

  if (endColExclusive <= startCol) {
    return null;
  }

  return {
    rowKind,
    startRowId: anchorHit.rowId,
    endRowId: currentHit.rowId,
    rowIds,
    startCol,
    endColExclusive,
    trackIds: rowKind === "note" ? [...activeTrackIds] : [],
  };
}

/**
 * range selection에서 실제 존재하는 cell 삭제 edit 목록을 만든다.
 * - 인수 : score : 현재 ScoreFile
 * - 인수 : selection : 삭제 대상 range selection
 * - 반환값 : 삭제 edit 목록과 보호된 global 시작 cell 수
 */
export function createDeleteEditsForRangeSelection(
  score: ScoreFile,
  selection: ScoreRangeSelection,
): RangeDeleteEditResult {
  const rowIdSet = new Set(selection.rowIds);

  if (selection.rowKind === "global") {
    const protectedGlobalStartCellCount = score.globalLines.cells.filter((cell) =>
      rowIdSet.has(cell.rowId) &&
      cell.col === 0 &&
      cell.col >= selection.startCol &&
      cell.col < selection.endColExclusive
    ).length;
    const edits = score.globalLines.cells
      .filter((cell) =>
        rowIdSet.has(cell.rowId) &&
        cell.col !== 0 &&
        cell.col >= selection.startCol &&
        cell.col < selection.endColExclusive
      )
      .map((cell): ScoreTextEdit => ({
        selection: {
          trackId: "basic",
          rowId: cell.rowId,
          rowKind: "global",
          col: cell.col,
        },
        rawText: "",
      }));

    return {
      edits,
      protectedGlobalStartCellCount,
    };
  }

  const trackIdSet = new Set(selection.trackIds);
  const edits = score.tracks
    .filter((track) => trackIdSet.has(track.trackId))
    .flatMap((track) => track.cells
      .filter((cell) =>
        rowIdSet.has(cell.rowId) &&
        cell.col >= selection.startCol &&
        cell.col < selection.endColExclusive
      )
      .map((cell): ScoreTextEdit => ({
        selection: {
          trackId: track.trackId,
          rowId: cell.rowId,
          rowKind: "note",
          col: cell.col,
        },
        rawText: "",
      })));

  return {
    edits,
    protectedGlobalStartCellCount: 0,
  };
}

/**
 * range selection에 들어 있는 실제 cell을 runtime clipboard 데이터로 복사한다.
 * - 인수 : score : 현재 ScoreFile
 * - 인수 : selection : 복사 대상 range selection
 * - 반환값 : 복사된 clipboard 데이터
 */
export function copyRangeSelectionToClipboard(
  score: ScoreFile,
  selection: ScoreRangeSelection,
): ScoreRangeClipboard {
  const rowOffsetById = createRowOffsetMap(selection.rowIds);

  if (selection.rowKind === "global") {
    return {
      rowKind: "global",
      sourceRowIds: [...selection.rowIds],
      width: selection.endColExclusive - selection.startCol,
      trackIds: [],
      cells: score.globalLines.cells
        .filter((cell) =>
          rowOffsetById.has(cell.rowId) &&
          cell.col >= selection.startCol &&
          cell.col < selection.endColExclusive
        )
        .map((cell) => ({
          rowOffset: rowOffsetById.get(cell.rowId) ?? 0,
          colOffset: cell.col - selection.startCol,
          rawText: cell.rawText,
        })),
    };
  }

  const trackIdSet = new Set(selection.trackIds);

  return {
    rowKind: "note",
    sourceRowIds: [...selection.rowIds],
    width: selection.endColExclusive - selection.startCol,
    trackIds: [...selection.trackIds],
    cells: score.tracks
      .filter((track) => trackIdSet.has(track.trackId))
      .flatMap((track) => track.cells
        .filter((cell) =>
          rowOffsetById.has(cell.rowId) &&
          cell.col >= selection.startCol &&
          cell.col < selection.endColExclusive
        )
        .map((cell) => ({
          rowOffset: rowOffsetById.get(cell.rowId) ?? 0,
          colOffset: cell.col - selection.startCol,
          trackId: track.trackId,
          rawText: cell.rawText,
        }))),
  };
}

/**
 * clipboard 데이터를 anchor 위치에 붙여넣기 위한 edit 목록과 새 range selection을 만든다.
 * - 인수 : score : 현재 ScoreFile
 * - 인수 : layout : 현재 renderer row order
 * - 인수 : clipboard : 내부 range clipboard
 * - 인수 : anchorCol : 붙여넣기 기준 column
 * - 반환값 : 붙여넣기 edit 목록과 붙여넣은 범위 selection
 */
export function createPasteEditsFromClipboard(
  score: ScoreFile,
  layout: CanvasScoreLayout,
  clipboard: ScoreRangeClipboard,
  anchorCol: number,
): {
  edits: ScoreTextEdit[];
  rangeSelection: ScoreRangeSelection | null;
} {
  const rowById = new Map(layout.rows.map((row) => [row.rowId, row]));
  const targetRowIds = clipboard.sourceRowIds.filter((rowId) =>
    rowById.get(rowId)?.kind === clipboard.rowKind
  );
  const targetRowIdSet = new Set(targetRowIds);
  const scoreTrackIds = new Set(score.tracks.map((track) => track.trackId));
  const edits = clipboard.cells.flatMap((cell): ScoreTextEdit[] => {
    const rowId = clipboard.sourceRowIds[cell.rowOffset];
    const col = anchorCol + cell.colOffset;

    if (rowId === undefined || !targetRowIdSet.has(rowId) || col < 0 || col >= layout.columnCount) {
      return [];
    }

    if (clipboard.rowKind === "global") {
      return [{
        selection: {
          trackId: "basic",
          rowId,
          rowKind: "global",
          col,
        },
        rawText: cell.rawText,
      }];
    }

    if (cell.trackId === undefined || !scoreTrackIds.has(cell.trackId)) {
      return [];
    }

    return [{
      selection: {
        trackId: cell.trackId,
        rowId,
        rowKind: "note",
        col,
      },
      rawText: cell.rawText,
    }];
  });

  if (targetRowIds.length === 0 || clipboard.width <= 0) {
    return {
      edits,
      rangeSelection: null,
    };
  }

  const fallbackRowId = targetRowIds[0] ?? clipboard.sourceRowIds[0];

  return {
    edits,
    rangeSelection: {
      rowKind: clipboard.rowKind,
      startRowId: fallbackRowId,
      endRowId: targetRowIds[targetRowIds.length - 1] ?? fallbackRowId,
      rowIds: targetRowIds,
      startCol: anchorCol,
      endColExclusive: Math.min(layout.columnCount, anchorCol + clipboard.width),
      trackIds: clipboard.rowKind === "note" ? [...clipboard.trackIds] : [],
    },
  };
}

/**
 * range selection의 좌상단 anchor를 단일 ScoreSelection으로 변환한다.
 * - 인수 : selection : 기준 range selection
 * - 반환값 : 붙여넣기 anchor로 사용할 단일 selection
 */
export function getRangeTopLeftSelection(selection: ScoreRangeSelection): ScoreSelection {
  return {
    trackId: selection.trackIds[0] ?? "basic",
    rowId: selection.rowIds[0] ?? selection.startRowId,
    rowKind: selection.rowKind,
    col: selection.startCol,
  };
}

/**
 * row kind가 range selection 대상인지 확인한다.
 * - 인수 : rowKind : hit test에서 얻은 row kind
 * - 반환값 : note/global 여부
 */
function isSelectableRangeRowKind(rowKind: ScoreHit["rowKind"]): rowKind is "note" | "global" {
  return rowKind === "note" || rowKind === "global";
}

/**
 * renderer row order에서 anchor/current 사이의 같은 kind rowId 목록을 수집한다.
 * - 인수 : layout : 현재 renderer row order
 * - 인수 : anchorRowId : drag 시작 rowId
 * - 인수 : currentRowId : drag 현재 rowId
 * - 인수 : rowKind : selection으로 유지할 row kind
 * - 반환값 : 같은 rowKind에 해당하는 rowId 목록
 */
function collectRangeRowIds(
  layout: CanvasScoreLayout,
  anchorRowId: RowId,
  currentRowId: RowId,
  rowKind: "note" | "global",
): RowId[] {
  const anchorIndex = layout.rows.findIndex((row) => row.rowId === anchorRowId);
  const currentIndex = layout.rows.findIndex((row) => row.rowId === currentRowId);

  if (anchorIndex < 0 || currentIndex < 0) {
    return [];
  }

  const startIndex = Math.min(anchorIndex, currentIndex);
  const endIndex = Math.max(anchorIndex, currentIndex);

  return layout.rows
    .slice(startIndex, endIndex + 1)
    .filter((row) => row.kind === rowKind)
    .map((row) => row.rowId as RowId);
}

/**
 * rowId별 range 내부 row offset을 만든다.
 * - 인수 : rowIds : range selection rowId 목록
 * - 반환값 : rowId -> rowOffset Map
 */
function createRowOffsetMap(rowIds: readonly RowId[]): Map<RowId, number> {
  return new Map(rowIds.map((rowId, rowOffset) => [rowId, rowOffset]));
}
