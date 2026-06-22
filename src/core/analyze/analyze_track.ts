/**
 * src/core/analyze/analyze_track.ts
 * track 단위 analyzer event 분석을 조율한다.
 * parsed entry 순회, mute 변환, note/tuplet/gliss 모듈 호출, event 정렬을 처리한다.
 */

import type { NoteRowDefinition, RowDefinition, TrackId } from "../score/types";
import type { ParsedCellEntry, ParsedMuteCell } from "../parse/types";
import type {
  AnalyzeContext,
  AnalyzeTrackEventsFn,
  AnalyzeTrackRange,
  AnalyzedEvent,
  AnalyzedTrackResult,
  MuteEvent,
  SourceCellRef,
  TimeFraction,
  TimeRange,
} from "./types";
import {
  createGlissEvents,
  type GlissAnchor,
  type RowOrderMap,
} from "./analyze_gliss_event";
import {
  analyzeParsedNoteEntry,
  analyzeTupletSlotNote,
  deleteExpiredActiveNotes,
  fractionToNumber,
  type ActiveNoteMap,
} from "./analyze_note_event";
import {
  analyzeParsedPletHeadEntry,
  createOrphanTupletExtendGroupEvents,
} from "./analyze_tuplet_event";

// ============================================================
// Public entry
// ============================================================

/**
 * 한 track 내부의 MVP note/gliss event를 분석한다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : context : score/index/parsed 문맥
 * - 인수 : range : 후속 partial analysis용 범위. 현재 MVP에서는 범위가 없을 때 full 분석한다.
 * - 반환값 : AnalyzedTrackResult : track 내부 note/gliss event 목록
 */
export const analyzeTrackEvents: AnalyzeTrackEventsFn = (
  trackId: TrackId,
  context: AnalyzeContext,
  range?: AnalyzeTrackRange,
): AnalyzedTrackResult => {
  const cellsByCol =
    context.parsed.noteCellsByTrackAndCol.get(trackId) ?? new Map();
  const rowOrderById = createRowOrderMap(context);
  const sortedEntries = getSortedTrackEntries(cellsByCol, rowOrderById, range);
  const events: AnalyzedEvent[] = [];
  const glissAnchors: GlissAnchor[] = [];
  const activeNotesByConnectionKey: ActiveNoteMap = new Map();
  const consumedPletExtendCellKeys = new Set<string>();

  // 정렬된 parsed entry를 차례대로 분석하며 새 NoteEvent를 events 배열에 누적한다.
  for (const entry of sortedEntries) {
    deleteExpiredActiveNotes(activeNotesByConnectionKey, entry.col);

    const event = analyzeParsedEntry(
      trackId,
      context,
      entry,
      cellsByCol,
      activeNotesByConnectionKey,
      glissAnchors,
      consumedPletExtendCellKeys,
    );

    if (event !== null) {
      events.push(...event);
    }
  }

  events.push(
    ...createOrphanTupletExtendGroupEvents(
      trackId,
      cellsByCol,
      consumedPletExtendCellKeys,
    ),
  );
  events.push(...createGlissEvents(trackId, glissAnchors, rowOrderById));

  return {
    trackId,
    events: sortAnalyzedEvents(events),
  };
};

// ============================================================
// Track iteration helpers
// ============================================================

/**
 * track의 parsed cell entry를 col, rowId 순서로 정렬해 반환한다.
 * - 인수 : cellsByCol : col별 parsed cell entry map
 * - 인수 : range : 선택적 분석 범위
 * - 반환값 : ParsedCellEntry[] : 안정적인 분석 순서의 entry 목록
 */
function getSortedTrackEntries(
  cellsByCol: Map<number, ParsedCellEntry[]>,
  rowOrderById: RowOrderMap,
  range?: AnalyzeTrackRange,
): ParsedCellEntry[] {
  const entries: ParsedCellEntry[] = [];

  // col별 Map에 들어 있는 parsed entry들을 하나의 배열로 모은다.
  for (const [col, colEntries] of cellsByCol) {
    if (range !== undefined && (col < range.colStart || col > range.colEnd)) {
      continue;
    }

    entries.push(...colEntries);
  }

  return entries.sort((left, right) => {
    if (left.col !== right.col) {
      return left.col - right.col;
    }

    return compareRowOrder(left.rowId, right.rowId, rowOrderById);
  });
}

