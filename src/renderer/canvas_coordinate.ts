/**
 * CanvasRenderInput을 CSS pixel 기준 CanvasScoreLayout으로 변환하고 canvas bitmap 크기를 맞춘다.
 */

import type {
  CanvasDynamicViewport,
  CanvasLayerTarget,
  CanvasRenderInput,
  CanvasRenderOptions,
  CanvasRenderTarget,
  CanvasScoreLayout,
} from "./canvas_types";
import { CANVAS_METRICS } from "./canvas_theme";

const DEFAULT_LAYOUT_WIDTH =
  CANVAS_METRICS.baseLayoutPaddingWidth +
  CANVAS_METRICS.baseLayoutLabelWidth +
  CANVAS_METRICS.baseLayoutPaddingWidth;
const PREVIEW_MAX_BITMAP_WIDTH = 65_535;
const PREVIEW_MAX_BITMAP_HEIGHT = 1080;

type NormalizedCanvasRenderOptions = {
  zoom: number;
  devicePixelRatio: number;
  columnWidth: number;
  layoutWidth: number;
  layoutLabelWidth: number;
  layoutLeftPaddingWidth: number;
  layoutRightPaddingWidth: number;
  layoutFontSize: number;
};

/**
 * 숫자 옵션이 유효한 양수인지 확인한다.
 * - 인수 : value : 검사할 숫자
 * - 반환값 : 양수 finite number 여부
 */
function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * renderer 옵션을 좌표 계산에 안전한 값으로 정규화한다.
 * - 인수 : input : renderer 입력 DTO
 * - 인수 : options : UI/app controller에서 전달한 렌더 옵션
 * - 반환값 : 기본값과 유효 범위가 반영된 options
 */
function normalizeCanvasRenderOptions(
  input: CanvasRenderInput,
  options: CanvasRenderOptions,
): NormalizedCanvasRenderOptions {
  // UI 옵션이 유효한 숫자가 아니면 renderer 기본값으로 대체한다.
  const zoom = isPositiveFinite(options.zoom) ? options.zoom : 1;
  const devicePixelRatio = isPositiveFinite(options.devicePixelRatio)
    ? options.devicePixelRatio
    : 1;
  const baseColumnWidth = isPositiveFinite(input.baseColumnWidthPx)
    ? input.baseColumnWidthPx
    : 1;
  const optionColumnWidth =
    options.columnWidth === undefined ? baseColumnWidth : options.columnWidth;
  const columnWidth = isPositiveFinite(optionColumnWidth)
    ? optionColumnWidth * zoom
    : baseColumnWidth * zoom;

  return {
    zoom,
    devicePixelRatio,
    columnWidth,
    layoutWidth: DEFAULT_LAYOUT_WIDTH * zoom,
    layoutLabelWidth: CANVAS_METRICS.baseLayoutLabelWidth * zoom,
    layoutLeftPaddingWidth: CANVAS_METRICS.baseLayoutPaddingWidth * zoom,
    layoutRightPaddingWidth: CANVAS_METRICS.baseLayoutPaddingWidth * zoom,
    layoutFontSize: CANVAS_METRICS.baseLayoutFontSize * zoom,
  };
}

/**
 * column/tick 값을 CSS pixel x 좌표로 바꾼다.
 * - 인수 : column : 변환할 column 또는 tick 값
 * - 인수 : layout : 공유 좌표 layout
 * - 반환값 : score canvas 내부 x 좌표
 */
export function columnToX(column: number, layout: CanvasScoreLayout): number {
  return column * layout.columnWidth;
}

/**
 * CSS pixel x 좌표를 column/tick 값으로 바꾼다.
 * - 인수 : x : score canvas 내부 x 좌표
 * - 인수 : layout : 공유 좌표 layout
 * - 반환값 : column 또는 tick 값
 */
export function xToColumn(x: number, layout: CanvasScoreLayout): number {
  if (!Number.isFinite(x) || layout.columnWidth <= 0) {
    return 0;
  }

  return x / layout.columnWidth;
}

/**
 * renderer 입력 DTO에서 row 누적 좌표와 stage metric을 계산한다.
 * - 인수 : input : renderer 입력 DTO
 * - 인수 : options : UI/app controller에서 전달한 렌더 옵션
 * - 반환값 : canvas layer가 공유할 CSS pixel 좌표 모델
 */
export function buildCanvasScoreLayout(
  input: CanvasRenderInput,
  options: CanvasRenderOptions,
): CanvasScoreLayout {
  const normalized = normalizeCanvasRenderOptions(input, options);
  let y = 0;
  // 입력 row를 순회하며 각 row의 y 좌표와 zoom이 적용된 높이를 계산한다.
  const rows = input.rows.map((row) => {
    const height = Math.max(0, row.height * normalized.zoom);
    const layoutRow = {
      rowId: row.rowId,
      kind: row.kind,
      label: row.label,
      midi: row.midi,
      y,
      height,
    };
    y += height;
    return layoutRow;
  });
  const columnCount = Math.max(0, Math.floor(input.columnCount));
  const scoreContentWidth = columnCount * normalized.columnWidth;

  // score stage 크기와 layout label 영역에서 사용할 padding/boundary 좌표를 묶어 반환한다.
  return {
    rows,
    columnCount,
    columnWidth: normalized.columnWidth,
    scoreContentWidth,
    stageWidth: scoreContentWidth,
    stageHeight: y,
    layoutWidth: normalized.layoutWidth,
    layoutLabelWidth: normalized.layoutLabelWidth,
    layoutLeftPaddingWidth: normalized.layoutLeftPaddingWidth,
    layoutRightPaddingWidth: normalized.layoutRightPaddingWidth,
    layoutPlaybackBoundaryX: normalized.layoutWidth,
    layoutFontSize: normalized.layoutFontSize,
  };
}

