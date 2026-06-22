/**
 * analyzer 기반 note item을 score note layer에 그린다.
 */

import { columnToX } from "./canvas_coordinate";
import {
  colorForBasicMidi,
  colorForOptionalMidi,
} from "./canvas_note_colors";
import {
  CANVAS_COLORS,
  CANVAS_METRICS,
} from "./canvas_theme";
import type {
  CanvasGlobalTextRenderItem,
  CanvasLayoutRow,
  CanvasMuteRenderItem,
  CanvasNoteLayoutItem,
  CanvasNoteRenderItem,
  CanvasScoreLayout,
} from "./canvas_types";

const TRACK_OPTIONAL = "optional";
const TRACK_EXTRA = "extra";

/**
 * note render item 목록을 canvas에 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : items : tick/row 기준 note 표시 item 목록
 * - 반환값 : 없음
 */
export function drawScoreNotes(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  items: CanvasNoteRenderItem[],
  muteItems: CanvasMuteRenderItem[] = [],
  globalTextItems: CanvasGlobalTextRenderItem[] = [],
): void {
  context.clearRect(0, 0, layout.stageWidth, layout.stageHeight);

  const rowById = createLayoutRowMap(layout);

  // analyzer note item을 CSS pixel 좌표 item으로 변환한 뒤 note rectangle과 text를 그린다.
  for (const item of items) {
    const layoutItem = createNoteLayoutItem(item, rowById, layout);

    if (layoutItem === null) {
      continue;
    }

    context.save();
    context.globalAlpha = layoutItem.renderAlpha ?? 1;
    drawNoteRectangle(context, layoutItem);
    drawNoteEffects(context, layoutItem, layout);
    drawNoteText(context, layoutItem, layout);
    context.restore();
  }

  // mute item은 발음 사각형 없이 흰색 텍스트만 note layer 위에 표시한다.
  for (const item of muteItems) {
    context.save();
    context.globalAlpha = item.renderAlpha ?? 1;
    drawMuteText(context, layout, rowById, item);
    context.restore();
  }

  // 전역 행 셀 rawText는 note/mute와 같은 overlay layer에 흰색 텍스트로 표시한다.
  for (const item of globalTextItems) {
    drawGlobalText(context, layout, rowById, item);
  }
}

/**
 * layout row를 rowId 기준 Map으로 만든다.
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : Map<string, CanvasLayoutRow> : note item row 조회용 Map
 */
function createLayoutRowMap(
  layout: CanvasScoreLayout,
): Map<string, CanvasLayoutRow> {
  const rowById = new Map<string, CanvasLayoutRow>();

  // layout.rows를 순회하며 note item이 참조할 수 있는 모든 row 좌표를 저장한다.
  for (const row of layout.rows) {
    rowById.set(row.rowId, row);
  }

  return rowById;
}

/**
 * tick/row 기준 note item을 CSS pixel 기준 note item으로 변환한다.
 * - 인수 : item : analyzer에서 변환된 note 표시 item
 * - 인수 : rowById : layout row 조회 Map
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : CanvasNoteLayoutItem | null : 그릴 수 있는 좌표 item 또는 제외 결과
 */
