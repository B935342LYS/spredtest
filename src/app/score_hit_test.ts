/**
 * renderer layout 좌표를 score cell 선택 좌표로 변환한다.
 */

import type {
  CanvasLayoutRow,
  CanvasScoreLayout,
} from "../renderer/canvas_types";
import type { ScoreHit } from "./app_types";

/**
 * score hit test의 note row 근접 보정 옵션.
 * - 인수 : 없음
 * - 반환값 : gap/무효 row에서 가까운 note row를 선택할지 결정하는 옵션
 */
export type ScoreHitTestOptions = {
  nearestNoteSlopPx?: number;
};

/**
 * score click 좌표를 renderer layout 기준 score cell 좌표로 변환한다.
 * - 인수 : event : score canvas stage에서 발생한 pointer event
 * - 인수 : stage : score canvas stage DOM 요소
 * - 인수 : layout : 마지막 renderer 호출이 계산한 score layout
 * - 인수 : options : note row 근접 보정 옵션
 * - 반환값 : score 좌표 hit, 범위 밖이면 null
 */
export function hitTestScoreCell(
  event: MouseEvent,
  stage: HTMLElement,
  layout: CanvasScoreLayout,
  options: ScoreHitTestOptions = {},
): ScoreHit | null {

  // viewport 기준 pointer 좌표에서 stage의 viewport 기준 위치를 빼 score stage 내부 좌표를 계산한다.
  const rect = stage.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  // column width로 x 좌표를 나누어 col 인덱스를 계산한다.
  const col = Math.floor(x / layout.columnWidth);

  // column 범위를 벗어난 click은 null을 반환한다.
  if (col < 0 || col >= layout.columnCount) {
    return null;
  }

  // layout의 rows 배열 내부 row 중 범위 내에 클릭 y 좌표를 포함하는 row를 찾는다.
  const row = layout.rows.find(
    (layoutRow) => (layoutRow.y <= y) && (y < layoutRow.y + layoutRow.height),
  );

  // 클릭 y 좌표를 포함하는 row가 note가 아니면 필요할 때 가까운 note row로 보정한다.
  if (row === undefined || row.kind === "gap") {
    const nearestNoteRow = findNearestNoteRow(y, layout, options.nearestNoteSlopPx);

    if (nearestNoteRow !== null) {
      return {
        rowId: nearestNoteRow.rowId,
        rowKind: nearestNoteRow.kind,
        col,
      };
    }
  }

  // 클릭 y 좌표를 포함하는 row가 없으면 null을 반환한다.
  if (row === undefined) {
    return null;
  }

  // stage 내부 좌표에 대응되는 score row/column 정보를 반환한다.
  return {
    rowId: row.rowId,
    rowKind: row.kind,
    col,
  };
}

/**
 * y 좌표에서 허용 거리 안의 가장 가까운 note row를 찾는다.
 * - 인수 : y : score stage 내부 y 좌표
 * - 인수 : layout : 마지막 renderer 호출이 계산한 score layout
 * - 인수 : slopPx : note row로 보정할 최대 거리
 * - 반환값 : 가장 가까운 note row 또는 없음
 */
function findNearestNoteRow(
  y: number,
  layout: CanvasScoreLayout,
  slopPx: number | undefined,
): CanvasLayoutRow | null {
  if (slopPx === undefined || slopPx <= 0) {
    return null;
  }

  let nearestRow: CanvasLayoutRow | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const row of layout.rows) {
    if (row.kind !== "note") {
      continue;
    }

    const rowTop = row.y;
    const rowBottom = row.y + row.height;
    const distance = y < rowTop
      ? rowTop - y
      : y > rowBottom
        ? y - rowBottom
        : 0;

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestRow = row;
    }
  }

  if (nearestRow === null || nearestDistance > slopPx) {
    return null;
  }

  return nearestRow;
}
