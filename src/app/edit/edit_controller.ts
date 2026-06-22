/**
 * DOM 입력을 app edit 상태로 변환하고 score click 의미를 해석한다.
 */

import type {
  AppDom,
  AppState,
  ScoreHit,
  ScoreSelection,
} from "../app_types";
import { composeEditRawText } from "./edit_core";
import type {
  DefaultEditMode,
  DefaultNoteEditInput,
  GlissEditInput,
  HoldEditToken,
} from "./edit_default";
import type { TupletEditDraft } from "./edit_tuplet";
import { resolveAutoDefaultText } from "../pitch_label";
import { parseNoteCell } from "../../core/parse/parse_note_cell";
import { DEFAULT_ACTIVE_TRACK_IDS } from "../../track/track_control";

/**
 * DOM의 edit panel 입력값을 일반 note rawText 합성 입력으로 읽는다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : autoText : AUTO 모드에서 사용할 계산된 defaultText
 * - 반환값 : Default 영역과 modifier 영역의 현재 입력 상태
 */
export function readDefaultNoteEditInput(
  dom: AppDom,
  autoText = "",
): DefaultNoteEditInput {
  return {
    mode: dom.defaultModeSelect.value as DefaultEditMode,
    customText: dom.customTextInput.value,
    autoText,
    hold: dom.holdTokenSelect.value as HoldEditToken,
    gliss: {
      kind: dom.glissKindSelect.value as GlissEditInput["kind"],
      id: dom.glissIdSelect.value,
    },
    tremDivision: dom.tremDivisionSelect.value as DefaultNoteEditInput["tremDivision"],
    absolutePitch: dom.absolutePitchSelect.value,
    microPitch: dom.microPitchInput.value,
  };
}

/**
 * DOM의 tuplet slot 입력값을 tuplet rawText 합성 draft로 읽는다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : tuplet division과 slot 직접 입력 상태
 */
export function readTupletEditDraft(
  dom: AppDom,
  activeSlotIndex: number | null = null,
): TupletEditDraft {
  const divNum = Number.parseInt(dom.tupletDivisionSelect.value, 10);
  const normalizedActiveSlotIndex =
    activeSlotIndex !== null && activeSlotIndex >= 0 && activeSlotIndex < divNum
      ? activeSlotIndex
      : null;

  return {
    divNum,
    slots: dom.tupletSlotInputs.map((input, slotIndex) => ({
      slotIndex,
      text: input.value,
    })),
    activeSlotIndex: normalizedActiveSlotIndex,
  };
}

/**
 * 현재 edit panel 입력 상태를 AppState의 edit tool에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : edit tool 입력이 갱신된 앱 상태
 */
export function syncDefaultEditToolFromDom(dom: AppDom, state: AppState): AppState {
  if (state.mode.kind !== "edit") {
    return state;
  }

  if (state.mode.tool.kind !== "default") {
    return state;
  }

  return {
    ...state,
    mode: {
      kind: "edit",
      tool: {
        kind: "default",
        input: resolveAutoDefaultText(
          state,
          readDefaultNoteEditInput(dom),
          state.selection?.rowId ?? null,
        ),
      },
    },
  };
}

/**
 * 현재 tuplet 입력 상태를 AppState의 edit tool에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : tuplet edit tool 입력이 갱신된 앱 상태
 */
export function syncTupletEditToolFromDom(dom: AppDom, state: AppState): AppState {
  if (state.mode.kind !== "edit") {
    return state;
  }

  const activeSlotIndex = state.mode.tool.kind === "tuplet"
    ? state.mode.tool.draft.activeSlotIndex
    : null;

  return {
    ...state,
    mode: {
      kind: "edit",
      tool: {
        kind: "tuplet",
        draft: readTupletEditDraft(dom, activeSlotIndex),
      },
    },
  };
}

/**
 * tuplet slot input 클릭을 active slot 상태로 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : slotIndex : 활성화할 0-based slot 번호
 * - 반환값 : active slot이 반영된 앱 상태
 */
export function activateTupletSlot(
  dom: AppDom,
  state: AppState,
  slotIndex: number,
): AppState {
  if (state.mode.kind !== "edit") {
    return state;
  }

  if (state.mode.tool.kind !== "tuplet") {
    return state;
  }

  const draft = readTupletEditDraft(dom, slotIndex);

  return {
    ...state,
    mode: {
      kind: "edit",
      tool: {
        kind: "tuplet",
        draft,
      },
    },
    statusMessage: {
      level: "info",
      text: `Tuplet slot ${slotIndex + 1} selected.`,
    },
  };
}

/**
 * SELECT ROW 모드에서 현재 Default 조합과 클릭한 note row를 tuplet slot 문자열로 만든다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : hit : 사용자가 선택한 score row 좌표
 * - 반환값 : slot에 넣을 문자열 또는 blocked reason
 */
