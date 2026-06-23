/**
 * analyzer eventId를 기준으로 이전/다음 이벤트 집합의 차이를 계산한다.
 */

import type { AnalyzedEvent } from "./types";

/** eventId 기준 diff에서 한 이벤트가 어떤 상태인지 나타낸다. */
export type AnalyzedEventDiffKind = "added" | "removed" | "changed" | "unchanged";

/** eventId 기준 diff의 단일 결과 항목. */
export type AnalyzedEventDiffEntry = {
  eventId: string;
  eventKind: AnalyzedEvent["eventKind"];
  trackId: string;
  diffKind: AnalyzedEventDiffKind;
  previous: AnalyzedEvent | null;
  next: AnalyzedEvent | null;
};

/** eventId 기준 diff의 전체 결과. */
export type AnalyzedEventDiffResult = {
  added: AnalyzedEventDiffEntry[];
  removed: AnalyzedEventDiffEntry[];
  changed: AnalyzedEventDiffEntry[];
  unchanged: AnalyzedEventDiffEntry[];
  duplicateEventIds: string[];
};

/**
 * 이전/다음 analyzer event 목록을 eventId 기준으로 비교한다.
 * - 인수 : previousEvents : 수정 전 analyzer event 목록
 * - 인수 : nextEvents : 수정 후 analyzer event 목록
 * - 반환값 : 추가/삭제/변경/유지 event와 중복 eventId 목록
 */
export function diffAnalyzedEventsById(
  previousEvents: readonly AnalyzedEvent[],
  nextEvents: readonly AnalyzedEvent[],
): AnalyzedEventDiffResult {
  const previousIndex = indexEventsById(previousEvents);
  const nextIndex = indexEventsById(nextEvents);
  const allEventIds = Array.from(new Set([
    ...previousIndex.eventsById.keys(),
    ...nextIndex.eventsById.keys(),
  ])).sort((left, right) => left.localeCompare(right));
  const result: AnalyzedEventDiffResult = {
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
    duplicateEventIds: Array.from(new Set([
      ...previousIndex.duplicateEventIds,
      ...nextIndex.duplicateEventIds,
    ])).sort((left, right) => left.localeCompare(right)),
  };

  // eventId별 존재 여부와 구조 fingerprint를 비교해 다음 단계가 교체 범위를 고를 수 있게 한다.
  for (const eventId of allEventIds) {
    const previous = previousIndex.eventsById.get(eventId) ?? null;
    const next = nextIndex.eventsById.get(eventId) ?? null;
    const entry = createDiffEntry(eventId, previous, next);

    result[entry.diffKind].push(entry);
  }

  return result;
}

/**
 * event 목록을 eventId map으로 변환하고 중복 id를 기록한다.
 * - 인수 : events : analyzer event 목록
 * - 반환값 : eventId map과 중복 id 목록
 */
function indexEventsById(events: readonly AnalyzedEvent[]): {
  eventsById: Map<string, AnalyzedEvent>;
  duplicateEventIds: string[];
} {
  const eventsById = new Map<string, AnalyzedEvent>();
  const duplicateEventIds: string[] = [];

  // 같은 eventId가 반복되면 첫 이벤트를 기준으로 두고, 호출자가 fallback 경로를 선택할 수 있게 id를 보고한다.
  for (const event of events) {
    if (eventsById.has(event.eventId)) {
      duplicateEventIds.push(event.eventId);
      continue;
    }

    eventsById.set(event.eventId, event);
  }

  return {
    eventsById,
    duplicateEventIds,
  };
}

/**
 * 단일 eventId에 대한 diff entry를 만든다.
 * - 인수 : eventId : 비교 대상 eventId
 * - 인수 : previous : 이전 이벤트, 없으면 null
 * - 인수 : next : 다음 이벤트, 없으면 null
 * - 반환값 : AnalyzedEventDiffEntry
 */
function createDiffEntry(
  eventId: string,
  previous: AnalyzedEvent | null,
  next: AnalyzedEvent | null,
): AnalyzedEventDiffEntry {
  const representative = next ?? previous;

  if (representative === null) {
    throw new Error(`Cannot create diff entry without an event: ${eventId}`);
  }

  if (previous === null) {
    return {
      eventId,
      eventKind: representative.eventKind,
      trackId: representative.trackId,
      diffKind: "added",
      previous,
      next,
    };
  }

  if (next === null) {
    return {
      eventId,
      eventKind: representative.eventKind,
      trackId: representative.trackId,
      diffKind: "removed",
      previous,
      next,
    };
  }

  return {
    eventId,
    eventKind: representative.eventKind,
    trackId: representative.trackId,
    diffKind: getEventFingerprint(previous) === getEventFingerprint(next)
      ? "unchanged"
      : "changed",
    previous,
    next,
  };
}

/**
 * plain analyzer event를 구조 비교용 문자열로 변환한다.
 * - 인수 : event : 비교할 analyzer event
 * - 반환값 : JSON 구조 fingerprint
 */
function getEventFingerprint(event: AnalyzedEvent): string {
  return JSON.stringify(event);
}