/**
 * layout 표시 순서를 rowId 조회 Map으로 만든다.
 * - 인수 : context : score/index/parsed 문맥
 * - 반환값 : RowOrderMap : 위쪽 행일수록 작은 값을 갖는 정렬 Map
 */
function createRowOrderMap(context: AnalyzeContext): RowOrderMap {
  const rowOrderById: RowOrderMap = new Map();

  // renderer와 같은 layout 표시 순서를 analyzer의 동일 col 판정 기준으로 사용한다.
  context.indexes.rowsInDisplayOrder.forEach((row, index) => {
    rowOrderById.set(row.rowId, index);
  });

  return rowOrderById;
}

/**
 * 두 rowId를 layout 표시 순서 기준으로 비교한다.
 * - 인수 : leftRowId : 왼쪽 rowId
 * - 인수 : rightRowId : 오른쪽 rowId
 * - 인수 : rowOrderById : layout 표시 순서 Map
 * - 반환값 : Array.sort에 사용할 비교 결과
 */
function compareRowOrder(
  leftRowId: string,
  rightRowId: string,
  rowOrderById: RowOrderMap,
): number {
  const leftOrder = rowOrderById.get(leftRowId);
  const rightOrder = rowOrderById.get(rightRowId);

  if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  if (leftOrder !== undefined || rightOrder !== undefined) {
    return leftOrder === undefined ? 1 : -1;
  }

  return leftRowId.localeCompare(rightRowId);
}

// ============================================================
// Parsed entry analyzers
// ============================================================

/**
 * 단일 parsed entry를 analyzer event로 변환하거나 기존 이벤트에 hold로 병합한다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : context : score/index/parsed 문맥
 * - 인수 : entry : 문서 위치가 붙은 parsed cell
 * - 인수 : activeNotesByConnectionKey : hold 연결 기준별 마지막 note event map
 * - 인수 : glissAnchors : gliss 연결 후보를 누적할 목록
 * - 반환값 : 새로 생성된 analyzer event 또는 병합/제외 시 null
 */
function analyzeParsedEntry(
  trackId: TrackId,
  context: AnalyzeContext,
  entry: ParsedCellEntry,
  cellsByCol: Map<number, ParsedCellEntry[]>,
  activeNotesByConnectionKey: ActiveNoteMap,
  glissAnchors: GlissAnchor[],
  consumedPletExtendCellKeys: Set<string>,
): AnalyzedEvent[] | null {
  const parsedCell = entry.parsedCell;

  if (parsedCell.kind === "mute") {
    const muteEvent = analyzeParsedMuteEntry(trackId, context, entry, parsedCell);

    return muteEvent === null ? null : [muteEvent];
  }

  if (parsedCell.kind === "pletHead") {
    return analyzeParsedPletHeadEntry(
      trackId,
      context,
      entry,
      parsedCell,
      cellsByCol,
      consumedPletExtendCellKeys,
      (headRow, slotNote, sourceCell, time, membership) =>
        analyzeTupletSlotNote(
          trackId,
          context,
          headRow,
          slotNote,
          sourceCell,
          time,
          membership,
          activeNotesByConnectionKey,
          glissAnchors,
        ),
    );
  }

  if (parsedCell.kind !== "note") {
    return null;
  }

  return analyzeParsedNoteEntry(
    trackId,
    context,
    entry,
    parsedCell,
    activeNotesByConnectionKey,
    glissAnchors,
  );
}

/**
 * 단일 parsed mute entry를 MuteEvent로 변환한다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : context : score/index/parsed 문맥
 * - 인수 : entry : 문서 위치가 붙은 parsed cell
 * - 인수 : parsedCell : parser가 확정한 mute 셀
 * - 반환값 : MuteEvent 또는 note row가 아니면 null
 */