function createNoteLayoutItem(
  item: CanvasNoteRenderItem,
  rowById: Map<string, CanvasLayoutRow>,
  layout: CanvasScoreLayout,
): CanvasNoteLayoutItem | null {
  const row = rowById.get(item.rowId);

  if (row === undefined || row.kind !== "note") {
    return null;
  }

  const startX = columnToX(item.startTick, layout);
  const endX = columnToX(item.endTick, layout);
  const height = Math.max(
    CANVAS_METRICS.minNoteHeight,
    CANVAS_METRICS.baseNoteRenderHeight * getLayoutZoom(layout),
  );
  const centerY = getDisplayCenterY(row, item.displayCentOffset, layout);
  const y = centerY - height / 2;
  const x = item.displayShape === "anchorSquare"
    ? startX + layout.columnWidth / 2 - height / 2
    : startX + CANVAS_METRICS.noteInsetX;
  const width = item.displayShape === "anchorSquare"
    ? height
    : Math.max(
      CANVAS_METRICS.minNoteWidth,
      endX - startX - CANVAS_METRICS.noteInsetX * 2,
    );

  return {
    ...item,
    x,
    y,
    width,
    height,
  };
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

  const direction = centOffset > 0 ? -1 : 1;
  const targetRow = noteRows[rowIndex + direction];

  if (targetRow !== undefined) {
    const targetCenter = targetRow.y + targetRow.height / 2;

    return baseCenter + (targetCenter - baseCenter) * (Math.abs(centOffset) / 100);
  }

  // 악기 범위 끝에서는 이웃 note row 간격을 구할 수 없으므로 현재 row 높이만큼 외삽한다.
  return baseCenter - Math.sign(centOffset) * row.height * (Math.abs(centOffset) / 100);
}

/**
 * note rectangle의 배경과 윤곽선을 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 반환값 : 없음
 */
function drawNoteRectangle(
  context: CanvasRenderingContext2D,
  item: CanvasNoteLayoutItem,
): void {
  context.fillStyle = colorForTrackMidi(item.trackId, item.midi);
  context.strokeStyle =
    item.trackId === TRACK_EXTRA
      ? CANVAS_COLORS.extraNoteStroke
      : CANVAS_COLORS.noteStroke;
  context.lineWidth = 1;
  context.fillRect(item.x, item.y, item.width, item.height);
  context.strokeRect(item.x + 0.5, item.y + 0.5, item.width - 1, item.height - 1);
}

/**
 * note rectangle 안에 표시 문자열을 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : 없음
 */
function drawNoteText(
  context: CanvasRenderingContext2D,
  item: CanvasNoteLayoutItem,
  layout: CanvasScoreLayout,
): void {
  if (item.displayTextAnchors.length === 0) {
    return;
  }

  const fontSize = Math.max(7, 14 * getLayoutZoom(layout));

  context.save();
  context.fillStyle =
    item.trackId === TRACK_EXTRA
      ? CANVAS_COLORS.extraNoteText
      : CANVAS_COLORS.noteText;
  context.font = `700 ${fontSize}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  // 병합된 표시 anchor를 순회하며 각 시간 범위의 중심에 displayText를 그대로 표시한다.
  for (const anchor of item.displayTextAnchors) {
    if (anchor.text === "") {
      continue;
    }

    const textPlacement = getTextAnchorPlacement(item, anchor, layout);

    context.textAlign = textPlacement.align;
    context.fillText(
      anchor.text,
      textPlacement.x,
      item.y + item.height / 2,
    );
  }

  context.restore();
}

/**
 * mute event 텍스트를 셀 중앙에 표시한다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : rowById : layout row 조회 Map
 * - 인수 : item : mute 텍스트 표시 item
 * - 반환값 : 없음
 */
function drawMuteText(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  rowById: Map<string, CanvasLayoutRow>,
  item: CanvasMuteRenderItem,
): void {
  const row = rowById.get(item.rowId);

  if (row === undefined || row.kind !== "note" || item.text === "") {
    return;
  }

  context.save();
  context.fillStyle = CANVAS_COLORS.muteText;
  context.font = `${CANVAS_METRICS.muteTextFontSizePx}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(
    item.text,
    getTickRangeCenterX(item.startTick, item.endTick, layout),
    row.y + row.height / 2,
  );
  context.restore();
}

/**
 * globalLines.cells 원본 문자열을 전역 행 셀 중앙에 표시한다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : rowById : layout row 조회 Map
 * - 인수 : item : 전역 텍스트 표시 item
 * - 반환값 : 없음
 */
