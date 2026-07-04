/**
 * score pointer 입력을 edit command로 해석하는 app edit interaction helper이다.
 */

import type {
  AppDom,
  AppState,
  ScoreHit,
  ScoreSelection,
} from "../app_types";
import { DEFAULT_ACTIVE_TRACK_IDS } from "../../track/track_control";
import {
  composeTupletSlotTextFromRow,
  resolveTupletHeadPlacementHit,
  setActiveTupletSlotText,
} from "./edit_controller";
import { resolveAutoPitchInputs } from "../pitch_label";
import type { ScoreTextEdit } from "./edit_apply";
import { composeEditRawText } from "./edit_core";
import { composeNumberRawTextForHit } from "./edit_number";
import {
  advanceRepeatedClickCycle,
  cycleRawTextFromExistingCell,
  type RepeatedClickCycleState,
} from "./edit_pointer";

/** 단일 pointer 편집 동작 옵션. */
export type SinglePointerEditOptions = {
  useClickCycle: boolean;
  forceDelete: boolean;
};

/** 단일 pointer edit 해석 결과. */
export type SinglePointerEditResult =
  | {
      kind: "edit";
      edit: ScoreTextEdit;
      repeatedClickCycle: RepeatedClickCycleState | null;
    }
  | {
      kind: "handled";
      state: AppState;
      repeatedClickCycle: RepeatedClickCycleState | null;
    }
  | {
      kind: "blocked";
      message: string;
      repeatedClickCycle: RepeatedClickCycleState | null;
    };

/**
 * hit를 대표 active track이 포함된 score selection으로 변환한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : hit : renderer 좌표계에서 변환된 score hit
 * - 반환값 : 대표 active track id가 포함된 score selection
 */
export function getSelectionForHit(state: AppState, hit: ScoreHit): ScoreSelection {
  return {
    ...hit,
    trackId: state.activeTrackIds[0] ?? DEFAULT_ACTIVE_TRACK_IDS[0],
  };
}

/**
 * 현재 score 상태에서 selection 위치의 기존 rawText를 읽는다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : selection : 조회할 score cell 좌표
 * - 반환값 : 기존 rawText 또는 빈 문자열
 */
export function getExistingRawText(state: AppState, selection: ScoreSelection): string {
  if (selection.rowKind === "global") {
    const cell = state.document.indexes.globalCellMapByCoord.get(
      `${selection.rowId}|${selection.col}`,
    );

    return cell?.rawText ?? "";
  }

  if (selection.rowKind === "note") {
    const trackCellMap = state.document.indexes.cellMapByTrackId.get(selection.trackId);
    const cell = trackCellMap?.get(`${selection.rowId}|${selection.col}`);

    return cell?.rawText ?? "";
  }

  return "";
}

/**
 * pointer click 하나를 score rawText edit 또는 특수 handled 동작으로 해석한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : hit : 클릭한 score 좌표
 * - 인수 : options : click cycle과 강제 삭제 옵션
 * - 인수 : repeatedClickCycle : 현재 반복 클릭 cycle 상태
 * - 반환값 : edit/handled/blocked 결과와 다음 cycle 상태
 */
