/**
 * score viewport 좌표를 renderer visible range로 변환한다.
 */

import { xToColumn } from "./canvas_coordinate";
import type {
  CanvasDynamicViewport,
  CanvasScoreLayout,
  CanvasVisibleTickRange,
} from "./canvas_types";

/**
 * scrollLeft와 viewport 폭에서 overscan이 포함된 visible tick/x 범위를 만든다.
 * - 인수 : layout : 전체 score 좌표 layout
 * - 인수 : viewport : 현재 score scroll viewport
 * - 반환값 : visible item filtering과 dynamic canvas resize에 사용할 범위
 */
export function createCanvasVisibleTickRange(
  layout: CanvasScoreLayout,
  viewport: CanvasDynamicViewport,
): CanvasVisibleTickRange {
  const startX = Math.max(0, viewport.scrollLeft - viewport.overscanPx);
  const endX = Math.min(
    layout.stageWidth,
    viewport.scrollLeft + viewport.width + viewport.overscanPx,
  );

  return {
    startTick: Math.max(0, Math.floor(xToColumn(startX, layout))),
    endTick: Math.max(0, Math.ceil(xToColumn(endX, layout))),
    startX,
    endX,
  };
}

/**
 * tick 범위가 visible range와 겹치는지 확인한다.
 * - 인수 : startTick : 대상 시작 tick
 * - 인수 : endTick : 대상 끝 tick
 * - 인수 : range : viewport visible tick 범위
 * - 반환값 : 겹치면 true
 */
export function doesTickRangeOverlapVisibleRange(
  startTick: number,
  endTick: number,
  range: CanvasVisibleTickRange,
): boolean {
  return endTick >= range.startTick && startTick <= range.endTick;
}
