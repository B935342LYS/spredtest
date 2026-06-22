/**
 * src/core/analyze/analyze_tuplet_event.ts
 * pletHead와 pletExtend 셀을 tuplet group/rest/slot event로 변환한다.
 */

import type {
  NoteRowDefinition,
  RowDefinition,
  RowId,
  TrackId,
} from "../score/types";
import type {
  ParsedCellEntry,
  ParsedPletHeadCell,
  ParsedPletSlotNote,
} from "../parse/types";
import type {
  AnalyzeContext,
  AnalyzedEvent,
  NoteEvent,
  RestEvent,
  SourceCellRef,
  TimeFraction,
  TimeRange,
  TupletExtendGroupEvent,
  TupletMembership,
} from "./types";

/** tuplet slot note를 note/hold 분석 경계에 위임하기 위한 callback. */
export type TupletSlotNoteAnalyzer = (
  headRow: NoteRowDefinition,
  slotNote: ParsedPletSlotNote,
  sourceCell: SourceCellRef,
  time: TimeRange,
  membership: TupletMembership,
) => NoteEvent | "merged" | null;

/**
 * 단일 pletHead entry를 TupletGroupEvent와 slot note/rest 이벤트로 변환한다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : context : score/index/parsed 문맥
 * - 인수 : entry : pletHead 위치가 붙은 parsed cell
 * - 인수 : parsedCell : parser가 확정한 pletHead 셀
 * - 인수 : cellsByCol : 같은 track의 col별 parsed entry map
 * - 인수 : consumedPletExtendCellKeys : 정상 tuplet group에 포함된 extend cell key 집합
 * - 인수 : analyzeSlotNote : slot note를 NoteEvent 또는 hold 병합으로 처리하는 callback
 * - 반환값 : TupletGroupEvent와 slot 이벤트 목록
 */
export function analyzeParsedPletHeadEntry(
  trackId: TrackId,
  context: AnalyzeContext,
  entry: ParsedCellEntry,
  parsedCell: ParsedPletHeadCell,
  cellsByCol: Map<number, ParsedCellEntry[]>,
  consumedPletExtendCellKeys: Set<string>,
  analyzeSlotNote: TupletSlotNoteAnalyzer,
): AnalyzedEvent[] {
  const headRow = asNoteRow(context.indexes.rowById.get(entry.rowId));

  if (headRow === null) {
    return [];
  }

  const groupId = createTupletGroupId(trackId, entry);
  const sourceCell = createSourceCellRef(entry);
  const extendCells = collectPletExtendSourceCells(entry, cellsByCol, consumedPletExtendCellKeys);
  const groupLength = 1 + extendCells.length;
  const groupTime = createIntegerTimeRange(entry.col, entry.col + groupLength);
  const containerRowId = resolveTupletContainerRowId(context, headRow, parsedCell) ?? sourceCell.rowId;
  const slotEvents: Array<NoteEvent | RestEvent> = [];
  const slots = parsedCell.slots.map((slot) => {
    const slotTime = createTupletSlotTimeRange(
      entry.col,
      groupLength,
      parsedCell.divNum,
      slot.slotIndex,
    );
    const slotSource = {
      ...sourceCell,
      slotIndex: slot.slotIndex,
    };
    const membership: TupletMembership = {
      groupId,
      slotIndex: slot.slotIndex,
      divNum: parsedCell.divNum,
    };

    if (slot.isRest || slot.note === null) {
      slotEvents.push(createTupletRestEvent(trackId, slotSource, slotTime, membership));
      return {
        slotIndex: slot.slotIndex,
        parsedKind: "rest" as const,
      };
    }

    const event = analyzeSlotNote(headRow, slot.note, slotSource, slotTime, membership);

    if (event === null) {
      slotEvents.push(createTupletRestEvent(trackId, slotSource, slotTime, membership));
      return {
        slotIndex: slot.slotIndex,
        parsedKind: "invalid" as const,
      };
    }

    if (event !== "merged") {
      slotEvents.push(event);
    }

    return {
      slotIndex: slot.slotIndex,
      parsedKind: "note" as const,
    };
  });

  return [
    ...slotEvents,
    {
      eventKind: "tupletGroup",
      trackId,
      time: groupTime,
      sourceCells: [
        sourceCell,
        ...extendCells,
      ],
      groupId,
      divNum: parsedCell.divNum,
      headCell: sourceCell,
      containerRowId,
      extendCells,
      slots,
    },
  ];
}

