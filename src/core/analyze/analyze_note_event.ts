/**
 * src/core/analyze/analyze_note_event.ts
 * 일반 note와 tuplet slot note를 NoteEvent로 변환한다.
 * hold 병합, display/sound 위치, vib/trem effect, gliss anchor 누적을 처리한다.
 */

import type {
  NoteRowDefinition,
  RowDefinition,
  RowId,
  TrackId,
} from "../score/types";
import type {
  ParsedCellEntry,
  ParsedNoteCell,
  ParsedPletSlotNote,
  ParsedTrem,
} from "../parse/types";
import type {
  AnalyzeContext,
  FinalDisplayPosition,
  FinalSoundPitch,
  NoteDisplayTextAnchor,
  NoteEffectSegment,
  NoteEvent,
  SourceCellRef,
  TimeFraction,
  TimeRange,
  TupletMembership,
} from "./types";
import {
  appendGlissAnchorFromValues,
  appendGlissAnchorIfNeeded,
  type GlissAnchor,
} from "./analyze_gliss_event";

/**
 * hold 연결 후보를 조회하기 위한 문자열 key이다.
 */
export type HoldConnectionKey = string;

/**
 * hold 연결 기준별 마지막 NoteEvent를 보관하는 map이다.
 */
export type ActiveNoteMap = Map<HoldConnectionKey, NoteEvent>;

/**
 * 현재 col에서 더 이상 hold 연결 후보가 될 수 없는 active note를 제거한다.
 * - 인수 : activeNotesByConnectionKey : hold 연결 기준별 마지막 note event map
 * - 인수 : col : 현재 분석 중인 cell column
 * - 반환값 : 없음
 */
export function deleteExpiredActiveNotes(
  activeNotesByConnectionKey: ActiveNoteMap,
  col: number,
): void {
  // hold는 바로 왼쪽 tick에 끝난 note에만 연결되므로 endTick이 현재 col보다 작으면 후보가 아니다.
  for (const [connectionKey, event] of activeNotesByConnectionKey) {
    if (fractionToNumber(event.time.endTick) < col) {
      activeNotesByConnectionKey.delete(connectionKey);
    }
  }
}

/**
 * 일반 parsed note entry를 NoteEvent로 변환하거나 기존 이벤트에 hold로 병합한다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : context : score/index/parsed 문맥
 * - 인수 : entry : 문서 위치가 붙은 parsed cell
 * - 인수 : parsedCell : parser가 확정한 note 셀
 * - 인수 : activeNotesByConnectionKey : hold 연결 기준별 마지막 note event map
 * - 인수 : glissAnchors : gliss 연결 후보를 누적할 목록
 * - 반환값 : 새 NoteEvent 목록 또는 병합/제외 시 null
 */
export function analyzeParsedNoteEntry(
  trackId: TrackId,
  context: AnalyzeContext,
  entry: ParsedCellEntry,
  parsedCell: ParsedNoteCell,
  activeNotesByConnectionKey: ActiveNoteMap,
  glissAnchors: GlissAnchor[],
): NoteEvent[] | null {
  const row = asNoteRow(context.indexes.rowById.get(entry.rowId));

  if (row === null) {
    return null;
  }

  const sourceCell = createSourceCellRef(entry);
  const time = createIntegerTimeRange(entry.col, entry.col + 1);
  const display = createDisplayPosition(row, parsedCell);
  const sound = createSoundPitch(row, parsedCell);
  const connectionKey = createHoldConnectionKey(display, sound);

  // 현재 셀이 hold이면 바로 왼쪽에 이어 붙일 수 있는 기존 NoteEvent를 찾는다.
  if (parsedCell.hold !== null) {
    const previousEvent = findConnectablePreviousEvent(
      activeNotesByConnectionKey,
      entry.col,
      connectionKey,
    );

    if (previousEvent !== null) {
      // 연결 가능한 이벤트가 있으면 끝 tick과 source cell 목록을 확장하고 새 이벤트는 만들지 않는다.
      previousEvent.time.endTick = integerTick(entry.col + 1);
      previousEvent.sourceCells.push(sourceCell);
      previousEvent.displayTextAnchors.push(
        createNoteDisplayTextAnchor(sourceCell, time, parsedCell),
      );
      previousEvent.effects.push(
        createEffectSegmentForCell(
          parsedCell,
          time,
          previousEvent,
        ),
      );
      appendGlissAnchorIfNeeded(glissAnchors, previousEvent, sourceCell, time, parsedCell);
      activeNotesByConnectionKey.set(connectionKey, previousEvent);
      return null;
    }
  }

  // hold 병합이 없으면 현재 셀의 rowId와 midi를 사용해 새 NoteEvent를 만든다.
  const event: NoteEvent = {
    eventKind: "note",
    eventId: createNoteEventId(trackId, sourceCell),
    text: parsedCell.displayText,
    displayTextAnchors: [createNoteDisplayTextAnchor(sourceCell, time, parsedCell)],
    trackId,
    time,
    sourceCells: [sourceCell],
    display,
    sound,
    effects: [createEffectSegmentForCell(parsedCell, time, null)],
    glissRole: null,
    glissAnchors: [],
    tuplet: null,
  };

  appendGlissAnchorIfNeeded(glissAnchors, event, sourceCell, time, parsedCell);
  activeNotesByConnectionKey.set(connectionKey, event);
  return [event];
}

