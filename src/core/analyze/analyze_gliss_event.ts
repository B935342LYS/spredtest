/**
 * src/core/analyze/analyze_gliss_event.ts
 * note 분석 중 수집한 gliss anchor를 NoteEvent와 GlissEvent에 반영한다.
 */

import type {
  ParsedGliss,
  ParsedNoteCell,
} from "../parse/types";
import type { TrackId } from "../score/types";
import type {
  GlissEvent,
  NoteEvent,
  SourceCellRef,
  TimeFraction,
  TimeRange,
} from "./types";

/** layout rowId 표시 순서를 담은 정렬 lookup. */
export type RowOrderMap = Map<string, number>;

/** note event 위에 붙은 gliss S/M/E anchor 정보. */
export type GlissAnchor = {
  glissId: string;
  role: "start" | "mid" | "end";
  event: NoteEvent;
  source: SourceCellRef;
  time: TimeRange;
};

/**
 * parsed note의 gliss modifier를 NoteEvent와 별도 anchor 목록에 반영한다.
 * - 인수 : glissAnchors : gliss 연결 후보 누적 목록
 * - 인수 : event : modifier가 붙은 note가 속한 NoteEvent
 * - 인수 : sourceCell : modifier가 붙은 원본 셀
 * - 인수 : time : modifier가 붙은 원본 셀의 시간 범위
 * - 인수 : parsedCell : parser가 확정한 note 셀
 * - 반환값 : 없음
 */
export function appendGlissAnchorIfNeeded(
  glissAnchors: GlissAnchor[],
  event: NoteEvent,
  sourceCell: SourceCellRef,
  time: TimeRange,
  parsedCell: ParsedNoteCell,
): void {
  const gliss = parsedCell.modifiers.gliss;

  if (gliss === null) {
    return;
  }

  appendGlissAnchorFromValues(glissAnchors, event, sourceCell, time, gliss);
}

/**
 * parsed gliss 값을 NoteEvent와 별도 anchor 목록에 반영한다.
 * - 인수 : glissAnchors : gliss 연결 후보 누적 목록
 * - 인수 : event : modifier가 붙은 note가 속한 NoteEvent
 * - 인수 : sourceCell : modifier가 붙은 원본 셀 또는 slot 참조
 * - 인수 : time : modifier가 붙은 원본 셀 또는 slot의 시간 범위
 * - 인수 : gliss : parser가 확정한 gliss modifier
 * - 반환값 : 없음
 */
export function appendGlissAnchorFromValues(
  glissAnchors: GlissAnchor[],
  event: NoteEvent,
  sourceCell: SourceCellRef,
  time: TimeRange,
  gliss: ParsedGliss | null,
): void {
  if (gliss === null) {
    return;
  }

  const role = toGlissAnchorRole(gliss.glissKind);

  event.glissRole = {
    glissId: gliss.id,
    role,
  };
  event.glissAnchors.push({
    glissId: gliss.id,
    role,
    source: { ...sourceCell },
    time: cloneTimeRange(time),
    display: { ...event.display },
  });
  glissAnchors.push({
    glissId: gliss.id,
    role,
    event,
    source: { ...sourceCell },
    time: cloneTimeRange(time),
  });
}

/**
 * gliss anchor 목록에서 인접 anchor 쌍별 GlissEvent를 만든다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : anchors : note 분석 중 수집한 gliss anchor 목록
 * - 인수 : rowOrderById : layout rowId 표시 순서 lookup
 * - 반환값 : GlissEvent[] : renderer/audio가 소비할 gliss segment 목록
 */
export function createGlissEvents(
  trackId: TrackId,
  anchors: GlissAnchor[],
  rowOrderById: RowOrderMap,
): GlissEvent[] {
  const glissEvents: GlissEvent[] = [];
  const lastConnectableAnchorById = new Map<string, GlissAnchor>();
  const sortedAnchors = filterDuplicateGlissAnchors(
    [...anchors].sort((left, right) => compareGlissAnchors(left, right, rowOrderById)),
  );

  // 같은 glissId 안에서 S 또는 M 뒤에 오는 M/E만 segment로 연결한다.
  for (const anchor of sortedAnchors) {
    if (anchor.role === "start") {
      lastConnectableAnchorById.set(anchor.glissId, anchor);
      continue;
    }

    const previousAnchor = lastConnectableAnchorById.get(anchor.glissId);

    if (previousAnchor !== undefined) {
      glissEvents.push(createGlissEvent(trackId, previousAnchor, anchor));
    }

    if (anchor.role === "mid") {
      lastConnectableAnchorById.set(anchor.glissId, anchor);
    } else {
      lastConnectableAnchorById.delete(anchor.glissId);
    }
  }

  return glissEvents;
}