/**
 * head에 소비되지 않은 pletExtend 연속 구간을 보조 이벤트로 만든다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : cellsByCol : 같은 track의 col별 parsed entry map
 * - 인수 : consumedPletExtendCellKeys : 정상 tuplet group에 포함된 extend cell key 집합
 * - 반환값 : TupletExtendGroupEvent[] : head가 지워진 extend-only 표시 구간 목록
 */
export function createOrphanTupletExtendGroupEvents(
  trackId: TrackId,
  cellsByCol: Map<number, ParsedCellEntry[]>,
  consumedPletExtendCellKeys: Set<string>,
): TupletExtendGroupEvent[] {
  const extendEntries = collectOrphanPletExtendEntries(cellsByCol, consumedPletExtendCellKeys);
  const events: TupletExtendGroupEvent[] = [];
  let activeRun: ParsedCellEntry[] = [];

  // row와 col이 연속된 /& 묶음을 하나의 삭제 보조 표시 구간으로 만든다.
  for (const entry of extendEntries) {
    const previousEntry = activeRun.at(-1);

    if (
      previousEntry !== undefined &&
      previousEntry.rowId === entry.rowId &&
      previousEntry.col + 1 === entry.col
    ) {
      activeRun.push(entry);
      continue;
    }

    pushOrphanTupletExtendRun(events, trackId, activeRun);
    activeRun = [entry];
  }

  pushOrphanTupletExtendRun(events, trackId, activeRun);

  return events;
}

/**
 * tuplet 점선 컨테이너를 표시할 rowId를 첫 note slot의 @n(midi) 기준으로 찾는다.
 * - 인수 : context : score/index/parsed 문맥
 * - 인수 : headRow : pletHead가 놓인 note row
 * - 인수 : parsedCell : parser가 확정한 pletHead 셀
 * - 반환값 : 첫 note slot 위치 rowId, note slot이 없으면 head rowId
 */
function resolveTupletContainerRowId(
  context: AnalyzeContext,
  headRow: NoteRowDefinition,
  parsedCell: ParsedPletHeadCell,
): RowId | null {
  const placementSlot = parsedCell.slots.find((slot) => slot.note !== null);
  const placementSlotMidi = placementSlot?.note?.position.midiNum;

  if (placementSlotMidi === undefined) {
    return headRow.rowId;
  }

  return context.indexes.noteRowIdByStringMidi.get(
    `${headRow.stringId}|${placementSlotMidi}`,
  ) ?? null;
}

/**
 * pletHead 오른쪽의 연속된 pletExtend source cell 목록을 찾는다.
 * - 인수 : entry : pletHead 위치가 붙은 parsed cell
 * - 인수 : cellsByCol : 같은 track의 col별 parsed entry map
 * - 인수 : consumedPletExtendCellKeys : 정상 tuplet group에 포함된 extend cell key 집합
 * - 반환값 : SourceCellRef[] : head와 같은 row에서 오른쪽으로 연속된 extend cell 목록
 */
