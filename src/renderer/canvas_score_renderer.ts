/**
 * canvas score renderer의 public 진입점이다.
 */

import {
  buildCanvasScoreLayout,
  resizeCanvasLayer,
  resizeCanvasLayerToDynamicViewport,
  resizeCanvasLayers,
} from "./canvas_coordinate";
import {
  drawLayoutGrid,
  drawScoreColumnGridInRange,
  drawScoreGrid,
  drawScoreStaticRowBackground,
} from "./canvas_grid_renderer";
import {
  drawScoreMarkers,
  drawScoreOverlayMarkersInRange,
  drawScoreOverlayMarkers,
} from "./canvas_marker_renderer";
import {
  drawScoreNotesInRange,
  drawScoreGlobalTexts,
  drawScoreNotes,
} from "./canvas_note_renderer";
import type {
  CanvasAnalyzedRenderInput,
  CanvasDirtyTickRange,
  CanvasGlobalTextRenderItem,
  CanvasMarkerItem,
  CanvasMuteRenderItem,
  CanvasRedrawScope,
  CanvasRenderInput,
  CanvasRenderOptions,
  CanvasRenderResult,
  CanvasRenderTarget,
  CanvasNoteRenderItem,
} from "./canvas_types";
import { createCanvasVisibleTickRange } from "./canvas_viewport";
import {
  filterVisibleGlobalTextItems,
  filterVisibleMarkerItems,
  filterVisibleMuteItems,
  filterVisibleNoteItems,
} from "./canvas_visible_range";

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
  const globalMarkerItems = getGlobalMarkerItems(input);
  const noteMarkerItems = getNoteMarkerItems(input);

  if (options.dynamicViewport !== undefined) {
    const viewportRange = createCanvasVisibleTickRange(layout, options.dynamicViewport);
    const dpr = Number.isFinite(options.devicePixelRatio) && options.devicePixelRatio > 0
      ? options.devicePixelRatio
      : 1;

    resizeCanvasLayersToDynamicViewport(target, layout, options.dynamicViewport, dpr);
    drawLayoutGrid(target.layout.context, layout);
    drawScoreStaticRowBackground(target.base.context, layout, viewportRange);
    drawScoreColumnGridInRange(target.marker.context, layout, viewportRange);
    drawScoreMarkers(
      target.marker.context,
      layout,
      filterVisibleMarkerItems(globalMarkerItems, viewportRange),
      { preserveExisting: true },
    );
    drawScoreMarkers(
      target.noteMarker.context,
      layout,
      filterVisibleMarkerItems(noteMarkerItems, viewportRange),
    );
    drawScoreNotes(
      target.note.context,
      layout,
      filterVisibleNoteItems(noteItems, viewportRange),
      filterVisibleMuteItems(muteItems, viewportRange),
      filterVisibleGlobalTextItems(globalTextItems, viewportRange),
    );
    drawScoreOverlayMarkers(
      target.note.context,
      layout,
      filterVisibleMarkerItems(noteMarkerItems, viewportRange),
    );

    return {
      layout,
    };
  }

  resizeCanvasLayers(target, layout, options);
  drawLayoutGrid(target.layout.context, layout);
  drawScoreGrid(target.base.context, layout);
  drawScoreMarkers(target.marker.context, layout, globalMarkerItems);
  drawScoreMarkers(target.noteMarker.context, layout, noteMarkerItems);
  drawScoreNotes(target.note.context, layout, noteItems, muteItems, globalTextItems);
  drawScoreOverlayMarkers(target.note.context, layout, noteMarkerItems);

  return {
    layout,
  };
}

/**
 * 기존 base/layout layer를 유지하고 편집 영향이 있는 동적 layer만 다시 그린다.
 * - 인수 : target : layout/base/note/marker canvas target
 * - 인수 : input : renderer 전용 입력 DTO
 * - 인수 : options : UI 표시 옵션
 * - 인수 : scope : 다시 그릴 동적 layer 범위
 * - 인수 : previousLayout : 직전 full render에서 계산된 layout
 * - 반환값 : 렌더 결과 metadata
 */
