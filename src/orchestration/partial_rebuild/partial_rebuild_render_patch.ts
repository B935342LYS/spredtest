/**
 * partial rebuild plan을 renderer 입력 DTO에 적용한다.
 */

import type {
  CanvasAnalyzedRenderInput,
  CanvasMuteRenderItem,
  CanvasNoteRenderItem,
} from "../../renderer/canvas_types";
import type {
  PartialRebuildPlan,
  RendererInvalidationGroup,
} from "./partial_rebuild_types";

/**
 * 이전/다음 renderer 입력과 partial rebuild plan을 합성해 실제 render에 사용할 입력을 만든다.
 * - 인수 : previousInput : 편집 전 renderer 입력
 * - 인수 : nextInput : 편집 후 partial artifact 또는 fallback rebuild로 만든 renderer 입력
 * - 인수 : plan : renderer/audio 갱신 계획
 * - 반환값 : plan이 지시한 item group만 교체한 renderer 입력
 */
export function applyPartialRenderInputPatch(
  previousInput: CanvasAnalyzedRenderInput,
  nextInput: CanvasAnalyzedRenderInput,
  plan: PartialRebuildPlan,
): CanvasAnalyzedRenderInput {
  if (plan.fallback !== "none" || plan.renderer.redrawScope === "all") {
    return nextInput;
  }

  const changedEventIds = new Set(plan.renderer.changedEventIds);
  const groups = new Set(plan.renderer.groups);
  const shouldUseNextMarkers = hasAnyRendererGroup(groups, ["globalMarkers", "noteMarkers"]);

  return {
    ...nextInput,
    noteItems: groups.has("noteItems")
      ? patchSourceEventItems(previousInput.noteItems, nextInput.noteItems, changedEventIds)
      : previousInput.noteItems,
    muteItems: groups.has("muteItems")
      ? patchSourceEventItems(previousInput.muteItems, nextInput.muteItems, changedEventIds)
      : previousInput.muteItems,
    globalTextItems: groups.has("globalTextItems")
      ? nextInput.globalTextItems
      : previousInput.globalTextItems,
    globalMarkerItems: groups.has("globalMarkers")
      ? nextInput.globalMarkerItems
      : previousInput.globalMarkerItems,
    noteMarkerItems: groups.has("noteMarkers")
      ? nextInput.noteMarkerItems
      : previousInput.noteMarkerItems,
    markerItems: shouldUseNextMarkers ? nextInput.markerItems : previousInput.markerItems,
  };
}

/**
 * sourceEventId를 가진 renderer item 배열에서 변경 eventId에 해당하는 항목만 교체한다.
 * - 인수 : previousItems : 편집 전 item 배열
 * - 인수 : nextItems : 편집 후 full rebuild item 배열
 * - 인수 : changedEventIds : 교체 대상 sourceEventId set
 * - 반환값 : 변경 event만 next item으로 바꾼 item 배열
 */
function patchSourceEventItems<TItem extends CanvasNoteRenderItem | CanvasMuteRenderItem>(
  previousItems: readonly TItem[],
  nextItems: readonly TItem[],
  changedEventIds: ReadonlySet<string>,
): TItem[] {
  if (changedEventIds.size === 0) {
    return [...previousItems];
  }

  return [
    ...previousItems.filter((item) => !changedEventIds.has(item.sourceEventId)),
    ...nextItems.filter((item) => changedEventIds.has(item.sourceEventId)),
  ];
}

/**
 * renderer invalidation group set에 지정 group 중 하나라도 있는지 확인한다.
 * - 인수 : groups : plan의 renderer group set
 * - 인수 : candidates : 확인할 group 목록
 * - 반환값 : 하나 이상 포함되어 있는지 여부
 */
function hasAnyRendererGroup(
  groups: ReadonlySet<RendererInvalidationGroup>,
  candidates: readonly RendererInvalidationGroup[],
): boolean {
  return candidates.some((group) => groups.has(group));
}