function drawGlobalText(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
  rowById: Map<string, CanvasLayoutRow>,
  item: CanvasGlobalTextRenderItem,
): void {
  const row = rowById.get(item.rowId);

  if (row === undefined || row.kind !== "global" || item.text === "") {
    return;
  }

  const fontSize = Math.max(
    8,
    CANVAS_METRICS.globalTextFontSizePx * getLayoutZoom(layout),
  );

  context.save();
  context.fillStyle = CANVAS_COLORS.globalText;
  context.font = `700 ${fontSize}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(
    item.text,
    columnToX(item.col + 0.5, layout),
    row.y + row.height / 2,
  );
  context.restore();
}

/**
 * note effect segment를 note rectangle 위에 그린다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : 없음
 */
function drawNoteEffects(
  context: CanvasRenderingContext2D,
  item: CanvasNoteLayoutItem,
  layout: CanvasScoreLayout,
): void {
  for (const effect of item.effects) {
    const range = effectSegmentToDrawRange(item, layout, effect.startTick, effect.endTick, 0);

    if (range === null) {
      continue;
    }

    if (effect.tremDivision !== null) {
      drawTremChops(context, item, range.x0, range.x1, effect.tremDivision);
    }
  }

  // 연속된 "~" hold segment는 레거시처럼 하나의 사인파로 병합해 draw 호출을 줄인다.
  for (const range of createVibDrawRanges(item, layout)) {
    drawVibWave(context, item, range.x0, range.x1, range.cycleCount);
  }
}

/**
 * effect segment의 tick 범위를 note rectangle 내부 x 좌표 범위로 변환한다.
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : startTick : effect 시작 tick
 * - 인수 : endTick : effect 끝 tick
 * - 반환값 : DrawRange | null : 그릴 수 있는 x 범위 또는 제외 결과
 */
function effectSegmentToDrawRange(
  item: CanvasNoteLayoutItem,
  layout: CanvasScoreLayout,
  startTick: number,
  endTick: number,
  insetX: number = CANVAS_METRICS.noteInsetX,
): DrawRange | null {
  if (item.displayShape === "anchorSquare") {
    if (!rangesOverlap(item.startTick, item.endTick, startTick, endTick)) {
      return null;
    }

    return {
      x0: item.x + insetX,
      x1: item.x + item.width - insetX,
    };
  }

  const x0 = Math.max(item.x, columnToX(startTick, layout) + insetX);
  const x1 = Math.min(item.x + item.width, columnToX(endTick, layout) - insetX);

  if (x1 <= x0) {
    return null;
  }

  return { x0, x1 };
}

/**
 * note effect 목록에서 연속된 vibrato 구간을 하나의 draw range로 병합한다.
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : DrawRange[] : 사인파를 한 번씩 그릴 x 범위 목록
 */
function createVibDrawRanges(
  item: CanvasNoteLayoutItem,
  layout: CanvasScoreLayout,
): VibDrawRange[] {
  const ranges: VibDrawRange[] = [];
  let activeStartTick: number | null = null;
  let activeEndTick: number | null = null;

  // effect segment를 시간 순서로 훑으며 맞닿아 있는 vib 구간만 하나로 합친다.
  for (const effect of item.effects) {
    if (!effect.vib) {
      if (activeStartTick !== null && activeEndTick !== null) {
        pushVibDrawRange(ranges, item, layout, activeStartTick, activeEndTick);
        activeStartTick = null;
        activeEndTick = null;
      }

      continue;
    }

    if (activeStartTick === null || activeEndTick === null) {
      activeStartTick = effect.startTick;
      activeEndTick = effect.endTick;
      continue;
    }

    if (effect.startTick === activeEndTick) {
      activeEndTick = effect.endTick;
      continue;
    }

    pushVibDrawRange(ranges, item, layout, activeStartTick, activeEndTick);
    activeStartTick = effect.startTick;
    activeEndTick = effect.endTick;
  }

  if (activeStartTick !== null && activeEndTick !== null) {
    pushVibDrawRange(ranges, item, layout, activeStartTick, activeEndTick);
  }

  return ranges;
}

/**
 * tick 기준 vibrato 구간을 x 좌표 범위로 변환해 목록에 추가한다.
 * - 인수 : ranges : 누적할 draw range 목록
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : startTick : 병합된 vibrato 시작 tick
 * - 인수 : endTick : 병합된 vibrato 끝 tick
 * - 반환값 : 없음
 */
function pushVibDrawRange(
  ranges: VibDrawRange[],
  item: CanvasNoteLayoutItem,
  layout: CanvasScoreLayout,
  startTick: number,
  endTick: number,
): void {
  const range = effectSegmentToDrawRange(item, layout, startTick, endTick);

  if (range !== null) {
    ranges.push({
      ...range,
      cycleCount: Math.max(1, endTick - startTick),
    });
  }
}

/**
 * tremolo effect를 note rectangle 내부의 chop line으로 표시한다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 인수 : x0 : effect segment 시작 x 좌표
 * - 인수 : x1 : effect segment 끝 x 좌표
 * - 인수 : division : tremolo 분할 수
 * - 반환값 : 없음
 */
function drawTremChops(
  context: CanvasRenderingContext2D,
  item: CanvasNoteLayoutItem,
  x0: number,
  x1: number,
  division: number,
): void {
  if (division < 2) {
    return;
  }

  context.save();
  context.strokeStyle = CANVAS_COLORS.rollBackground;
  context.lineWidth = CANVAS_METRICS.tremoloChopLineWidth;

  // segment 시작/끝과 division 경계 모두에 세로 chop line을 그려 셀 연결부도 끊어 보이게 한다.
  for (let index = 0; index <= division; index += 1) {
    const x = x0 + ((x1 - x0) * index) / division;

    context.beginPath();
    context.moveTo(x + 0.5, item.y);
    context.lineTo(x + 0.5, item.y + item.height);
    context.stroke();
  }

  context.restore();
}

/**
 * vibrato hold를 note rectangle 내부의 sine wave로 표시한다.
 * - 인수 : context : note layer canvas 2D context
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 인수 : x0 : wave 시작 x 좌표
 * - 인수 : x1 : wave 끝 x 좌표
 * - 반환값 : 없음
 */
function drawVibWave(
  context: CanvasRenderingContext2D,
  item: CanvasNoteLayoutItem,
  x0: number,
  x1: number,
  cycleCount: number,
): void {
  const width = x1 - x0;
  const yCenter = alignStrokeCoordinate(item.y + item.height / 2);
  const amplitude = Math.max(2, item.height * 0.22);
  const sampleCount = getVibWaveSampleCount(width, cycleCount);
  const startX = alignStrokeCoordinate(x0);
  const endX = alignStrokeCoordinate(x1);

  context.save();
  context.strokeStyle = item.trackId === TRACK_EXTRA
    ? CANVAS_COLORS.extraVibWave
    : CANVAS_COLORS.vibWave;
  context.lineWidth = 1;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();

  for (let step = 0; step <= sampleCount; step += 1) {
    const progress = step / sampleCount;
    const x = startX + (endX - startX) * progress;
    const y = yCenter + Math.sin(progress * Math.PI * 2 * cycleCount) * amplitude;

    if (step === 0) {
      context.moveTo(x, yCenter);
    } else if (step === sampleCount) {
      context.lineTo(x, yCenter);
    } else {
      context.lineTo(x, y);
    }
  }

  context.stroke();
  context.restore();
}

/**
 * vibrato 사인파를 그릴 샘플 수를 계산한다.
 * - 인수 : width : 사인파를 그릴 x 좌표 폭
 * - 인수 : cycleCount : 사인파 주기 수
 * - 반환값 : 구간 길이와 주기 수를 반영한 샘플 개수
 */
function getVibWaveSampleCount(width: number, cycleCount: number): number {
  const byCycle = Math.ceil(cycleCount * CANVAS_METRICS.vibWaveSamplesPerCycle);
  const byPixel = Math.ceil(Math.max(0, width) / CANVAS_METRICS.vibWavePixelsPerSample);

  return Math.max(
    CANVAS_METRICS.vibWaveMinSampleCount,
    byCycle,
    byPixel,
  );
}

/**
 * 얇은 stroke가 canvas pixel grid에서 덜 흔들리도록 좌표를 보정한다.
 * - 인수 : value : 원래 CSS pixel 좌표
 * - 반환값 : 1px stroke에 맞춘 반 픽셀 정렬 좌표
 */
function alignStrokeCoordinate(value: number): number {
  return Math.round(value) + 0.5;
}

/**
 * 표시 텍스트 anchor의 x 좌표와 정렬 방식을 계산한다.
 * - 인수 : item : CSS pixel 좌표가 확정된 note item
 * - 인수 : anchor : 표시 텍스트 anchor
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : 텍스트를 배치할 x 좌표와 canvas textAlign 값
 */
function getTextAnchorPlacement(
  item: CanvasNoteLayoutItem,
  anchor: CanvasNoteLayoutItem["displayTextAnchors"][number],
  layout: CanvasScoreLayout,
): { x: number; align: CanvasTextAlign } {
  if (item.displayShape === "anchorSquare") {
    return {
      x: item.x + item.width / 2,
      align: "center",
    };
  }

  if (isLongTupletSlotTextAnchor(anchor)) {
    return {
      x: columnToX(anchor.startTick, layout),
      align: "left",
    };
  }

  return {
    x: getTickRangeCenterX(anchor.startTick, anchor.endTick, layout),
    align: "center",
  };
}

/**
 * tuplet slot 텍스트가 1 tick을 넘는 긴 직사각형 안에 표시되는지 확인한다.
 * - 인수 : anchor : 표시 텍스트 anchor
 * - 반환값 : 왼쪽 고정 정렬 대상 여부
 */
function isLongTupletSlotTextAnchor(
  anchor: CanvasNoteLayoutItem["displayTextAnchors"][number],
): boolean {
  return anchor.sourceSlotIndex !== undefined && anchor.endTick - anchor.startTick > 1;
}

/**
 * tick 범위의 중심 x 좌표를 계산한다.
 * - 인수 : startTick : 범위 시작 tick
 * - 인수 : endTick : 범위 끝 tick
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : number : 중심 x 좌표
 */
function getTickRangeCenterX(
  startTick: number,
  endTick: number,
  layout: CanvasScoreLayout,
): number {
  return (columnToX(startTick, layout) + columnToX(endTick, layout)) / 2;
}

/**
 * 두 배타적 tick 범위가 겹치는지 확인한다.
 * - 인수 : leftStart : 첫 범위 시작 tick
 * - 인수 : leftEnd : 첫 범위 배타적 끝 tick
 * - 인수 : rightStart : 둘째 범위 시작 tick
 * - 인수 : rightEnd : 둘째 범위 배타적 끝 tick
 * - 반환값 : 두 범위에 공통 구간이 있는지 여부
 */
function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

/**
 * layout font size에서 현재 layout zoom을 계산한다.
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : number : 기준 font size 대비 확대 배율
 */
function getLayoutZoom(layout: CanvasScoreLayout): number {
  return layout.layoutFontSize / 12;
}

/**
 * trackId와 midi에 맞는 legacy note fill 색상을 반환한다.
 * - 인수 : trackId : note가 속한 track id
 * - 인수 : midi : note 발음 midi 번호
 * - 반환값 : string : canvas fillStyle에 사용할 CSS 색상
 */
function colorForTrackMidi(trackId: string | undefined, midi: number): string {
  if (trackId === TRACK_EXTRA) {
    return CANVAS_COLORS.extraNoteFill;
  }

  if (trackId === TRACK_OPTIONAL) {
    return colorForOptionalMidi(midi);
  }

  return colorForBasicMidi(midi);
}

/**
 * renderer 내부 effect draw x 좌표 범위.
 */
type DrawRange = {
  x0: number;
  x1: number;
};

/**
 * renderer 내부 vibrato draw x 좌표 범위와 사인파 주기 수.
 */
type VibDrawRange = DrawRange & {
  cycleCount: number;
};
