/**
 * layout label canvas와 score base canvas의 grid/background를 그린다.
 */

import { columnToX } from "./canvas_coordinate";
import { colorForLabelMidi } from "./canvas_note_colors";
import { CANVAS_COLORS } from "./canvas_theme";
import type { CanvasScoreLayout } from "./canvas_types";

/**
 * layout label 영역의 row background, label, playback boundary 표시를 그린다.
 * - 인수 : context : layout canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : 없음
 */
export function drawLayoutGrid(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
): void {
  // layout label canvas 전체를 지운 뒤 기본 배경색으로 채운다.
  context.clearRect(0, 0, layout.layoutWidth, layout.stageHeight);
  context.fillStyle = CANVAS_COLORS.rollBackground;
  context.fillRect(0, 0, layout.layoutWidth, layout.stageHeight);
  context.font = `700 ${layout.layoutFontSize}px Arial, sans-serif`;
  context.textBaseline = "middle";

  // layout rows를 순회하며 note row 배경, row 경계선, label 문자열을 그린다.
  for (const row of layout.rows) {
    if (row.kind === "note") {
      context.fillStyle = row.midi === undefined
        ? CANVAS_COLORS.noteRowBackground
        : colorForLabelMidi(row.midi);
      context.fillRect(
        getLayoutLabelStartX(layout),
        row.y,
        layout.layoutLabelWidth,
        row.height,
      );
    }

    context.strokeStyle = CANVAS_COLORS.labelLine;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, row.y + row.height + 0.5);
    context.lineTo(layout.layoutWidth, row.y + row.height + 0.5);
    context.stroke();

    if (row.label !== "") {
      if (row.kind === "note") {
        context.fillStyle = CANVAS_COLORS.noteLabelText;
        context.textAlign = "center";
        context.fillText(row.label, getLayoutLabelCenterX(layout), row.y + row.height / 2);
      } else {
        context.fillStyle = CANVAS_COLORS.labelText;
        context.textAlign = "left";
        context.fillText(
          row.label,
          layout.layoutLeftPaddingWidth + 10 * getLayoutZoom(layout),
          row.y + row.height / 2,
        );
      }
    }
  }

  // layout 좌우 여백을 별도 칸으로 취급하여 라벨 영역과 구분되는 세로선을 그린다.
  drawLayoutPaddingColumnLines(context, layout);

  // playback 기준 시각화는 오른쪽 여백 칸 내부에 반투명 배경으로만 표시한다.
  if (layout.layoutRightPaddingWidth > 0) {
    const overlayWidth = layout.layoutRightPaddingWidth / 2;
    context.fillStyle = CANVAS_COLORS.playbackBoundary;
    context.fillRect(
      layout.layoutWidth - overlayWidth,
      0,
      overlayWidth,
      layout.stageHeight,
    );
  }
}

/**
 * 좌측 여백을 제외한 라벨 영역 시작 x 좌표를 계산한다.
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : number : 라벨 열 시작 x 좌표
 */
function getLayoutLabelStartX(layout: CanvasScoreLayout): number {
  return layout.layoutLeftPaddingWidth;
}

/**
 * layout label 영역 안에서 좌우 여백 칸을 구분하는 세로선을 그린다.
 * - 인수 : context : layout canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : 없음
 */
function drawLayoutPaddingColumnLines(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
): void {
  const leftBoundaryX = layout.layoutLeftPaddingWidth;
  const rightBoundaryX = layout.layoutWidth - layout.layoutRightPaddingWidth;

  context.strokeStyle = CANVAS_COLORS.labelLine;
  context.lineWidth = 1;

  // 왼쪽 여백 칸과 라벨 영역 사이의 윤곽선을 그린다.
  context.beginPath();
  context.moveTo(leftBoundaryX + 0.5, 0);
  context.lineTo(leftBoundaryX + 0.5, layout.stageHeight);
  context.stroke();

  // 라벨 영역과 오른쪽 여백 칸 사이의 윤곽선을 그린다.
  context.beginPath();
  context.moveTo(rightBoundaryX + 0.5, 0);
  context.lineTo(rightBoundaryX + 0.5, layout.stageHeight);
  context.stroke();
}

/**
 * 좌우 여백을 제외한 라벨 영역의 중앙 x 좌표를 계산한다.
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : number : note row label 가운데 정렬에 사용할 x 좌표
 */
function getLayoutLabelCenterX(layout: CanvasScoreLayout): number {
  return layout.layoutLeftPaddingWidth + layout.layoutLabelWidth / 2;
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
 * score base 영역의 row background와 column/row grid를 그린다.
 * - 인수 : context : base canvas 2D context
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 반환값 : 없음
 */
export function drawScoreGrid(
  context: CanvasRenderingContext2D,
  layout: CanvasScoreLayout,
): void {
  // score base canvas 전체를 지운 뒤 기본 배경색으로 채운다.
  context.clearRect(0, 0, layout.stageWidth, layout.stageHeight);
  context.fillStyle = CANVAS_COLORS.rollBackground;
  context.fillRect(0, 0, layout.stageWidth, layout.stageHeight);

  for (const row of layout.rows) {
    if (row.kind === "note") {
      context.fillStyle = CANVAS_COLORS.noteRowBackground;
      context.fillRect(0, row.y, layout.stageWidth, row.height);
    }
  }

  context.lineWidth = 1;

  // column index를 x 좌표로 변환해 세로 grid line을 그린다.
  for (let column = 0; column <= layout.columnCount; column += 1) {
    const x = columnToX(column, layout);
    context.strokeStyle = CANVAS_COLORS.gridVertical;
    context.beginPath();
    context.moveTo(x + 0.5, 0);
    context.lineTo(x + 0.5, layout.stageHeight);
    context.stroke();
  }

  for (const row of layout.rows) {
    context.strokeStyle = CANVAS_COLORS.gridSoft;
    context.beginPath();
    context.moveTo(0, row.y + row.height + 0.5);
    context.lineTo(layout.stageWidth, row.y + row.height + 0.5);
    context.stroke();
  }
}
