/** 전체 생성과 부분 병합이 공유하는 Canvas item 그리기 순서. */
import type { CanvasMarkerItem, CanvasNoteRenderItem, CanvasMuteRenderItem } from "./canvas_types";
import { getTrackDrawOrder } from "../track/track_control";

/**
 * note/mute 배열을 시간, 행, track 순서로 안정 정렬한다.
 * - 인수 : items : 호출자가 소유한 새 배열
 * - 반환값 : 입력 배열을 정렬한 결과
 */
export function sortCanvasTrackItems<T extends CanvasNoteRenderItem | CanvasMuteRenderItem>(items: T[]): T[] {
  return items.sort((left, right) => {
    if (left.startTick !== right.startTick) {
      return left.startTick - right.startTick;
    }
    if (left.rowId !== right.rowId) {
      return left.rowId.localeCompare(right.rowId);
    }
    return getTrackDrawOrder(left.trackId) - getTrackDrawOrder(right.trackId);
  });
}

/**
 * marker item 목록을 시간, 행, track 순서로 안정 정렬한다.
 * - 인수 : items : 정렬할 marker item 목록
 * - 반환값 : 새 배열이 아닌 입력 배열을 정렬한 결과
 */
export function sortCanvasMarkerItems(items: CanvasMarkerItem[]): CanvasMarkerItem[] {
  return items.sort((left, right) => {
    const leftTick = getMarkerSortTick(left);
    const rightTick = getMarkerSortTick(right);

    if (leftTick !== rightTick) {
      return leftTick - rightTick;
    }

    const leftRowId = getMarkerSortRowId(left);
    const rightRowId = getMarkerSortRowId(right);

    if (leftRowId !== rightRowId) {
      return leftRowId.localeCompare(rightRowId);
    }
    return getTrackDrawOrder(getMarkerSortTrackId(left)) -
      getTrackDrawOrder(getMarkerSortTrackId(right));
  });
}

/**
 * marker item의 정렬 tick을 가져온다.
 * - 인수 : item : 정렬 대상 marker item
 * - 반환값 : number : marker 시간 순서 기준 tick
 */
function getMarkerSortTick(item: CanvasMarkerItem): number {
  if (item.kind === "gliss") {
    return item.startTick;
  }

  if (item.kind === "dynamicsGuide") {
    return item.startTick;
  }

  if (item.kind === "glissOrphanAnchor") {
    return item.tick;
  }

  if (item.kind === "tupletContainer") {
    return item.startTick;
  }

  return item.tick;
}

/**
 * marker item의 정렬 rowId를 가져온다.
 * - 인수 : item : 정렬 대상 marker item
 * - 반환값 : string : marker 행 순서 fallback 기준 rowId
 */
function getMarkerSortRowId(item: CanvasMarkerItem): string {
  if (item.kind === "gliss") {
    return item.startRowId;
  }

  if (item.kind === "dynamicsGuide") {
    return item.rowId;
  }

  if (item.kind === "glissOrphanAnchor") {
    return item.rowId;
  }

  if (item.kind === "tupletContainer") {
    return item.rowId;
  }

  return "";
}

/**
 * marker item의 정렬 trackId를 가져온다.
 * - 인수 : item : 정렬 대상 marker item
 * - 반환값 : string : marker track 순서 fallback 기준 trackId
 */
function getMarkerSortTrackId(item: CanvasMarkerItem): string {
  if (
    item.kind === "gliss" ||
    item.kind === "glissOrphanAnchor" ||
    item.kind === "tupletContainer"
  ) {
    return item.trackId ?? "";
  }

  return "";
}

