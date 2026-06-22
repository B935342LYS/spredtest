/**
 * canvas score renderer의 public 진입점이다.
 */

import {
  buildCanvasScoreLayout,
  resizeCanvasLayers,
} from "./canvas_coordinate";
import { drawLayoutGrid, drawScoreGrid } from "./canvas_grid_renderer";
import {
  drawScoreMarkers,
  drawScoreOverlayMarkers,
} from "./canvas_marker_renderer";
import { drawScoreNotes } from "./canvas_note_renderer";
import type {
  CanvasAnalyzedRenderInput,
  CanvasGlobalTextRenderItem,
  CanvasMarkerItem,
  CanvasMuteRenderItem,
  CanvasRenderInput,
  CanvasRenderOptions,
  CanvasRenderResult,
  CanvasRenderTarget,
  CanvasNoteRenderItem,
} from "./canvas_types";

/**
 * CanvasRenderInput을 실제 canvas layer에 그린다.
 * - 인수 : target : layout/base/note/marker canvas target
 * - 인수 : input : renderer 전용 입력 DTO
 * - 인수 : options : UI 표시 옵션
 * - 반환값 : 렌더 결과 metadata
 */
export function renderCanvasScore(
  target: CanvasRenderTarget,
  input: CanvasRenderInput | CanvasAnalyzedRenderInput,
  options: CanvasRenderOptions,
): CanvasRenderResult {
  const layout = buildCanvasScoreLayout(input, options);
  const noteItems = getNoteItems(input);
  const muteItems = getMuteItems(input);
  const globalTextItems = getGlobalTextItems(input);
  const markerItems = getMarkerItems(input);

  resizeCanvasLayers(target, layout, options);
  drawLayoutGrid(target.layout.context, layout);
  drawScoreGrid(target.base.context, layout);
  drawScoreMarkers(target.marker.context, layout, markerItems);
  drawScoreNotes(target.note.context, layout, noteItems, muteItems, globalTextItems);
  drawScoreOverlayMarkers(target.note.context, layout, markerItems);

  return {
    layout,
  };
}

/**
 * renderer 입력에서 global text item 목록을 꺼낸다.
 * - 인수 : input : base-only 또는 analyzer 연결 renderer 입력
 * - 반환값 : CanvasGlobalTextRenderItem[] : note layer가 그릴 전역 텍스트 item 목록
 */
function getGlobalTextItems(
  input: CanvasRenderInput | CanvasAnalyzedRenderInput,
): CanvasGlobalTextRenderItem[] {
  if ("globalTextItems" in input) {
    return input.globalTextItems;
  }

  return [];
}

/**
 * renderer 입력에서 mute item 목록을 꺼낸다.
 * - 인수 : input : base-only 또는 analyzer 연결 renderer 입력
 * - 반환값 : CanvasMuteRenderItem[] : note layer가 텍스트로 그릴 item 목록
 */
function getMuteItems(
  input: CanvasRenderInput | CanvasAnalyzedRenderInput,
): CanvasMuteRenderItem[] {
  if ("muteItems" in input) {
    return input.muteItems;
  }

  return [];
}

/**
 * renderer 입력에서 note item 목록을 꺼낸다.
 * - 인수 : input : base-only 또는 analyzer 연결 renderer 입력
 * - 반환값 : CanvasNoteRenderItem[] : note layer가 그릴 item 목록
 */
function getNoteItems(
  input: CanvasRenderInput | CanvasAnalyzedRenderInput,
): CanvasNoteRenderItem[] {
  if ("noteItems" in input) {
    return input.noteItems;
  }

  return [];
}

/**
 * renderer 입력에서 marker item 목록을 꺼낸다.
 * - 인수 : input : base-only 또는 analyzer 연결 renderer 입력
 * - 반환값 : CanvasMarkerItem[] : marker layer가 그릴 item 목록
 */
function getMarkerItems(
  input: CanvasRenderInput | CanvasAnalyzedRenderInput,
): CanvasMarkerItem[] {
  if ("markerItems" in input) {
    return input.markerItems;
  }

  return [];
}