/**
 * canvas bitmap 크기를 CSS pixel 크기와 devicePixelRatio에 맞춘다.
 * - 인수 : target : 크기를 맞출 canvas target
 * - 인수 : cssWidth : CSS pixel 기준 너비
 * - 인수 : cssHeight : CSS pixel 기준 높이
 * - 인수 : devicePixelRatio : bitmap 해상도 보정값
 * - 반환값 : 없음
 */
export function resizeCanvasLayer(
  target: CanvasLayerTarget,
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): void {
  // 1차 사용자 테스트에서는 세로 과해상도를 줄이고 긴 악보 가로 bitmap 실패 가능성을 낮춘다.
  const effectiveDevicePixelRatio = Math.max(
    0.25,
    Math.min(
      devicePixelRatio,
      PREVIEW_MAX_BITMAP_WIDTH / Math.max(1, cssWidth),
      PREVIEW_MAX_BITMAP_HEIGHT / Math.max(1, cssHeight),
    ),
  );
  const bitmapWidth = Math.max(
    1,
    Math.floor(cssWidth * effectiveDevicePixelRatio),
  );
  const bitmapHeight = Math.max(
    1,
    Math.floor(cssHeight * effectiveDevicePixelRatio),
  );

  target.canvas.style.width = `${cssWidth}px`;
  target.canvas.style.height = `${cssHeight}px`;
  target.canvas.style.transformOrigin = "";
  target.canvas.style.transform = "";

  // 계산된 bitmap 크기가 현재 canvas 속성과 다를 때만 width/height를 갱신한다.
  if (target.canvas.width !== bitmapWidth) {
    target.canvas.width = bitmapWidth;
  }
  if (target.canvas.height !== bitmapHeight) {
    target.canvas.height = bitmapHeight;
  }

  // 이후 draw 함수들이 CSS pixel 좌표로 그릴 수 있도록 context transform을 설정한다.
  target.context.setTransform(
    effectiveDevicePixelRatio,
    0,
    0,
    effectiveDevicePixelRatio,
    0,
    0,
  );
}

/**
 * 긴 악보 실험용으로 동적 layer canvas를 현재 viewport 폭으로만 맞춘다.
 * - 인수 : target : 크기를 맞출 canvas target
 * - 인수 : layout : 전체 score 좌표 layout
 * - 인수 : viewport : scrollLeft와 viewport 폭
 * - 인수 : devicePixelRatio : bitmap 해상도 보정값
 * - 반환값 : viewport 시작/끝 x 좌표
 */
export function resizeCanvasLayerToDynamicViewport(
  target: CanvasLayerTarget,
  layout: CanvasScoreLayout,
  viewport: CanvasDynamicViewport,
  devicePixelRatio: number,
): { startX: number; endX: number; width: number; didResize: boolean } {
  const startX = Math.max(0, viewport.scrollLeft - viewport.overscanPx);
  const endX = Math.min(
    layout.stageWidth,
    viewport.scrollLeft + viewport.width + viewport.overscanPx,
  );
  const cssWidth = Math.max(1, endX - startX);
  const cssHeight = layout.stageHeight;
  const effectiveDevicePixelRatio = Math.max(
    0.25,
    Math.min(
      devicePixelRatio,
      PREVIEW_MAX_BITMAP_WIDTH / Math.max(1, cssWidth),
      PREVIEW_MAX_BITMAP_HEIGHT / Math.max(1, cssHeight),
    ),
  );
  const bitmapWidth = Math.max(1, Math.floor(cssWidth * effectiveDevicePixelRatio));
  const bitmapHeight = Math.max(1, Math.floor(cssHeight * effectiveDevicePixelRatio));
  let didResize = false;

  target.canvas.style.width = `${cssWidth}px`;
  target.canvas.style.height = `${cssHeight}px`;
  target.canvas.style.transformOrigin = "0 0";
  target.canvas.style.transform = `translateX(${startX}px)`;

  if (target.canvas.width !== bitmapWidth) {
    target.canvas.width = bitmapWidth;
    didResize = true;
  }
  if (target.canvas.height !== bitmapHeight) {
    target.canvas.height = bitmapHeight;
    didResize = true;
  }

  target.context.setTransform(
    effectiveDevicePixelRatio,
    0,
    0,
    effectiveDevicePixelRatio,
    -startX * effectiveDevicePixelRatio,
    0,
  );

  return {
    startX,
    endX,
    width: cssWidth,
    didResize,
  };
}

/**
 * renderer가 사용하는 모든 canvas layer의 bitmap과 CSS 크기를 동기화한다.
 * - 인수 : target : renderer canvas target 묶음
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : options : UI/app controller에서 전달한 렌더 옵션
 * - 반환값 : 없음
 */
export function resizeCanvasLayers(
  target: CanvasRenderTarget,
  layout: CanvasScoreLayout,
  options: CanvasRenderOptions,
): void {
  const dpr = isPositiveFinite(options.devicePixelRatio)
    ? options.devicePixelRatio
    : 1;

  resizeCanvasLayer(target.layout, layout.layoutWidth, layout.stageHeight, dpr);
  resizeCanvasLayer(target.base, layout.stageWidth, layout.stageHeight, dpr);
  resizeCanvasLayer(target.note, layout.stageWidth, layout.stageHeight, dpr);
  resizeCanvasLayer(target.marker, layout.stageWidth, layout.stageHeight, dpr);
  resizeCanvasLayer(target.noteMarker, layout.stageWidth, layout.stageHeight, dpr);
}
