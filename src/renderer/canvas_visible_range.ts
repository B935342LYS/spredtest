/**
 * renderer item 목록을 현재 viewport visible range에 맞춰 좁힌다.
 */

import type {
  CanvasGlobalTextRenderItem,
  CanvasMarkerItem,
  CanvasMuteRenderItem,
  CanvasNoteRenderItem,
  CanvasVisibleTickRange,
} from "./canvas_types";
import { doesTickRangeOverlapVisibleRange } from "./canvas_viewport";

type TickRangeItem = {
  startTick: number;
  endTick: number;
};

type TickRangeIndexEntry<T extends TickRangeItem> = {
  item: T;
  startTick: number;
  endTick: number;
  originalIndex: number;
  prefixMaxEndTick: number;
};

type TickRangeIndex<T extends TickRangeItem> = {
  entries: TickRangeIndexEntry<T>[];
};

const noteItemIndexCache = new WeakMap<CanvasNoteRenderItem[], TickRangeIndex<CanvasNoteRenderItem>>();
const muteItemIndexCache = new WeakMap<CanvasMuteRenderItem[], TickRangeIndex<CanvasMuteRenderItem>>();

/**
 * note item 중 visible range와 겹치는 항목만 반환한다.
 * - 인수 : items : 전체 note render item 목록
 * - 인수 : range : 현재 viewport visible range
 * - 반환값 : viewport 근처에 그릴 note item 목록
 */
export function filterVisibleNoteItems(
  items: CanvasNoteRenderItem[],
  range: CanvasVisibleTickRange,
): CanvasNoteRenderItem[] {
  return queryTickRangeIndex(
    getTickRangeIndex(items, noteItemIndexCache),
    range,
  );
}

/**
 * mute item 중 visible range와 겹치는 항목만 반환한다.
 * - 인수 : items : 전체 mute render item 목록
 * - 인수 : range : 현재 viewport visible range
 * - 반환값 : viewport 근처에 그릴 mute item 목록
 */
export function filterVisibleMuteItems(
  items: CanvasMuteRenderItem[],
  range: CanvasVisibleTickRange,
): CanvasMuteRenderItem[] {
  return queryTickRangeIndex(
    getTickRangeIndex(items, muteItemIndexCache),
    range,
  );
}

/**
 * global text item 중 visible range와 겹치는 항목만 반환한다.
 * - 인수 : items : 전체 global text item 목록
 * - 인수 : range : 현재 viewport visible range
 * - 반환값 : viewport 근처에 그릴 global text item 목록
 */
export function filterVisibleGlobalTextItems(
  items: CanvasGlobalTextRenderItem[],
  range: CanvasVisibleTickRange,
): CanvasGlobalTextRenderItem[] {
  return items.filter((item) => (
    item.col >= range.startTick - 1 &&
    item.col <= range.endTick + 1
  ));
}

/**
 * marker item 중 visible range와 겹치는 항목만 반환한다.
 * - 인수 : items : 전체 marker item 목록
 * - 인수 : range : 현재 viewport visible range
 * - 반환값 : viewport 근처에 그릴 marker item 목록
 */
export function filterVisibleMarkerItems(
  items: CanvasMarkerItem[],
  range: CanvasVisibleTickRange,
): CanvasMarkerItem[] {
  return items.filter((item) => {
    const tickRange = getMarkerTickRange(item);

    return doesTickRangeOverlapVisibleRange(
      tickRange.startTick,
      tickRange.endTick,
      range,
    );
  });
}

/**
 * marker item이 차지하는 tick 범위를 반환한다.
 * - 인수 : item : marker item
 * - 반환값 : visible range 판정에 사용할 tick 범위
 */
