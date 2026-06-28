/**
 * analyzer 기반 marker item을 score marker layer에 그린다.
 */

import { columnToX } from "./canvas_coordinate";
import {
  CANVAS_COLORS,
  CANVAS_METRICS,
} from "./canvas_theme";
import type {
  CanvasDirtyTickRange,
  CanvasLayoutRow,
  CanvasMarkerItem,
  CanvasScoreLayout,
} from "./canvas_types";

const TRACK_EXTRA = "extra";
const BEAT_LINE_DASH = [4, 4] as const;
const GLISS_TREM_LINE_DASH = [6, 4] as const;
const TUPLET_CONTAINER_LINE_DASH = [4, 3] as const;

/**
 * marker render item 목록을 canvas에 그린다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : items : marker 표시 item 목록
 * - 반환값 : 없음
 */
export function drawScoreMarkers(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  items: CanvasMarkerItem[],
  options: { preserveExisting?: boolean } = {},
): void {
  if (options.preserveExisting !== true) {
    context.clearRect(0, 0, layout.stageWidth, layout.stageHeight);
  }

  const rowById = createLayoutRowMap(layout);

  // dynamics guide는 전역 rawText와 foreground marker 아래에 먼저 그린다.
  for (const item of items) {
    if (item.kind === "dynamicsGuide") {
      drawDynamicsGuideMarker(context, layout, rowById, item);
    }
  }

  // beat/bar grid marker는 global timeline foreground marker보다 먼저 그린다.
  for (const item of items) {
    if (item.kind === "beat" || item.kind === "bar") {
      drawTimingLineMarker(context, layout, item);
    }
  }

  for (const item of items) {
    if (item.kind === "loopBoundary") {
      drawLoopBoundaryMarker(context, layout, item);
    }
  }

  for (const item of items) {
    if (item.kind === "bpmChange") {
      drawBpmChangeMarker(context, layout, item);
    } else if (item.kind === "gliss") {
      drawGlissMarker(context, layout, rowById, item);
    } else if (item.kind === "glissOrphanAnchor") {
      drawGlissOrphanAnchorMarker(context, layout, rowById, item);
    }
  }
}

/**
 * marker canvas의 dirty tick 범위만 지우고 겹치는 marker를 다시 그린다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : items : marker 표시 item 목록
 * - 인수 : dirtyRange : 다시 그릴 tick 범위
 * - 반환값 : 없음
 */
export function drawScoreMarkersInRange(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  items: CanvasMarkerItem[],
  dirtyRange: CanvasDirtyTickRange,
): void {
  const x = getDirtyRangeX(dirtyRange, layout);

  context.clearRect(x.startX, 0, x.width, layout.stageHeight);
  context.save();
  clipDirtyRange(context, layout, dirtyRange);

  const rowById = createLayoutRowMap(layout);

  for (const item of items) {
    if (!doesMarkerOverlapDirtyRange(item, dirtyRange)) {
      continue;
    }

    if (item.kind === "dynamicsGuide") {
      drawDynamicsGuideMarker(context, layout, rowById, item);
    }
  }

  for (const item of items) {
    if (!doesMarkerOverlapDirtyRange(item, dirtyRange)) {
      continue;
    }

    if (item.kind === "beat" || item.kind === "bar") {
      drawTimingLineMarker(context, layout, item);
    }
  }

  for (const item of items) {
    if (!doesMarkerOverlapDirtyRange(item, dirtyRange)) {
      continue;
    }

    if (item.kind === "loopBoundary") {
      drawLoopBoundaryMarker(context, layout, item);
    }
  }

  for (const item of items) {
    if (!doesMarkerOverlapDirtyRange(item, dirtyRange)) {
      continue;
    }

    if (item.kind === "bpmChange") {
      drawBpmChangeMarker(context, layout, item);
    } else if (item.kind === "gliss") {
      drawGlissMarker(context, layout, rowById, item);
    } else if (item.kind === "glissOrphanAnchor") {
      drawGlissOrphanAnchorMarker(context, layout, rowById, item);
    }
  }

  context.restore();
}