function collectPletExtendSourceCells(
  entry: ParsedCellEntry,
  cellsByCol: Map<number, ParsedCellEntry[]>,
  consumedPletExtendCellKeys: Set<string>,
): SourceCellRef[] {
  const extendCells: SourceCellRef[] = [];
  let col = entry.col + 1;

  // head 오른쪽에 같은 row의 /&가 연속되는 동안 tuplet group 길이에 포함한다.
  while (true) {
    const extendEntry = cellsByCol.get(col)?.find((candidate) =>
      candidate.rowId === entry.rowId &&
      candidate.parsedCell.kind === "pletExtend"
    );

    if (extendEntry === undefined) {
      break;
    }

    consumedPletExtendCellKeys.add(createCellKey(extendEntry.rowId, extendEntry.col));
    extendCells.push(createSourceCellRef(extendEntry));
    col += 1;
  }

  return extendCells;
}

/**
 * 정상 tuplet group에 포함되지 않은 pletExtend entry를 정렬해 모은다.
 * - 인수 : cellsByCol : 같은 track의 col별 parsed entry map
 * - 인수 : consumedPletExtendCellKeys : 정상 tuplet group에 포함된 extend cell key 집합
 * - 반환값 : ParsedCellEntry[] : rowId와 col 기준으로 정렬된 orphan extend entry 목록
 */
function collectOrphanPletExtendEntries(
  cellsByCol: Map<number, ParsedCellEntry[]>,
  consumedPletExtendCellKeys: Set<string>,
): ParsedCellEntry[] {
  const entries: ParsedCellEntry[] = [];

  // parsed map을 순회하며 head에 붙지 않은 /&만 후보로 모은다.
  for (const colEntries of cellsByCol.values()) {
    for (const entry of colEntries) {
      if (
        entry.parsedCell.kind === "pletExtend" &&
        !consumedPletExtendCellKeys.has(createCellKey(entry.rowId, entry.col))
      ) {
        entries.push(entry);
      }
    }
  }

  return entries.sort((left, right) => {
    if (left.rowId !== right.rowId) {
      return left.rowId.localeCompare(right.rowId);
    }

    return left.col - right.col;
  });
}

/**
 * pletExtend 연속 구간을 TupletExtendGroupEvent로 변환해 목록에 추가한다.
 * - 인수 : events : 누적할 TupletExtendGroupEvent 목록
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : run : 같은 row에서 col이 연속된 pletExtend entry 목록
 * - 반환값 : 없음
 */
function pushOrphanTupletExtendRun(
  events: TupletExtendGroupEvent[],
  trackId: TrackId,
  run: ParsedCellEntry[],
): void {
  if (run.length === 0) {
    return;
  }

  const firstEntry = run[0];
  const lastEntry = run.at(-1);

  if (firstEntry === undefined || lastEntry === undefined) {
    return;
  }

  const extendCells = run.map((entry) => createSourceCellRef(entry));

  events.push({
    eventKind: "tupletExtendGroup",
    trackId,
    time: createIntegerTimeRange(firstEntry.col, lastEntry.col + 1),
    sourceCells: extendCells,
    groupId: createTupletExtendGroupId(trackId, firstEntry),
    rowId: firstEntry.rowId,
    extendCells,
  });
}

/**
 * tuplet rest slot을 RestEvent로 만든다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : sourceCell : slot source 참조
 * - 인수 : time : rest slot이 차지하는 유리수 tick 범위
 * - 인수 : membership : slot의 tuplet 소속 정보
 * - 반환값 : RestEvent : 시간 점유용 rest event
 */
function createTupletRestEvent(
  trackId: TrackId,
  sourceCell: SourceCellRef,
  time: TimeRange,
  membership: TupletMembership,
): RestEvent {
  return {
    eventKind: "rest",
    trackId,
    time: cloneTimeRange(time),
    sourceCells: [sourceCell],
    display: null,
    tuplet: membership,
  };
}

/**
 * source cell 참조를 만든다.
 * - 인수 : entry : parsed cell entry
 * - 반환값 : SourceCellRef : analyzer event가 참조할 원본 셀 좌표
 */
