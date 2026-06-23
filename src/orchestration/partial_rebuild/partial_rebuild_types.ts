/**
 * partial rebuild planner가 renderer/audio 갱신 범위를 표현하는 타입을 정의한다.
 */

import type { AnalyzedEventDiffEntry } from "../../core/analyze/event_diff";
import type { CanvasDirtyTickRange, CanvasRedrawScope } from "../../renderer/canvas_types";

/** partial rebuild planner가 받는 편집 종류. */
export type PartialRebuildEditKind =
  | "noteCell"
  | "globalCell"
  | "mixedCell"
  | "structure";

/** renderer 쪽에서 다시 계산하거나 다시 그릴 논리 그룹. */
export type RendererInvalidationGroup =
  | "noteItems"
  | "muteItems"
  | "noteMarkers"
  | "globalTextItems"
  | "globalMarkers"
  | "layoutBase";

/** audio 쪽에서 다시 계산할 범위. */
export type AudioInvalidationScope =
  | "none"
  | "fullSchedule"
  | "eventSet";

/** renderer 갱신 계획. */
export type RendererInvalidationPlan = {
  redrawScope: CanvasRedrawScope;
  groups: RendererInvalidationGroup[];
  changedEventIds: string[];
  dirtyTickRange: CanvasDirtyTickRange | null;
};

/** audio 갱신 계획. */
export type AudioInvalidationPlan = {
  scope: AudioInvalidationScope;
  changedEventIds: string[];
};

/** partial rebuild가 아직 좁게 처리할 수 없어 fallback해야 하는 범위. */
export type PartialRebuildFallbackKind =
  | "none"
  | "fullRender"
  | "fullRuntime";

/** renderer/audio 양쪽에 적용할 partial rebuild 판단 결과. */
export type PartialRebuildPlan = {
  editKind: PartialRebuildEditKind;
  renderer: RendererInvalidationPlan;
  audio: AudioInvalidationPlan;
  fallback: PartialRebuildFallbackKind;
  eventDiff: {
    added: AnalyzedEventDiffEntry[];
    removed: AnalyzedEventDiffEntry[];
    changed: AnalyzedEventDiffEntry[];
    unchanged: AnalyzedEventDiffEntry[];
    duplicateEventIds: string[];
  };
};