export function renderCanvasScorePartial(
  target: CanvasRenderTarget,
  input: CanvasRenderInput | CanvasAnalyzedRenderInput,
  options: CanvasRenderOptions,
  scope: Exclude<CanvasRedrawScope, "all">,
  previousLayout: CanvasRenderResult["layout"],
  dirtyTickRange?: CanvasDirtyTickRange | null,
): CanvasRenderResult {
  const layout = buildCanvasScoreLayout(input, options);

  if (!canReuseCanvasLayerSizes(previousLayout, layout)) {
    return renderCanvasScore(target, input, options);
  }

  const noteItems = getNoteItems(input);
  const muteItems = getMuteItems(input);
  const globalTextItems = getGlobalTextItems(input);
  const globalMarkerItems = getGlobalMarkerItems(input);
  const noteMarkerItems = getNoteMarkerItems(input);

  if (options.dynamicViewport !== undefined && scope === "note") {
    const dpr = Number.isFinite(options.devicePixelRatio) && options.devicePixelRatio > 0
      ? options.devicePixelRatio
      : 1;
    const viewportRange = createCanvasVisibleTickRange(layout, options.dynamicViewport);
    const baseResize = resizeCanvasLayerToDynamicViewport(
      target.base,
      layout,
      options.dynamicViewport,
      dpr,
    );
    resizeCanvasLayerToDynamicViewport(
      target.marker,
      layout,
      options.dynamicViewport,
      dpr,
    );
    resizeCanvasLayerToDynamicViewport(
      target.note,
      layout,
      options.dynamicViewport,
      dpr,
    );
    resizeCanvasLayerToDynamicViewport(
      target.noteMarker,
      layout,
      options.dynamicViewport,
      dpr,
    );

    if (baseResize.didResize) {
      drawScoreStaticRowBackground(target.base.context, layout, viewportRange);
    }

    drawScoreColumnGridInRange(target.marker.context, layout, viewportRange);
    drawScoreMarkers(
      target.marker.context,
      layout,
      filterVisibleMarkerItems(globalMarkerItems, viewportRange),
      { preserveExisting: true },
    );
    drawScoreMarkers(
      target.noteMarker.context,
      layout,
      filterVisibleMarkerItems(noteMarkerItems, viewportRange),
    );
    drawScoreNotes(
      target.note.context,
      layout,
      filterVisibleNoteItems(noteItems, viewportRange),
      filterVisibleMuteItems(muteItems, viewportRange),
      filterVisibleGlobalTextItems(globalTextItems, viewportRange),
    );
    drawScoreOverlayMarkers(
      target.note.context,
      layout,
      filterVisibleMarkerItems(noteMarkerItems, viewportRange),
    );

    return {
      layout,
    };
  }

  if (options.dynamicViewport !== undefined && scope === "global") {
    const dpr = Number.isFinite(options.devicePixelRatio) && options.devicePixelRatio > 0
      ? options.devicePixelRatio
      : 1;
    const viewportRange = createCanvasVisibleTickRange(layout, options.dynamicViewport);
    const baseResize = resizeCanvasLayerToDynamicViewport(
      target.base,
      layout,
      options.dynamicViewport,
      dpr,
    );
    resizeCanvasLayerToDynamicViewport(
      target.marker,
      layout,
      options.dynamicViewport,
      dpr,
    );
    resizeCanvasLayerToDynamicViewport(
      target.note,
      layout,
      options.dynamicViewport,
      dpr,
    );

    if (baseResize.didResize) {
      drawScoreStaticRowBackground(target.base.context, layout, viewportRange);
    }

    drawScoreColumnGridInRange(target.marker.context, layout, viewportRange);
    drawScoreMarkers(
      target.marker.context,
      layout,
      filterVisibleMarkerItems(globalMarkerItems, viewportRange),
      { preserveExisting: true },
    );
    drawScoreNotes(
      target.note.context,
      layout,
      filterVisibleNoteItems(noteItems, viewportRange),
      filterVisibleMuteItems(muteItems, viewportRange),
      filterVisibleGlobalTextItems(globalTextItems, viewportRange),
    );
    drawScoreOverlayMarkers(
      target.note.context,
      layout,
      filterVisibleMarkerItems(noteMarkerItems, viewportRange),
    );

    return {
      layout,
    };
  }

  if (scope === "note") {
    if (dirtyTickRange === null || dirtyTickRange === undefined) {
      drawScoreMarkers(target.noteMarker.context, layout, noteMarkerItems);
      drawScoreNotes(target.note.context, layout, noteItems, muteItems, globalTextItems);
      drawScoreOverlayMarkers(target.note.context, layout, noteMarkerItems);
    } else {
      // gliss 연결선은 endpoint 편집만으로도 전체 기울기가 바뀌므로 note marker layer는 전체를 다시 그린다.
      drawScoreMarkers(target.noteMarker.context, layout, noteMarkerItems);
      drawScoreNotesInRange(target.note.context, layout, noteItems, muteItems, dirtyTickRange);
      drawScoreOverlayMarkersInRange(target.note.context, layout, noteMarkerItems, dirtyTickRange);
    }
  } else {
    drawScoreMarkers(target.marker.context, layout, globalMarkerItems);
    drawScoreGlobalTexts(target.note.context, layout, globalTextItems);
  }

  return {
    layout,
  };
}