function getMarkerTickRange(item: CanvasMarkerItem): { startTick: number; endTick: number } {
  if (item.kind === "beat" || item.kind === "bar" || item.kind === "bpmChange") {
    return {
      startTick: item.tick,
      endTick: item.tick,
    };
  }

  if (item.kind === "dynamicsGuide" || item.kind === "tupletContainer") {
    return {
      startTick: item.startTick,
      endTick: item.endTick,
    };
  }

  if (item.kind === "gliss") {
    return {
      startTick: Math.min(item.startTick, item.endTick),
      endTick: Math.max(item.startTick, item.endTick),
    };
  }

  return {
    startTick: item.tick,
    endTick: item.tick,
  };
}

/**
 * tick range item 배열에 대한 viewport 질의용 index를 가져오거나 생성한다.
 * - 인수 : items : start/end tick을 가진 renderer item 배열
 * - 인수 : cache : 배열 identity 기준 WeakMap cache
 * - 반환값 : startTick 정렬과 prefix max endTick을 가진 index
 */
function getTickRangeIndex<T extends TickRangeItem>(
  items: T[],
  cache: WeakMap<T[], TickRangeIndex<T>>,
): TickRangeIndex<T> {
  const cached = cache.get(items);

  if (cached !== undefined) {
    return cached;
  }

  let prefixMaxEndTick = Number.NEGATIVE_INFINITY;
  const entries = items
    .map((item, originalIndex) => ({
      item,
      startTick: item.startTick,
      endTick: item.endTick,
      originalIndex,
      prefixMaxEndTick: Number.NEGATIVE_INFINITY,
    }))
    .sort((left, right) =>
      left.startTick - right.startTick ||
      left.originalIndex - right.originalIndex
    );

  // startTick 정렬 순서의 prefix max endTick을 저장해, 이전 item들이 더 이상 viewport와 겹칠 수 없으면 역방향 scan을 중단한다.
  for (const entry of entries) {
    prefixMaxEndTick = Math.max(prefixMaxEndTick, entry.endTick);
    entry.prefixMaxEndTick = prefixMaxEndTick;
  }

  const index = {
    entries,
  };

  cache.set(items, index);
  return index;
}

/**
 * tick range index에서 현재 visible range와 겹치는 item만 원래 draw 순서로 반환한다.
 * - 인수 : index : 배열별 tick range index
 * - 인수 : range : 현재 viewport visible range
 * - 반환값 : viewport 근처에 그릴 item 목록
 */
function queryTickRangeIndex<T extends TickRangeItem>(
  index: TickRangeIndex<T>,
  range: CanvasVisibleTickRange,
): T[] {
  const entries = index.entries;
  const lastCandidateIndex = findLastStartTickIndex(entries, range.endTick);
  const visibleEntries: TickRangeIndexEntry<T>[] = [];

  // startTick이 range.endTick보다 작거나 같은 마지막 item부터 거꾸로 훑는다.
  for (let index = lastCandidateIndex; index >= 0; index -= 1) {
    const entry = entries[index];

    if (entry === undefined || entry.prefixMaxEndTick < range.startTick) {
      break;
    }

    if (doesTickRangeOverlapVisibleRange(entry.startTick, entry.endTick, range)) {
      visibleEntries.push(entry);
    }
  }

  return visibleEntries
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map((entry) => entry.item);
}

/**
 * startTick 정렬 entry에서 startTick <= targetTick인 마지막 index를 찾는다.
 * - 인수 : entries : startTick 오름차순 index entry 배열
 * - 인수 : targetTick : visible range의 끝 tick
 * - 반환값 : 마지막 후보 index, 없으면 -1
 */
function findLastStartTickIndex<T extends TickRangeItem>(
  entries: TickRangeIndexEntry<T>[],
  targetTick: number,
): number {
  let low = 0;
  let high = entries.length - 1;
  let result = -1;

  // 이진 탐색으로 visible range 오른쪽보다 왼쪽에서 시작한 item의 끝 위치를 찾는다.
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const entry = entries[mid];

    if (entry !== undefined && entry.startTick <= targetTick) {
      result = mid;
      low = mid + 1;
      continue;
    }

    high = mid - 1;
  }

  return result;
}