function analyzeParsedMuteEntry(
  trackId: TrackId,
  context: AnalyzeContext,
  entry: ParsedCellEntry,
  parsedCell: ParsedMuteCell,
): MuteEvent | null {
  const row = asNoteRow(context.indexes.rowById.get(entry.rowId));

  if (row === null) {
    return null;
  }

  const sourceCell = createSourceCellRef(entry);

  // mute는 발음 이벤트가 아니므로 표시 위치와 텍스트만 가진 독립 이벤트로 만든다.
  return {
    eventKind: "mute",
    trackId,
    time: createIntegerTimeRange(entry.col, entry.col + 1),
    sourceCells: [sourceCell],
    display: {
      rowId: row.rowId,
      centOffset: 0,
    },
    text: parsedCell.displayText,
  };
}

// ============================================================
// Event sorting helpers
// ============================================================

/**
 * analyzer event를 시간과 종류 기준으로 안정 정렬한다.
 * - 인수 : events : 정렬할 analyzer event 목록
 * - 반환값 : AnalyzedEvent[] : renderer/audio 소비 순서가 안정화된 목록
 */
function sortAnalyzedEvents(events: AnalyzedEvent[]): AnalyzedEvent[] {
  const eventKindOrder = {
    note: 0,
    rest: 0,
    mute: 0,
    gliss: 1,
    tupletGroup: 2,
    tupletExtendGroup: 2,
  } as const;

  return events.sort((left, right) => {
    const leftStart = fractionToNumber(left.time.startTick);
    const rightStart = fractionToNumber(right.time.startTick);

    if (leftStart !== rightStart) {
      return leftStart - rightStart;
    }

    const leftKindOrder = eventKindOrder[left.eventKind];
    const rightKindOrder = eventKindOrder[right.eventKind];

    if (leftKindOrder !== rightKindOrder) {
      return leftKindOrder - rightKindOrder;
    }

    const leftEnd = fractionToNumber(left.time.endTick);
    const rightEnd = fractionToNumber(right.time.endTick);

    if (leftEnd !== rightEnd) {
      return leftEnd - rightEnd;
    }

    return compareSourceCells(left.sourceCells[0], right.sourceCells[0]);
  });
}

/**
 * source cell 좌표를 안정 정렬용으로 비교한다.
 * - 인수 : left : 왼쪽 source cell 후보
 * - 인수 : right : 오른쪽 source cell 후보
 * - 반환값 : Array.sort에 사용할 비교 결과
 */
function compareSourceCells(
  left: SourceCellRef | undefined,
  right: SourceCellRef | undefined,
): number {
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? 1 : -1;
  }
  if (left.col !== right.col) {
    return left.col - right.col;
  }
  return left.rowId.localeCompare(right.rowId);
}

// ============================================================
// Mute helpers
// ============================================================

/**
 * RowDefinition을 note row로 좁힌다.
 * - 인수 : row : rowById에서 조회한 행 후보
 * - 반환값 : NoteRowDefinition | null : note row이면 해당 행, 아니면 null
 */
function asNoteRow(row: RowDefinition | undefined): NoteRowDefinition | null {
  if (row?.type === "note") {
    return row;
  }

  return null;
}

/**
 * ParsedCellEntry에서 SourceCellRef를 만든다.
 * - 인수 : entry : 문서 위치가 붙은 parsed cell
 * - 반환값 : SourceCellRef : analyzer event 원인 셀 참조
 */
function createSourceCellRef(entry: ParsedCellEntry): SourceCellRef {
  return {
    rowId: entry.rowId,
    col: entry.col,
  };
}

// ============================================================
// Time helpers
// ============================================================

/**
 * 정수 tick을 TimeFraction으로 만든다.
 * - 인수 : tick : 정수 tick 값
 * - 반환값 : TimeFraction : denominator 1의 시간 값
 */
function integerTick(tick: number): TimeFraction {
  return {
    numerator: tick,
    denominator: 1,
  };
}

/**
 * 정수 시작/끝 tick으로 TimeRange를 만든다.
 * - 인수 : startTick : 시작 tick
 * - 인수 : endTick : 배타적 끝 tick
 * - 반환값 : TimeRange : denominator 1의 시간 범위
 */
function createIntegerTimeRange(startTick: number, endTick: number): TimeRange {
  return {
    startTick: integerTick(startTick),
    endTick: integerTick(endTick),
  };
}