export function composeTupletSlotTextFromRow(
  dom: AppDom,
  state: AppState,
  hit: ScoreHit,
):
  | {
      kind: "slotText";
      text: string;
    }
  | {
      kind: "blocked";
      message: string;
    } {
  if (hit.rowKind !== "note") {
    return {
      kind: "blocked",
      message: "Tuplet SELECT ROW requires a note row.",
    };
  }

  const input = resolveAutoDefaultText(
    state,
    readDefaultNoteEditInput(dom),
    hit.rowId,
  );
  const result = composeEditRawText({
    kind: "default",
    input,
  });

  if (result.kind === "blocked") {
    return result;
  }

  if (result.kind === "delete") {
    return {
      kind: "slotText",
      text: "",
    };
  }

  if (result.rawText.startsWith("//")) {
    return {
      kind: "blocked",
      message: "Tuplet slot cannot use comment text.",
    };
  }

  const row = state.document.indexes.rowById.get(hit.rowId);

  if (row?.type !== "note") {
    return {
      kind: "blocked",
      message: "Tuplet SELECT ROW could not resolve the selected note row.",
    };
  }

  return {
    kind: "slotText",
    text: `${result.rawText}@n(${row.midi})`,
  };
}

/**
 * active tuplet slot input에 문자열을 쓰고 draft 상태를 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : slotText : active slot에 넣을 rawText 조각
 * - 반환값 : slot 값과 draft가 갱신된 앱 상태
 */
export function setActiveTupletSlotText(
  dom: AppDom,
  state: AppState,
  slotText: string,
): AppState {
  if (state.mode.kind !== "edit" || state.mode.tool.kind !== "tuplet") {
    return state;
  }

  const activeSlotIndex = state.mode.tool.draft.activeSlotIndex;

  if (activeSlotIndex === null) {
    return {
      ...state,
      statusMessage: {
        level: "warning",
        text: "Select a tuplet slot first.",
      },
    };
  }

  const input = dom.tupletSlotInputs[activeSlotIndex];

  if (input === undefined || input.disabled) {
    return {
      ...state,
      statusMessage: {
        level: "warning",
        text: "Selected tuplet slot is not editable.",
      },
    };
  }

  input.value = slotText;

  return {
    ...state,
    mode: {
      kind: "edit",
      tool: {
        kind: "tuplet",
        draft: readTupletEditDraft(dom, activeSlotIndex),
      },
    },
    statusMessage: {
      level: "info",
      text: `Tuplet slot ${activeSlotIndex + 1} updated.`,
    },
  };
}

/**
 * tuplet head 설치 대상 좌표를 첫 note slot의 @n(midi) 위치로 보정한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : hit : 사용자가 클릭한 score 좌표
 * - 인수 : rawText : draft에서 합성된 tuplet rawText
 * - 반환값 : 보정된 hit 또는 blocked reason
 */
export function resolveTupletHeadPlacementHit(
  state: AppState,
  hit: ScoreHit,
  rawText: string,
):
  | {
      kind: "hit";
      hit: ScoreHit;
    }
  | {
      kind: "blocked";
      message: string;
    } {
  const clickedRow = state.document.indexes.rowById.get(hit.rowId);

  if (clickedRow?.type !== "note") {
    return {
      kind: "blocked",
      message: "Tuplet head placement requires a note row.",
    };
  }

  const parsedCell = parseNoteCell({
    trackId: state.activeTrackIds[0] ?? DEFAULT_ACTIVE_TRACK_IDS[0],
    rawText,
    rowId: hit.rowId,
    col: hit.col,
  });

  if (parsedCell.kind !== "pletHead") {
    return {
      kind: "blocked",
      message: "Tuplet value is not a valid head cell.",
    };
  }

  const placementSlot = parsedCell.slots.find((slot) => slot.note !== null);
  const placementSlotMidi = placementSlot?.note?.position.midiNum;

  if (placementSlotMidi === undefined) {
    return {
      kind: "hit",
      hit,
    };
  }

  const placementRowId = state.document.indexes.noteRowIdByStringMidi.get(
    `${clickedRow.stringId}|${placementSlotMidi}`,
  );

  if (placementRowId === undefined) {
    return {
      kind: "blocked",
      message: "Tuplet placement slot row is outside the selected string range.",
    };
  }

  return {
    kind: "hit",
    hit: {
      ...hit,
      rowId: placementRowId,
      rowKind: "note",
    },
  };
}

/**
 * 현재 mode/tool 상태로 score canvas click을 처리한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : hit : renderer 좌표계에서 변환된 score hit
 * - 반환값 : mutation이 필요하면 갱신된 상태, 아니면 선택만 반영한 상태
 */
export function handleScoreClick(state: AppState, hit: ScoreHit): AppState {
  const selection: ScoreSelection = {
    ...hit,
    trackId: state.activeTrackIds[0] ?? DEFAULT_ACTIVE_TRACK_IDS[0],
  };

  if (state.busy.kind !== "idle") {
    return state;
  }

  if (state.mode.kind === "view") {
    return {
      ...state,
      selection,
      statusMessage: {
        level: "info",
        text: `Selected ${selection.trackId} ${selection.rowId}:${selection.col}`,
      },
    };
  }

  return {
    ...state,
    selection,
    statusMessage: {
      level: "warning",
      text: "Current edit mode must be applied through edit composer.",
    },
  };
}
