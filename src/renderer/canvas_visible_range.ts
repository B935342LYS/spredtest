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
  return items.filter((item) => doesTickRangeOverlapVisibleRange(
    item.startTick,
    item.endTick,
    range,
  ));
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
  return items.filter((item) => doesTickRangeOverlapVisibleRange(
    item.startTick,
    item.endTick,
    range,
  ));
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
