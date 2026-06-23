/**
 * edit 종류와 analyzer event diff를 renderer/audio 갱신 계획으로 변환한다.
 */

import type { AnalyzedEventDiffResult } from "../../core/analyze/event_diff";
import type {
  PartialRebuildEditKind,
  PartialRebuildPlan,
  RendererInvalidationGroup,
  RendererInvalidationPlan,
} from "./partial_rebuild_types";

/** partial rebuild planner 입력. */
export type CreatePartialRebuildPlanInput = {
  editKind: PartialRebuildEditKind;
  eventDiff: AnalyzedEventDiffResult;
};

/**
 * edit 종류와 event diff에서 renderer/audio 갱신 계획을 만든다.
 * - 인수 : input : edit 종류와 analyzer event diff
 * - 반환값 : PartialRebuildPlan : renderer/audio 갱신 계획과 fallback 정보
 */
export function createPartialRebuildPlan(
  input: CreatePartialRebuildPlanInput,
): PartialRebuildPlan {
  const changedEventIds = collectChangedEventIds(input.eventDiff);
  const hasDuplicateEventIds = input.eventDiff.duplicateEventIds.length > 0;

  if (input.editKind === "structure") {
    return {
      editKind: input.editKind,
      renderer: {
        redrawScope: "all",
        groups: ["layoutBase", "noteItems", "muteItems", "noteMarkers", "globalTextItems", "globalMarkers"],
        changedEventIds,
        dirtyTickRange: null,
      },
      audio: {
        scope: "fullSchedule",
        changedEventIds,
      },
      fallback: "fullRuntime",
      eventDiff: input.eventDiff,
    };
  }

  if (input.editKind === "mixedCell" || hasDuplicateEventIds) {
    return {
      editKind: input.editKind,
      renderer: {
        redrawScope: "all",
        groups: ["noteItems", "muteItems", "noteMarkers", "globalTextItems", "globalMarkers"],
        changedEventIds,
        dirtyTickRange: null,
      },
      audio: {
        scope: "fullSchedule",
        changedEventIds,
      },
      fallback: hasDuplicateEventIds ? "fullRuntime" : "fullRender",
      eventDiff: input.eventDiff,
    };
  }

  if (input.editKind === "globalCell") {
    return {
      editKind: input.editKind,
      renderer: createGlobalRendererPlan(changedEventIds),
      audio: {
        scope: "fullSchedule",
        changedEventIds,
      },
      fallback: "none",
      eventDiff: input.eventDiff,
    };
  }

  return {
    editKind: input.editKind,
    renderer: createNoteRendererPlan(input.eventDiff, changedEventIds),
    audio: {
      scope: changedEventIds.length > 0 ? "eventSet" : "none",
      changedEventIds,
    },
    fallback: "none",
    eventDiff: input.eventDiff,
  };
}

/**
 * note 편집의 renderer 갱신 계획을 만든다.
 * - 인수 : eventDiff : analyzer event diff
 * - 인수 : changedEventIds : 추가/삭제/변경 eventId 목록
 * - 반환값 : RendererInvalidationPlan
 */
function createNoteRendererPlan(
  eventDiff: AnalyzedEventDiffResult,
  changedEventIds: string[],
): RendererInvalidationPlan {
  const groups = new Set<RendererInvalidationGroup>();
  const dirtyEntries = [
    ...eventDiff.added,
    ...eventDiff.removed,
    ...eventDiff.changed,
  ];

  // analyzer event kind를 renderer item group으로 매핑해 후속 item 교체 범위를 좁힌다.
  for (const entry of dirtyEntries) {
    if (entry.eventKind === "note") {
      groups.add("noteItems");
      groups.add("noteMarkers");
    } else if (entry.eventKind === "mute") {
      groups.add("muteItems");
    } else if (
      entry.eventKind === "gliss" ||
      entry.eventKind === "tupletGroup" ||
      entry.eventKind === "tupletExtendGroup"
    ) {
      groups.add("noteMarkers");
    } else if (entry.eventKind === "rest") {
      groups.add("noteItems");
    }
  }

  return {
    redrawScope: "note",
    groups: Array.from(groups).sort(compareRendererInvalidationGroups),
    changedEventIds,
    dirtyTickRange: createDirtyTickRange(dirtyEntries),
  };
}

/**
 * global 편집의 renderer 갱신 계획을 만든다.
 * - 인수 : changedEventIds : analyzer event diff에서 바뀐 eventId 목록
 * - 반환값 : RendererInvalidationPlan
 */
function createGlobalRendererPlan(changedEventIds: string[]): RendererInvalidationPlan {
  return {
    redrawScope: "global",
    groups: ["globalTextItems", "globalMarkers"],
    changedEventIds,
    dirtyTickRange: null,
  };
}

/**
 * 변경된 event entry 목록에서 dirty tick 범위를 만든다.
 * - 인수 : entries : 추가/삭제/변경 event diff entry
 * - 반환값 : dirty tick 범위 또는 변경 event가 없으면 null
 */
function createDirtyTickRange(
  entries: readonly AnalyzedEventDiffResult["changed"][number][],
): { startTick: number; endTick: number } | null {
  let startTick = Number.POSITIVE_INFINITY;
  let endTick = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    for (const event of [entry.previous, entry.next]) {
      if (event === null) {
        continue;
      }

      startTick = Math.min(startTick, timeFractionToNumber(event.time.startTick));
      endTick = Math.max(endTick, timeFractionToNumber(event.time.endTick));
    }
  }

  if (!Number.isFinite(startTick) || !Number.isFinite(endTick)) {
    return null;
  }

  return {
    startTick,
    endTick,
  };
}

/**
 * analyzer TimeFraction shape를 number tick으로 변환한다.
 * - 인수 : value : numerator/denominator tick 값
 * - 반환값 : number tick
 */
function timeFractionToNumber(value: { numerator: number; denominator: number }): number {
  return value.numerator / value.denominator;
}

/**
 * event diff에서 추가/삭제/변경된 eventId를 안정 정렬해 모은다.
 * - 인수 : eventDiff : analyzer event diff
 * - 반환값 : string[] : 바뀐 eventId 목록
 */
function collectChangedEventIds(eventDiff: AnalyzedEventDiffResult): string[] {
  return [
    ...eventDiff.added,
    ...eventDiff.removed,
    ...eventDiff.changed,
  ]
    .map((entry) => entry.eventId)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * renderer invalidation group을 안정 정렬한다.
 * - 인수 : left : 왼쪽 group
 * - 인수 : right : 오른쪽 group
 * - 반환값 : 정렬 순서
 */
function compareRendererInvalidationGroups(
  left: RendererInvalidationGroup,
  right: RendererInvalidationGroup,
): number {
  return getRendererInvalidationGroupOrder(left) - getRendererInvalidationGroupOrder(right);
}

/**
 * renderer invalidation group의 표시/갱신 순서를 반환한다.
 * - 인수 : group : renderer invalidation group
 * - 반환값 : 낮을수록 먼저 오는 정렬값
 */
function getRendererInvalidationGroupOrder(group: RendererInvalidationGroup): number {
  switch (group) {
    case "layoutBase":
      return 0;
    case "globalMarkers":
      return 1;
    case "globalTextItems":
      return 2;
    case "noteMarkers":
      return 3;
    case "noteItems":
      return 4;
    case "muteItems":
      return 5;
  }
}