/**
 * note layer 위에 올라와야 하는 marker item 목록을 canvas에 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : items : marker 표시 item 목록
 * - 반환값 : 없음
 */
export function drawScoreOverlayMarkers(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  items: CanvasMarkerItem[],
  options: { showTupletContainers?: boolean } = {},
): void {
  if (options.showTupletContainers !== true) {
    return;
  }

  const rowById = createLayoutRowMap(layout);

  // marker canvas의 z-index로 해결할 수 없는 note 위 보조 도형만 note layer 후처리로 그린다.
  for (const item of items) {
    if (item.kind === "tupletContainer") {
      drawTupletContainerMarker(context, layout, rowById, item);
    }
  }
}

/**
 * note layer 위 overlay marker 중 dirty tick 범위와 겹치는 항목만 다시 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : items : marker 표시 item 목록
 * - 인수 : dirtyRange : 다시 그릴 tick 범위
 * - 반환값 : 없음
 */
export function drawScoreOverlayMarkersInRange(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  items: CanvasMarkerItem[],
  dirtyRange: CanvasDirtyTickRange,
  options: { showTupletContainers?: boolean } = {},
): void {
  if (options.showTupletContainers !== true) {
    return;
  }

  const rowById = createLayoutRowMap(layout);

  context.save();
  clipDirtyRange(context, layout, dirtyRange);

  for (const item of items) {
    if (item.kind === "tupletContainer" && doesMarkerOverlapDirtyRange(item, dirtyRange)) {
      drawTupletContainerMarker(context, layout, rowById, item);
    }
  }

  context.restore();
}

/**
 * display text 아래에 위치해야 하는 gliss 연결선만 note layer에 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : items : marker 표시 item 목록
 * - 반환값 : 없음
 */
export function drawScoreGlissMarkers(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  items: CanvasMarkerItem[],
): void {
  const rowById = createLayoutRowMap(layout);

  for (const item of items) {
    if (item.kind === "gliss") {
      drawGlissMarker(context, layout, rowById, item);
    }
  }
}

/**
 * layout row를 rowId 기준 Map으로 만든다.
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : Map<string, CanvasLayoutRow> : marker item row 조회용 Map
 */
function createLayoutRowMap(
  layout: CanvasScoreLayout,
): Map<string, CanvasLayoutRow> {
  const rowById = new Map<string, CanvasLayoutRow>();

  // layout.rows를 순회하며 marker item이 참조할 수 있는 모든 row 좌표를 저장한다.
  for (const row of layout.rows) {
    rowById.set(row.rowId, row);
  }

  return rowById;
}

/**
 * marker item이 dirty tick 범위와 겹치는지 확인한다.
 * - 인수 : item : marker item
 * - 인수 : dirtyRange : dirty tick 범위
 * - 반환값 : 겹치면 true
 */
function doesMarkerOverlapDirtyRange(
  item: CanvasMarkerItem,
  dirtyRange: CanvasDirtyTickRange,
): boolean {
  const range = getMarkerTickRange(item);

  return range.endTick >= dirtyRange.startTick && range.startTick <= dirtyRange.endTick;
}

/**
 * marker item의 tick 범위를 반환한다.
 * - 인수 : item : marker item
 * - 반환값 : marker가 차지하는 tick 범위
 */