export function composeSingleEditForHit(
  dom: AppDom,
  state: AppState,
  hit: ScoreHit,
  options: SinglePointerEditOptions,
  repeatedClickCycle: RepeatedClickCycleState | null,
): SinglePointerEditResult {
  const mode = state.mode;

  if (mode.kind !== "edit") {
    return {
      kind: "blocked",
      message: "Edit mode is not active.",
      repeatedClickCycle,
    };
  }

  if (hit.rowKind === "note" && state.activeTrackIds.length === 0) {
    return {
      kind: "blocked",
      message: "Activate at least one track before editing note rows.",
      repeatedClickCycle,
    };
  }

  if (options.forceDelete) {
    return {
      kind: "edit",
      edit: {
        selection: getSelectionForHit(state, hit),
        rawText: "",
      },
      repeatedClickCycle: null,
    };
  }

  if (hit.rowKind === "global") {
    const numberResult = composeNumberRawTextForHit(dom, state, hit);

    if (numberResult.kind === "blocked") {
      return {
        ...numberResult,
        repeatedClickCycle: null,
      };
    }

    return {
      kind: "edit",
      edit: {
        selection: getSelectionForHit(state, hit),
        rawText: numberResult.rawText,
      },
      repeatedClickCycle: null,
    };
  }

  if (
    mode.tool.kind === "tuplet" &&
    dom.tupletInsertModeSelect.value === "SELECT ROW"
  ) {
    const slotTextResult = composeTupletSlotTextFromRow(dom, state, hit);

    if (slotTextResult.kind === "blocked") {
      return {
        ...slotTextResult,
        repeatedClickCycle: null,
      };
    }

    return {
      kind: "handled",
      state: setActiveTupletSlotText(dom, state, slotTextResult.text),
      repeatedClickCycle: null,
    };
  }

  const editRawText = mode.tool.kind === "pletExtend"
    ? {
        kind: "apply" as const,
        rawText: "/&",
      }
    : mode.tool.kind === "tuplet"
      ? composeEditRawText({
          kind: "tuplet",
          draft: mode.tool.draft,
        })
      : composeEditRawText({
          kind: "default",
          input: resolveAutoPitchInputs(state, mode.tool.input, hit.rowId),
        });

  if (editRawText.kind === "blocked") {
    return {
      kind: "blocked",
      message: editRawText.message,
      repeatedClickCycle,
    };
  }

  let targetHit = hit;
  let rawText = editRawText.kind === "delete" ? "" : editRawText.rawText;
  let nextRepeatedClickCycle: RepeatedClickCycleState | null = null;

  if (mode.tool.kind === "tuplet" && editRawText.kind === "apply") {
    const placementResult = resolveTupletHeadPlacementHit(state, hit, editRawText.rawText);

    if (placementResult.kind === "blocked") {
      return {
        ...placementResult,
        repeatedClickCycle: null,
      };
    }

    targetHit = placementResult.hit;
  } else if (
    options.useClickCycle &&
    mode.tool.kind === "default" &&
    editRawText.kind === "apply" &&
    hit.rowKind === "note"
  ) {
    const cycleResult = advanceRepeatedClickCycle(
      repeatedClickCycle,
      hit,
      editRawText.rawText,
      (targetHitForSelection) => getSelectionForHit(state, targetHitForSelection),
    );

    rawText = cycleResult.rawText;
    nextRepeatedClickCycle = cycleResult.cycleState;
  }

  return {
    kind: "edit",
    edit: {
      selection: getSelectionForHit(state, targetHit),
      rawText,
    },
    repeatedClickCycle: nextRepeatedClickCycle,
  };
}

/**
 * drag 중인 score hit를 rawText 적용값으로 해석한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : hit : drag 중 현재 score 좌표
 * - 인수 : button : pointer drag를 시작한 버튼
 * - 반환값 : 적용할 rawText 또는 blocked reason
 */
export function composeDragRawTextForHit(
  dom: AppDom,
  state: AppState,
  hit: ScoreHit,
  button: 0 | 2,
):
  | {
      kind: "apply";
      rawText: string;
    }
  | {
      kind: "blocked";
      message: string;
    } {
  if (button === 2) {
    if (hit.rowKind === "note" && state.activeTrackIds.length === 0) {
      return {
        kind: "blocked",
        message: "Activate at least one track before editing note rows.",
      };
    }

    return {
      kind: "apply",
      rawText: "",
    };
  }

  if (hit.rowKind === "global") {
    return composeNumberRawTextForHit(dom, state, hit);
  }

  if (state.activeTrackIds.length === 0) {
    return {
      kind: "blocked",
      message: "Activate at least one track before editing note rows.",
    };
  }

  const mode = state.mode;

  if (mode.kind !== "edit") {
    return {
      kind: "blocked",
      message: "Drag edit is only available in edit mode.",
    };
  }

  if (mode.tool.kind === "pletExtend") {
    return {
      kind: "apply",
      rawText: "/&",
    };
  }

  if (mode.tool.kind !== "default") {
    return {
      kind: "blocked",
      message: "Drag edit is only available for Default, Eraser, Number, and /& input.",
    };
  }

  const editRawText = composeEditRawText({
    kind: "default",
    input: resolveAutoPitchInputs(state, mode.tool.input, hit.rowId),
  });

  if (editRawText.kind === "blocked") {
    return {
      kind: "blocked",
      message: editRawText.message,
    };
  }

  const baseRawText = editRawText.kind === "delete" ? "" : editRawText.rawText;

  if (
    editRawText.kind === "apply" &&
    !baseRawText.startsWith("//") &&
    hit.rowKind === "note"
  ) {
    return {
      kind: "apply",
      rawText: cycleRawTextFromExistingCell(
        getExistingRawText(state, getSelectionForHit(state, hit)),
        baseRawText,
      ),
    };
  }

  return {
    kind: "apply",
    rawText: baseRawText,
  };
}