/**
 * parser의 S/M/E gliss kind를 analyzer anchor role로 변환한다.
 * - 인수 : glissKind : parser가 읽은 gliss kind
 * - 반환값 : NoteEvent와 GlissEvent에 기록할 anchor role
 */
function toGlissAnchorRole(glissKind: "S" | "M" | "E"): GlissAnchor["role"] {
  if (glissKind === "S") {
    return "start";
  }

  if (glissKind === "M") {
    return "mid";
  }

  return "end";
}

/**
 * 두 gliss anchor에서 하나의 GlissEvent를 만든다.
 * - 인수 : trackId : 분석 대상 track
 * - 인수 : startAnchor : segment 시작 anchor
 * - 인수 : endAnchor : segment 종료 anchor
 * - 반환값 : GlissEvent : 두 anchor 사이의 gliss segment
 */
function createGlissEvent(
  trackId: TrackId,
  startAnchor: GlissAnchor,
  endAnchor: GlissAnchor,
): GlissEvent {
  return {
    eventKind: "gliss",
    eventId: createGlissEventId(trackId, startAnchor),
    trackId,
    time: {
      startTick: cloneTimeFraction(startAnchor.time.startTick),
      endTick: cloneTimeFraction(endAnchor.time.endTick),
    },
    sourceCells: [
      { ...startAnchor.source },
      { ...endAnchor.source },
    ],
    startDisplay: { ...startAnchor.event.display },
    endDisplay: { ...endAnchor.event.display },
    startSound: { ...startAnchor.event.sound },
    endSound: { ...endAnchor.event.sound },
    glissId: startAnchor.glissId,
    startAnchorTick: createGlissAnchorTick(startAnchor),
    endAnchorTick: createGlissAnchorTick(endAnchor),
    fromKind: toGlissFromKind(startAnchor),
    toKind: endAnchor.role === "mid" ? "mid" : "end",
    startAttach: isAnchorInsideMergedEvent(startAnchor) ? "legato" : "attack",
    endAttach: isAnchorBeforeMergedEventEnd(endAnchor) ? "holdContinue" : "release",
  };
}

/**
 * gliss anchor의 시각 기준 tick을 만든다.
 * - 인수 : anchor : gliss anchor 정보
 * - 반환값 : tuplet slot anchor는 slot 시작 tick, 일반 cell anchor는 cell 중심 tick
 */
function createGlissAnchorTick(anchor: GlissAnchor): TimeFraction {
  if (anchor.source.slotIndex !== undefined) {
    if (fractionToNumber(anchor.time.endTick) - fractionToNumber(anchor.time.startTick) < 1) {
      return createTimeRangeCenterTick(anchor.time);
    }

    return addHalfTick(anchor.time.startTick);
  }

  return createTimeRangeCenterTick(anchor.time);
}

/**
 * gliss segment 시작 anchor role을 GlissEvent.fromKind 타입으로 좁힌다.
 * - 인수 : anchor : segment 시작 anchor
 * - 반환값 : GlissEvent.fromKind에 허용되는 start 또는 mid
 */
function toGlissFromKind(anchor: GlissAnchor): GlissEvent["fromKind"] {
  return anchor.role === "mid" ? "mid" : "start";
}

/**
 * gliss anchor 정렬 순서를 만든다.
 * - 인수 : left : 왼쪽 비교 대상
 * - 인수 : right : 오른쪽 비교 대상
 * - 인수 : rowOrderById : layout rowId 표시 순서 lookup
 * - 반환값 : Array.sort에 사용할 비교 결과
 */
function compareGlissAnchors(
  left: GlissAnchor,
  right: GlissAnchor,
  rowOrderById: RowOrderMap,
): number {
  const leftTick = fractionToNumber(left.time.startTick);
  const rightTick = fractionToNumber(right.time.startTick);

  if (leftTick !== rightTick) {
    return leftTick - rightTick;
  }
  if (left.source.col !== right.source.col) {
    return left.source.col - right.source.col;
  }
  return compareRowOrder(left.source.rowId, right.source.rowId, rowOrderById);
}