/**
 * score 영역 canvas layer들을 현재 viewport 폭과 overscan에 맞춰 조정한다.
 * - 인수 : target : renderer canvas target 묶음
 * - 인수 : layout : CSS pixel 기준 score layout
 * - 인수 : viewport : 현재 score scroll viewport
 * - 인수 : dpr : canvas bitmap 해상도 보정값
 * - 반환값 : 없음
 */
function resizeCanvasLayersToDynamicViewport(
  target: CanvasRenderTarget,
  layout: CanvasRenderResult["layout"],
  viewport: NonNullable<CanvasRenderOptions["dynamicViewport"]>,
  dpr: number,
): void {
  resizeCanvasLayer(target.layout, layout.layoutWidth, layout.stageHeight, dpr);
  resizeCanvasLayerToDynamicViewport(target.base, layout, viewport, dpr);
  resizeCanvasLayerToDynamicViewport(target.marker, layout, viewport, dpr);
  resizeCanvasLayerToDynamicViewport(target.note, layout, viewport, dpr);
  resizeCanvasLayerToDynamicViewport(target.noteMarker, layout, viewport, dpr);
}

/**
 * 기존 canvas bitmap과 base/layout draw를 재사용해도 되는지 확인한다.
 * - 인수 : previousLayout : 직전 renderer layout
 * - 인수 : nextLayout : 다음 renderer layout
 * - 반환값 : 동적 layer만 다시 그려도 되는 같은 좌표계인지 여부
 */
function canReuseCanvasLayerSizes(
  previousLayout: CanvasRenderResult["layout"],
  nextLayout: CanvasRenderResult["layout"],
): boolean {
  return previousLayout.stageWidth === nextLayout.stageWidth &&
    previousLayout.stageHeight === nextLayout.stageHeight &&
    previousLayout.layoutWidth === nextLayout.layoutWidth &&
    previousLayout.columnWidth === nextLayout.columnWidth &&
    previousLayout.rows.length === nextLayout.rows.length &&
    previousLayout.rows.every((row, index) => {
      const nextRow = nextLayout.rows[index];

      return nextRow !== undefined &&
        row.rowId === nextRow.rowId &&
        row.kind === nextRow.kind &&
        row.y === nextRow.y &&
        row.height === nextRow.height;
    });
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

/**
 * renderer 입력에서 global marker item 목록을 꺼낸다.
 * - 인수 : input : renderer 입력
 * - 반환값 : CanvasMarkerItem[] : global marker layer가 그릴 item 목록
 */
function getGlobalMarkerItems(
  input: CanvasRenderInput | CanvasAnalyzedRenderInput,
): CanvasMarkerItem[] {
  if ("globalMarkerItems" in input) {
    return input.globalMarkerItems;
  }

  return getMarkerItems(input);
}

/**
 * renderer 입력에서 note marker item 목록을 꺼낸다.
 * - 인수 : input : renderer 입력
 * - 반환값 : CanvasMarkerItem[] : note marker layer가 그릴 item 목록
 */
function getNoteMarkerItems(
  input: CanvasRenderInput | CanvasAnalyzedRenderInput,
): CanvasMarkerItem[] {
  if ("noteMarkerItems" in input) {
    return input.noteMarkerItems;
  }

  return [];
}