/**
 * tuplet slot note를 NoteEvent로 변환하거나 이전 event에 hold로 병합한다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : context : score/index/parsed 문맥
 * - 인수 : headRow : pletHead가 놓인 note row
 * - 인수 : slotNote : parser가 확정한 slot note
 * - 인수 : sourceCell : slot source 참조
 * - 인수 : time : slot이 차지하는 유리수 tick 범위
 * - 인수 : membership : slot의 tuplet 소속 정보
 * - 인수 : activeNotesByConnectionKey : hold 연결 기준별 마지막 note event map
 * - 인수 : glissAnchors : gliss 연결 후보를 누적할 목록
 * - 반환값 : 새 NoteEvent, 병합 결과, 또는 row 매핑 실패 시 null
 */
export function analyzeTupletSlotNote(
  trackId: TrackId,
  context: AnalyzeContext,
  headRow: NoteRowDefinition,
  slotNote: ParsedPletSlotNote,
  sourceCell: SourceCellRef,
  time: TimeRange,
  membership: TupletMembership,
  activeNotesByConnectionKey: ActiveNoteMap,
  glissAnchors: GlissAnchor[],
): NoteEvent | "merged" | null {
  const displayRowId = context.indexes.noteRowIdByStringMidi.get(
    `${headRow.stringId}|${slotNote.position.midiNum}`,
  );

  if (displayRowId === undefined) {
    return null;
  }

  const displayRow = asNoteRow(context.indexes.rowById.get(displayRowId));

  if (displayRow === null) {
    return null;
  }

  const display = createDisplayPositionFromValues(
    displayRow.rowId,
    slotNote.modifiers.microPitch?.centNum ?? 0,
  );
  const sound = createSoundPitchFromValues(
    displayRow.midi,
    slotNote.modifiers.absolutePitch?.midiNum ?? null,
    slotNote.modifiers.microPitch?.centNum ?? 0,
  );
  const connectionKey = createHoldConnectionKey(display, sound);

  if (slotNote.hold !== null) {
    const previousEvent = findConnectablePreviousEventAtTick(
      activeNotesByConnectionKey,
      fractionToNumber(time.startTick),
      connectionKey,
    );

    if (previousEvent !== null) {
      previousEvent.time.endTick = cloneTimeFraction(time.endTick);
      previousEvent.sourceCells.push(sourceCell);
      previousEvent.displayTextAnchors.push(
        createNoteDisplayTextAnchorFromValues(sourceCell, time, slotNote.displayText),
      );
      previousEvent.effects.push(
        createEffectSegmentForValues(
          slotNote.hold,
          slotNote.modifiers.trem ?? null,
          time,
          previousEvent,
        ),
      );
      appendGlissAnchorFromValues(glissAnchors, previousEvent, sourceCell, time, slotNote.modifiers.gliss);
      activeNotesByConnectionKey.set(connectionKey, previousEvent);
      return "merged";
    }
  }

  const event: NoteEvent = {
    eventKind: "note",
    eventId: createTupletNoteEventId(trackId, sourceCell),
    text: slotNote.displayText,
    displayTextAnchors: [createNoteDisplayTextAnchorFromValues(sourceCell, time, slotNote.displayText)],
    trackId,
    time: cloneTimeRange(time),
    sourceCells: [sourceCell],
    display,
    sound,
    effects: [
      createEffectSegmentForValues(slotNote.hold, slotNote.modifiers.trem ?? null, time, null),
    ],
    glissRole: null,
    glissAnchors: [],
    tuplet: membership,
  };

  appendGlissAnchorFromValues(glissAnchors, event, sourceCell, time, slotNote.modifiers.gliss);
  activeNotesByConnectionKey.set(connectionKey, event);
  return event;
}