/**
 * 동일 col에 같은 glissId와 role의 anchor가 여러 개 있으면 위쪽 하나만 남긴다.
 * - 인수 : anchors : 시간과 표시 행 순서로 정렬된 gliss anchor 목록
 * - 반환값 : GlissAnchor[] : 동일 col/id/role 중복이 제거된 anchor 목록
 */
function filterDuplicateGlissAnchors(anchors: GlissAnchor[]): GlissAnchor[] {
  const filteredAnchors: GlissAnchor[] = [];
  const seenAnchorKey = new Set<string>();

  // 동일 열의 같은 id/role anchor는 수직 gliss segment를 만들 수 없으므로 첫 anchor만 유지한다.
  for (const anchor of anchors) {
    const key = createGlissAnchorUniquenessKey(anchor);

    if (seenAnchorKey.has(key)) {
      continue;
    }

    seenAnchorKey.add(key);
    filteredAnchors.push(anchor);
  }

  return filteredAnchors;
}

/**
 * 중복 gliss anchor 판정에 사용할 key를 만든다.
 * - 인수 : anchor : 중복 판정 대상 gliss anchor
 * - 반환값 : string : 같은 id/role/col/slotIndex를 묶는 key
 */
function createGlissAnchorUniquenessKey(anchor: GlissAnchor): string {
  return [
    anchor.glissId,
    anchor.role,
    anchor.source.col,
    anchor.source.slotIndex ?? "",
  ].join("|");
}

/**
 * GlissEvent의 안정적인 eventId를 만든다.
 * - 인수 : trackId : 이벤트가 속한 track
 * - 인수 : startAnchor : gliss segment 시작 anchor
 * - 반환값 : string : gliss event id
 */
function createGlissEventId(trackId: TrackId, startAnchor: GlissAnchor): string {
  const baseId = `${trackId}:gliss:${startAnchor.glissId}:${startAnchor.source.rowId}:${startAnchor.source.col}`;

  if (startAnchor.source.slotIndex === undefined) {
    return baseId;
  }

  return `${baseId}:slot:${startAnchor.source.slotIndex}`;
}

/**
 * anchor가 병합된 note event의 시작보다 뒤에 있는지 확인한다.
 * - 인수 : anchor : gliss anchor 정보
 * - 반환값 : boolean : 앞선 hold 위에서 시작된 gliss 여부
 */
function isAnchorInsideMergedEvent(anchor: GlissAnchor): boolean {
  return fractionToNumber(anchor.event.time.startTick) < fractionToNumber(anchor.time.startTick);
}

/**
 * anchor가 병합된 note event의 끝보다 앞에 있는지 확인한다.
 * - 인수 : anchor : gliss anchor 정보
 * - 반환값 : boolean : gliss 종착 뒤로 hold가 계속되는지 여부
 */
function isAnchorBeforeMergedEventEnd(anchor: GlissAnchor): boolean {
  return fractionToNumber(anchor.time.endTick) < fractionToNumber(anchor.event.time.endTick);
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
 * TimeRange의 중심 tick을 TimeFraction으로 만든다.
 * - 인수 : time : 중심 tick을 계산할 시간 범위
 * - 반환값 : TimeFraction : start/end의 산술 중심 tick
 */
function createTimeRangeCenterTick(time: TimeRange): TimeFraction {
  const startDenominator = time.startTick.denominator;
  const endDenominator = time.endTick.denominator;

  return {
    numerator:
      time.startTick.numerator * endDenominator +
      time.endTick.numerator * startDenominator,
    denominator: startDenominator * endDenominator * 2,
  };
}

/**
 * TimeFraction에 0.5 tick을 더한다.
 * - 인수 : value : 기준 시간 분수
 * - 반환값 : 기준 시간보다 반 tick 뒤의 TimeFraction
 */
function addHalfTick(value: TimeFraction): TimeFraction {
  return {
    numerator: value.numerator * 2 + value.denominator,
    denominator: value.denominator * 2,
  };
}

/**
 * TimeFraction을 MVP 비교용 number로 변환한다.
 * - 인수 : value : 비교할 시간 분수
 * - 반환값 : number : numerator / denominator
 */
function fractionToNumber(value: TimeFraction): number {
  return value.numerator / value.denominator;
}