function getMarkerTickRange(item: CanvasMarkerItem): CanvasDirtyTickRange {
  if (
    item.kind === "beat" ||
    item.kind === "bar" ||
    item.kind === "bpmChange" ||
    item.kind === "loopBoundary"
  ) {
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
 * loop start/end marker를 보라색 세로선과 짧은 label로 그린다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : item : loop start 또는 end marker
 * - 반환값 : 없음
 */
function drawLoopBoundaryMarker(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  item: Extract<CanvasMarkerItem, { kind: "loopBoundary" }>,
): void {
  const x = columnToX(item.tick, layout);

  if (x < 0 || x > layout.stageWidth) {
    return;
  }

  context.save();
  context.strokeStyle = "rgba(180, 90, 255, 0.95)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x + 0.5, 0);
  context.lineTo(x + 0.5, layout.stageHeight);
  context.stroke();

  const label = item.role;
  context.font = "700 12px Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "top";
  const textWidth = context.measureText(label).width;
  const boxWidth = textWidth + 12;
  const boxHeight = 18;
  const boxY = Math.max(2, layout.stageHeight - boxHeight - 4);
  const boxX = Math.min(
    Math.max(0, x - boxWidth / 2),
    Math.max(0, layout.stageWidth - boxWidth),
  );
  context.fillStyle = "rgba(180, 90, 255, 0.36)";
  context.fillRect(boxX, boxY, boxWidth, boxHeight);
  context.fillStyle = "rgba(255, 255, 255, 0.82)";
  context.fillText(label, boxX + boxWidth / 2, boxY + 3);
  context.restore();
}

/**
 * dirty tick 범위를 clearRect에 사용할 x 범위로 변환한다.
 * - 인수 : dirtyRange : dirty tick 범위
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : clear 시작 x와 폭
 */
function getDirtyRangeX(
  dirtyRange: CanvasDirtyTickRange,
  layout: CanvasScoreLayout,
): { startX: number; width: number } {
  const padding = Math.max(layout.columnWidth, 8);
  const startX = Math.max(0, columnToX(dirtyRange.startTick, layout) - padding);
  const endX = Math.min(layout.stageWidth, columnToX(dirtyRange.endTick, layout) + padding);

  return {
    startX,
    width: Math.max(0, endX - startX),
  };
}

/**
 * dirty tick 범위에 해당하는 x 영역으로 draw를 제한한다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : dirtyRange : dirty tick 범위
 * - 반환값 : 없음
 */
function clipDirtyRange(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  dirtyRange: CanvasDirtyTickRange,
): void {
  const x = getDirtyRangeX(dirtyRange, layout);

  context.beginPath();
  context.rect(x.startX, 0, x.width, layout.stageHeight);
  context.clip();
}

/**
 * beat/bar marker item을 score 전체 높이의 세로선으로 그린다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : item : beat 또는 bar marker item
 * - 반환값 : 없음
 */
function drawTimingLineMarker(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  item: Extract<CanvasMarkerItem, { kind: "beat" | "bar" }>,
): void {
  const x = columnToX(item.tick, layout);

  if (x < 0 || x > layout.stageWidth) {
    return;
  }

  context.save();
  context.strokeStyle = item.kind === "bar"
    ? CANVAS_COLORS.barLine
    : CANVAS_COLORS.beatLine;
  context.lineWidth = item.kind === "bar"
    ? CANVAS_METRICS.barLineWidth
    : CANVAS_METRICS.beatLineWidth;
  if (item.kind === "beat") {
    context.setLineDash([...BEAT_LINE_DASH]);
  }
  context.beginPath();
  context.moveTo(x + 0.5, 0);
  context.lineTo(x + 0.5, layout.stageHeight);
  context.stroke();
  context.restore();
}

/**
 * BPM 변화 marker item을 score 전체 높이의 세로선으로 그린다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : item : BPM 변화 marker item
 * - 반환값 : 없음
 */
function drawBpmChangeMarker(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  item: Extract<CanvasMarkerItem, { kind: "bpmChange" }>,
): void {
  const x = columnToX(item.tick, layout);

  if (x < 0 || x > layout.stageWidth) {
    return;
  }

  context.save();
  context.strokeStyle = getBpmChangeColor(item.changeKind);
  context.lineWidth = CANVAS_METRICS.bpmChangeLineWidth;
  context.beginPath();
  context.moveTo(x + 0.5, 0);
  context.lineTo(x + 0.5, layout.stageHeight);
  context.stroke();
  context.restore();
}

/**
 * dynamics segment를 dynamics row 안의 두께 가이드로 그린다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : rowById : layout row 조회 Map
 * - 인수 : item : dynamics guide marker item
 * - 반환값 : 없음
 */
function drawDynamicsGuideMarker(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  rowById: Map<string, CanvasLayoutRow>,
  item: Extract<CanvasMarkerItem, { kind: "dynamicsGuide" }>,
): void {
  const row = rowById.get(item.rowId);

  if (
    row === undefined ||
    row.kind !== "global" ||
    item.endTick <= item.startTick
  ) {
    return;
  }

  const x0 = columnToX(item.startTick, layout);
  const x1 = columnToX(item.endTick, layout);

  if (x1 <= x0) {
    return;
  }

  const centerY = row.y + row.height / 2;
  const startThickness = getDynamicsThickness(item.startValue, row.height);
  const endThickness = getDynamicsThickness(item.endValue, row.height);

  if (startThickness <= 0 && endThickness <= 0) {
    return;
  }

  context.save();
  context.fillStyle = CANVAS_COLORS.dynamicsGuide;
  context.beginPath();
  context.moveTo(x0, centerY - startThickness / 2);
  context.lineTo(x1, centerY - endThickness / 2);
  context.lineTo(x1, centerY + endThickness / 2);
  context.lineTo(x0, centerY + startThickness / 2);
  context.closePath();
  context.fill();
  context.restore();
}

/**
 * gliss marker item을 두 anchor 중심을 잇는 선으로 그린다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : rowById : layout row 조회 Map
 * - 인수 : item : gliss marker item
 * - 반환값 : 없음
 */
function drawGlissMarker(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  rowById: Map<string, CanvasLayoutRow>,
  item: Extract<CanvasMarkerItem, { kind: "gliss" }>,
): void {
  const startRow = rowById.get(item.startRowId);
  const endRow = rowById.get(item.endRowId);

  if (
    startRow === undefined ||
    endRow === undefined ||
    startRow.kind !== "note" ||
    endRow.kind !== "note"
  ) {
    return;
  }

  const startX = getAnchorX(item.startTick, layout);
  const endX = getAnchorX(item.endTick, layout);
  const startY = getDisplayCenterY(startRow, item.startCentOffset, layout);
  const endY = getDisplayCenterY(endRow, item.endCentOffset, layout);

  context.save();
  context.globalAlpha = item.renderAlpha ?? 1;
  context.strokeStyle = item.trackId === TRACK_EXTRA
    ? CANVAS_COLORS.extraGlissLine
    : CANVAS_COLORS.glissLine;
  context.lineWidth = CANVAS_METRICS.glissLineWidth;
  context.lineCap = "round";
  if (item.hasTrem) {
    context.setLineDash([...GLISS_TREM_LINE_DASH]);
  }
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();
  context.restore();
}

/**
 * 연결되지 않은 gliss anchor를 편집 보조용 짧은 선으로 그린다.
 * - 인수 : context : marker layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : rowById : layout row 조회 Map
 * - 인수 : item : orphan gliss anchor marker item
 * - 반환값 : 없음
 */
function drawGlissOrphanAnchorMarker(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  rowById: Map<string, CanvasLayoutRow>,
  item: Extract<CanvasMarkerItem, { kind: "glissOrphanAnchor" }>,
): void {
  const row = rowById.get(item.rowId);

  if (row === undefined || row.kind !== "note") {
    return;
  }

  const anchorX = getAnchorX(item.tick, layout);
  const anchorY = getDisplayCenterY(row, item.centOffset, layout);
  const ranges = createOrphanAnchorRanges(anchorX, item.role, layout);

  context.save();
  context.globalAlpha = item.renderAlpha ?? 1;
  context.strokeStyle = item.trackId === TRACK_EXTRA
    ? CANVAS_COLORS.extraGlissLine
    : CANVAS_COLORS.glissLine;
  context.lineWidth = CANVAS_METRICS.glissLineWidth;
  context.lineCap = "round";

  // note 사각형 뒤에 있어도 보이도록 셀 중앙이 아닌 바깥쪽 반 칸 구간만 그린다.
  for (const range of ranges) {
    context.beginPath();
    context.moveTo(range.x0, anchorY);
    context.lineTo(range.x1, anchorY);
    context.stroke();
  }

  context.restore();
}

/**
 * tuplet group의 head row 위치에 점선 컨테이너와 분할 숫자 라벨을 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : rowById : layout row 조회 Map
 * - 인수 : item : tuplet container marker item
 * - 반환값 : 없음
 */
function drawTupletContainerMarker(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  rowById: Map<string, CanvasLayoutRow>,
  item: Extract<CanvasMarkerItem, { kind: "tupletContainer" }>,
): void {
  const row = rowById.get(item.rowId);

  if (row === undefined || row.kind !== "note" || item.endTick <= item.startTick) {
    return;
  }

  const x = columnToX(item.startTick, layout);
  const height = Math.max(
    CANVAS_METRICS.minNoteHeight,
    CANVAS_METRICS.baseNoteRenderHeight * getLayoutZoom(layout),
  );
  const y = row.y + row.height / 2 - height / 2;
  const width = columnToX(item.endTick, layout) - x;

  if (width <= 0 || height <= 0) {
    return;
  }

  context.save();
  context.globalAlpha = (item.renderAlpha ?? 1) * (item.trackId === TRACK_EXTRA ? 1 : 0.95);
  context.strokeStyle = CANVAS_COLORS.tupletContainer;
  context.lineWidth = CANVAS_METRICS.tupletContainerLineWidth;
  context.setLineDash([...TUPLET_CONTAINER_LINE_DASH]);
  context.strokeRect(
    x + 0.5,
    y + 0.5,
    Math.max(0, width - 1),
    Math.max(0, height - 1),
  );
  context.setLineDash([]);
  drawTupletDivNumLabel(context, x, y, width, height, item.divNum, layout);
  context.restore();
}

/**
 * tuplet container 중앙에 작은 분할 숫자 라벨을 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : x : container 왼쪽 x 좌표
 * - 인수 : y : container 위쪽 y 좌표
 * - 인수 : width : container 너비
 * - 인수 : height : container 높이
 * - 인수 : divNum : 표시할 tuplet 분할 수
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : 없음
 */
function drawTupletDivNumLabel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  divNum: number | null,
  layout: CanvasScoreLayout,
): void {
  if (divNum === null) {
    return;
  }

  const label = String(divNum);

  if (label === "") {
    return;
  }

  const fontSize = Math.max(
    7,
    CANVAS_METRICS.tupletLabelFontSizePx * getLayoutZoom(layout),
  );

  context.fillStyle = CANVAS_COLORS.tupletLabel;
  context.font = `700 ${fontSize}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x + width / 2, y + height / 2);
}

/**
 * orphan anchor role에 따라 짧은 선의 x 범위를 만든다.
 * - 인수 : anchorX : anchor cell 중심 x 좌표
 * - 인수 : role : start/mid/end gliss 역할
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : 왼쪽/오른쪽 orphan 표시 선 범위 목록
 */
function createOrphanAnchorRanges(
  anchorX: number,
  role: "start" | "mid" | "end",
  layout: CanvasScoreLayout,
): Array<{ x0: number; x1: number }> {
  const halfColumn = layout.columnWidth / 2;
  const ranges: Array<{ x0: number; x1: number }> = [];

  if (role === "end" || role === "mid") {
    ranges.push({
      x0: anchorX - halfColumn * 2,
      x1: anchorX - halfColumn,
    });
  }

  if (role === "start" || role === "mid") {
    ranges.push({
      x0: anchorX + halfColumn,
      x1: anchorX + halfColumn * 2,
    });
  }

  return ranges;
}

/**
 * BPM 변화 marker 종류에 맞는 색상을 반환한다.
 * - 인수 : changeKind : instant/accel/rit 변화 종류
 * - 반환값 : CSS 색상 문자열
 */
function getBpmChangeColor(
  changeKind: Extract<CanvasMarkerItem, { kind: "bpmChange" }>["changeKind"],
): string {
  if (changeKind === "accel") {
    return CANVAS_COLORS.bpmAccelLine;
  }

  if (changeKind === "rit") {
    return CANVAS_COLORS.bpmRitLine;
  }

  return CANVAS_COLORS.bpmInstantLine;
}

/**
 * dynamics 값을 row 안의 표시 두께로 변환한다.
 * - 인수 : value : dynamics 값. parser 기준 0~150이다.
 * - 인수 : rowHeight : dynamics row 높이
 * - 반환값 : dynamics guide 두께
 */
function getDynamicsThickness(value: number, rowHeight: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(rowHeight) || rowHeight <= 0) {
    return 0;
  }

  return rowHeight * (Math.min(Math.max(value, 0), 150) / 150);
}

/**
 * gliss anchor tick을 note rectangle 내부 anchor x 좌표로 변환한다.
 * - 인수 : tick : anchor가 속한 tick
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : number : marker layer x 좌표
 */
function getAnchorX(tick: number, layout: CanvasScoreLayout): number {
  return columnToX(tick, layout);
}

/**
 * microPitch centOffset을 note row 중심 y 좌표로 변환한다.
 * - 인수 : row : 기준 note row layout
 * - 인수 : centOffset : -100~100 cent 단위 표시 위치 보정값
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : number : 보정이 반영된 note 중심 y 좌표
 */
function getDisplayCenterY(
  row: CanvasLayoutRow,
  centOffset: number,
  layout: CanvasScoreLayout,
): number {
  const baseCenter = row.y + row.height / 2;

  if (centOffset === 0) {
    return baseCenter;
  }

  const noteRows = layout.rows.filter((candidate) => candidate.kind === "note");
  const rowIndex = noteRows.findIndex((candidate) => candidate.rowId === row.rowId);

  if (rowIndex === -1) {
    return baseCenter;
  }

  const targetRow = findMicroPitchTargetRow(row, noteRows, centOffset);

  if (targetRow !== undefined) {
    const targetCenter = targetRow.y + targetRow.height / 2;

    return baseCenter + (targetCenter - baseCenter) * (Math.abs(centOffset) / 100);
  }

  // 악기 범위 끝에서는 이웃 note row 간격을 구할 수 없으므로 현재 row 높이만큼 외삽한다.
  return baseCenter + getMicroPitchScreenDirection(row, noteRows, centOffset) *
    row.height *
    (Math.abs(centOffset) / 100);
}

/**
 * centOffset 부호에 대응하는 실제 pitch 이웃 row를 찾는다.
 * - 인수 : row : 기준 note row layout
 * - 인수 : noteRows : 현재 화면 순서의 note row 목록
 * - 인수 : centOffset : -100~100 cent 단위 표시 위치 보정값
 * - 반환값 : +cent이면 더 높은 pitch row, -cent이면 더 낮은 pitch row
 */
function findMicroPitchTargetRow(
  row: CanvasLayoutRow,
  noteRows: readonly CanvasLayoutRow[],
  centOffset: number,
): CanvasLayoutRow | undefined {
  if (row.midi === undefined) {
    return undefined;
  }

  const baseMidi = row.midi;
  const candidates = noteRows.filter((candidate) =>
    candidate.midi !== undefined &&
    (centOffset > 0 ? candidate.midi > baseMidi : candidate.midi < baseMidi)
  );

  return candidates.sort((left, right) =>
    Math.abs((left.midi ?? 0) - baseMidi) - Math.abs((right.midi ?? 0) - baseMidi)
  )[0];
}

/**
 * 악기 범위 끝에서 centOffset 부호가 향해야 할 화면 y 방향을 추론한다.
 * - 인수 : row : 기준 note row layout
 * - 인수 : noteRows : 현재 화면 순서의 note row 목록
 * - 인수 : centOffset : -100~100 cent 단위 표시 위치 보정값
 * - 반환값 : y 증가 방향이면 1, y 감소 방향이면 -1
 */
function getMicroPitchScreenDirection(
  row: CanvasLayoutRow,
  noteRows: readonly CanvasLayoutRow[],
  centOffset: number,
): -1 | 1 {
  const oppositeRow = findMicroPitchTargetRow(row, noteRows, -centOffset);

  if (oppositeRow === undefined) {
    return centOffset > 0 ? -1 : 1;
  }

  const baseCenter = row.y + row.height / 2;
  const oppositeCenter = oppositeRow.y + oppositeRow.height / 2;

  return oppositeCenter > baseCenter ? -1 : 1;
}

/**
 * layout font size에서 현재 layout zoom을 계산한다.
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : number : 기준 font size 대비 확대 배율
 */
function getLayoutZoom(layout: CanvasScoreLayout): number {
  return layout.layoutFontSize / 12;
}