/**
 * TimeFraction을 MVP 비교용 number로 변환한다.
 * - 인수 : value : 비교할 시간 분수
 * - 반환값 : number : numerator / denominator
 */
export function fractionToNumber(value: TimeFraction): number {
  return value.numerator / value.denominator;
}

/**
 * 바로 왼쪽 tick에 끝나고 표시/발음 위치가 같은 기존 NoteEvent를 찾는다.
 * - 인수 : activeNotesByConnectionKey : hold 연결 기준별 마지막 note event map
 * - 인수 : col : 현재 셀 col
 * - 인수 : connectionKey : 현재 셀의 표시/발음 위치 기준 key
 * - 반환값 : 연결 가능한 이전 NoteEvent 또는 null
 */
function findConnectablePreviousEvent(
  activeNotesByConnectionKey: ActiveNoteMap,
  col: number,
  connectionKey: HoldConnectionKey,
): NoteEvent | null {
  const event = activeNotesByConnectionKey.get(connectionKey);

  // 같은 연결 key의 마지막 note가 현재 col 바로 앞에서 끝났는지 확인한다.
  if (event !== undefined && fractionToNumber(event.time.endTick) === col) {
    return event;
  }

  return null;
}

/**
 * 특정 tick에서 바로 이어지는 기존 NoteEvent를 찾는다.
 * - 인수 : activeNotesByConnectionKey : hold 연결 기준별 마지막 note event map
 * - 인수 : startTick : 현재 slot 또는 cell의 시작 tick
 * - 인수 : connectionKey : 현재 slot 또는 cell의 표시/발음 위치 기준 key
 * - 반환값 : 연결 가능한 이전 NoteEvent 또는 null
 */
function findConnectablePreviousEventAtTick(
  activeNotesByConnectionKey: ActiveNoteMap,
  startTick: number,
  connectionKey: HoldConnectionKey,
): NoteEvent | null {
  const event = activeNotesByConnectionKey.get(connectionKey);

  // tuplet slot은 유리수 tick에서 시작될 수 있으므로 col 대신 number tick 값으로 비교한다.
  if (event !== undefined && fractionToNumber(event.time.endTick) === startTick) {
    return event;
  }

  return null;
}

/**
 * note row에서 MVP 기본 표시 위치를 만든다.
 * - 인수 : row : 현재 셀의 note row definition
 * - 반환값 : FinalDisplayPosition : renderer가 사용할 의미적 표시 위치
 */
function createDisplayPosition(
  row: NoteRowDefinition,
  parsedCell: ParsedNoteCell,
): FinalDisplayPosition {
  return createDisplayPositionFromValues(
    row.rowId,
    parsedCell.modifiers.microPitch?.centNum ?? 0,
  );
}

/**
 * rowId와 cent offset에서 최종 표시 위치를 만든다.
 * - 인수 : rowId : renderer가 배치 기준으로 사용할 note row id
 * - 인수 : centOffset : 표시 위치의 cent 단위 보정
 * - 반환값 : FinalDisplayPosition : renderer가 사용할 의미적 표시 위치
 */
function createDisplayPositionFromValues(
  rowId: RowId,
  centOffset: number,
): FinalDisplayPosition {
  return {
    rowId,
    centOffset,
  };
}