function createSourceCellRef(entry: ParsedCellEntry): SourceCellRef {
  return {
    rowId: entry.rowId,
    col: entry.col,
  };
}

/**
 * 정수 col 범위를 TimeRange로 만든다.
 * - 인수 : startTick : 시작 tick
 * - 인수 : endTick : 끝 tick
 * - 반환값 : 정수 tick 범위
 */
function createIntegerTimeRange(startTick: number, endTick: number): TimeRange {
  return {
    startTick: integerTick(startTick),
    endTick: integerTick(endTick),
  };
}

/**
 * tuplet group의 slot 하나가 차지하는 유리수 tick 범위를 만든다.
 * - 인수 : startCol : pletHead가 놓인 시작 col
 * - 인수 : groupLength : pletHead와 /&가 합쳐진 전체 col 길이
 * - 인수 : divNum : tuplet slot 분할 수
 * - 인수 : slotIndex : slot index
 * - 반환값 : slot의 시간 범위
 */
function createTupletSlotTimeRange(
  startCol: number,
  groupLength: number,
  divNum: number,
  slotIndex: number,
): TimeRange {
  return {
    startTick: {
      numerator: startCol * divNum + slotIndex * groupLength,
      denominator: divNum,
    },
    endTick: {
      numerator: startCol * divNum + (slotIndex + 1) * groupLength,
      denominator: divNum,
    },
  };
}

/**
 * TimeRange를 얕은 공유 없이 복사한다.
 * - 인수 : time : 복사할 시간 범위
 * - 반환값 : TimeRange : start/end fraction이 복제된 시간 범위
 */
function cloneTimeRange(time: TimeRange): TimeRange {
  return {
    startTick: cloneTimeFraction(time.startTick),
    endTick: cloneTimeFraction(time.endTick),
  };
}

/**
 * TimeFraction을 얕은 공유 없이 복사한다.
 * - 인수 : value : 복사할 시간 분수
 * - 반환값 : TimeFraction : 복제된 시간 분수
 */
function cloneTimeFraction(value: TimeFraction): TimeFraction {
  return {
    numerator: value.numerator,
    denominator: value.denominator,
  };
}

/**
 * number tick을 TimeFraction으로 만든다.
 * - 인수 : tick : 정수 tick
 * - 반환값 : denominator 1의 TimeFraction
 */
function integerTick(tick: number): TimeFraction {
  return {
    numerator: tick,
    denominator: 1,
  };
}

/**
 * tuplet group의 안정적인 group id를 만든다.
 * - 인수 : trackId : 이벤트가 속한 track
 * - 인수 : entry : tuplet head parsed entry
 * - 반환값 : string : tuplet group id
 */
function createTupletGroupId(trackId: TrackId, entry: ParsedCellEntry): string {
  return `${trackId}:tuplet:${entry.rowId}:${entry.col}`;
}

/**
 * orphan pletExtend group의 안정적인 id를 만든다.
 * - 인수 : trackId : 이벤트가 속한 track
 * - 인수 : entry : extend run의 첫 parsed entry
 * - 반환값 : string : tuplet extend group id
 */
function createTupletExtendGroupId(trackId: TrackId, entry: ParsedCellEntry): string {
  return `${trackId}:tuplet-extend:${entry.rowId}:${entry.col}`;
}

/**
 * row/col source cell key를 만든다.
 * - 인수 : rowId : 원본 cell rowId
 * - 인수 : col : 원본 cell col
 * - 반환값 : string : set 조회용 cell key
 */
function createCellKey(rowId: RowId, col: number): string {
  return `${rowId}|${col}`;
}

/**
 * RowDefinition을 note row로 좁힌다.
 * - 인수 : row : rowById에서 얻은 row 후보
 * - 반환값 : note row이면 해당 row, 아니면 null
 */
function asNoteRow(row: RowDefinition | undefined): NoteRowDefinition | null {
  return row?.type === "note" ? row : null;
}