/**
 * note row와 pitch modifier에서 최종 발음 음정을 만든다.
 * - 인수 : row : 현재 셀의 note row definition
 * - 인수 : parsedCell : parser가 확정한 note 셀
 * - 반환값 : FinalSoundPitch : audio generator가 사용할 의미적 발음 음정
 */
function createSoundPitch(
  row: NoteRowDefinition,
  parsedCell: ParsedNoteCell,
): FinalSoundPitch {
  return createSoundPitchFromValues(
    row.midi,
    parsedCell.modifiers.absolutePitch?.midiNum ?? null,
    parsedCell.modifiers.microPitch?.centNum ?? 0,
  );
}

/**
 * row MIDI와 pitch modifier 값에서 최종 발음 음정을 만든다.
 * - 인수 : rowMidi : 표시 row의 기본 MIDI 번호
 * - 인수 : absoluteMidi : 직접 지정된 발음 MIDI 번호. 없으면 null
 * - 인수 : centOffset : 발음 음정의 cent 단위 보정
 * - 반환값 : FinalSoundPitch : audio generator가 사용할 의미적 발음 음정
 */
function createSoundPitchFromValues(
  rowMidi: number,
  absoluteMidi: number | null,
  centOffset: number,
): FinalSoundPitch {
  return {
    midi: absoluteMidi ?? rowMidi,
    centOffset,
  };
}

/**
 * hold 연결 판정에 사용할 표시/발음 위치 key를 만든다.
 * - 인수 : display : 현재 셀의 최종 표시 위치
 * - 인수 : sound : 현재 셀의 최종 발음 음정
 * - 반환값 : HoldConnectionKey : active note map 조회 key
 */
function createHoldConnectionKey(
  display: FinalDisplayPosition,
  sound: FinalSoundPitch,
): HoldConnectionKey {
  // 표시 행/센트와 발음 midi/센트를 하나의 문자열로 묶어 hold 연결 후보를 조회한다.
  return [
    display.rowId,
    display.centOffset,
    sound.midi,
    sound.centOffset,
  ].join("|");
}

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

/**
 * ParsedNoteCell의 displayText를 NoteEvent 내부 표시 anchor로 복사한다.
 * - 인수 : sourceCell : 원본 셀 참조
 * - 인수 : time : 표시 anchor가 차지하는 시간 범위
 * - 인수 : parsedCell : parser가 확정한 note 셀 표시 정보
 * - 반환값 : NoteDisplayTextAnchor : note layer가 시간 위치별로 표시할 텍스트
 */
function createNoteDisplayTextAnchor(
  sourceCell: SourceCellRef,
  time: TimeRange,
  parsedCell: ParsedNoteCell,
): NoteDisplayTextAnchor {
  return createNoteDisplayTextAnchorFromValues(
    sourceCell,
    time,
    parsedCell.displayText,
  );
}

/**
 * 표시 문자열 값을 NoteEvent 내부 표시 anchor로 복사한다.
 * - 인수 : sourceCell : 원본 셀 또는 slot 참조
 * - 인수 : time : 표시 anchor가 차지하는 시간 범위
 * - 인수 : text : renderer가 표시할 문자열
 * - 반환값 : NoteDisplayTextAnchor : note layer가 시간 위치별로 표시할 텍스트
 */
function createNoteDisplayTextAnchorFromValues(
  sourceCell: SourceCellRef,
  time: TimeRange,
  text: string,
): NoteDisplayTextAnchor {
  return {
    source: { ...sourceCell },
    time: cloneTimeRange(time),
    text,
  };
}

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
 * note 전체 구간에 적용되는 기본 effect segment를 만든다.
 * - 인수 : time : note event 시간 범위
 * - 반환값 : vib/trem이 없는 effect segment
 */
function createDefaultEffectSegment(time: TimeRange): NoteEffectSegment {
  return {
    time: cloneTimeRange(time),
    vib: false,
    trem: null,
  };
}

/**
 * 현재 셀에 해당하는 effect segment를 만든다.
 * - 인수 : parsedCell : parser가 확정한 note 셀
 * - 인수 : time : 현재 셀 하나가 차지하는 시간 범위
 * - 인수 : previousEvent : hold로 이어 붙는 이전 NoteEvent, 새 note이면 null
 * - 반환값 : vib/trem 상태가 반영된 effect segment
 */
function createEffectSegmentForCell(
  parsedCell: ParsedNoteCell,
  time: TimeRange,
  previousEvent: NoteEvent | null,
): NoteEffectSegment {
  return createEffectSegmentForValues(
    parsedCell.hold,
    parsedCell.modifiers.trem,
    time,
    previousEvent,
  );
}

/**
 * hold와 trem 값에서 현재 시간 구간의 effect segment를 만든다.
 * - 인수 : hold : 현재 cell 또는 slot의 hold 표식
 * - 인수 : explicitTrem : 현재 cell 또는 slot의 trem modifier
 * - 인수 : time : 현재 구간이 차지하는 시간 범위
 * - 인수 : previousEvent : hold로 이어 붙는 이전 NoteEvent, 새 note이면 null
 * - 반환값 : vib/trem 상태가 반영된 effect segment
 */
function createEffectSegmentForValues(
  hold: ParsedNoteCell["hold"],
  explicitTrem: ParsedTrem | null,
  time: TimeRange,
  previousEvent: NoteEvent | null,
): NoteEffectSegment {
  const vib = hold === "~";

  if (vib) {
    extendVibToHeadSegment(previousEvent);

    return {
      ...createDefaultEffectSegment(time),
      vib: true,
      trem: null,
    };
  }

  const previousTrem = getContinuingTrem(previousEvent);

  return {
    ...createDefaultEffectSegment(time),
    trem: explicitTrem !== null
      ? { division: explicitTrem.divNum }
      : previousTrem,
  };
}

/**
 * 첫 vibrato hold가 note 머리 바로 다음에 올 때 머리 segment도 vib로 편입한다.
 * - 인수 : previousEvent : hold로 이어 붙는 이전 NoteEvent
 * - 반환값 : 없음
 */
function extendVibToHeadSegment(previousEvent: NoteEvent | null): void {
  if (previousEvent === null || previousEvent.effects.length !== 1) {
    return;
  }

  const headSegment = previousEvent.effects[0];

  if (headSegment === undefined || headSegment.vib) {
    return;
  }

  headSegment.vib = true;
  headSegment.trem = null;
}

/**
 * hold로 이어지는 이전 note에서 지속 가능한 trem 상태를 가져온다.
 * - 인수 : previousEvent : hold 연결 대상 이벤트
 * - 반환값 : 이어질 trem 정보, 없으면 null
 */
function getContinuingTrem(
  previousEvent: NoteEvent | null,
): NoteEffectSegment["trem"] {
  if (previousEvent === null) {
    return null;
  }

  const previousSegment = previousEvent.effects.at(-1);

  // vib가 시작된 뒤에는 trem이 끊긴 것으로 보고, 새 @t가 나올 때만 다시 시작한다.
  if (previousSegment === undefined || previousSegment.vib) {
    return null;
  }

  return previousSegment.trem ?? null;
}

/**
 * 첫 source cell 기준으로 안정적인 note event id를 만든다.
 * - 인수 : trackId : 이벤트가 속한 track
 * - 인수 : sourceCell : 이벤트 시작 원인 셀
 * - 반환값 : string : MVP note event id
 */
function createNoteEventId(trackId: TrackId, sourceCell: SourceCellRef): string {
  return `${trackId}:note:${sourceCell.rowId}:${sourceCell.col}`;
}

/**
 * tuplet slot note의 안정적인 event id를 만든다.
 * - 인수 : trackId : 이벤트가 속한 track
 * - 인수 : sourceCell : slot source 참조
 * - 반환값 : string : MVP tuplet note event id
 */
function createTupletNoteEventId(trackId: TrackId, sourceCell: SourceCellRef): string {
  return `${trackId}:note:${sourceCell.rowId}:${sourceCell.col}:slot:${sourceCell.slotIndex ?? 0}`;
}
