/**
 * edit panel control event를 AppState edit mode와 rawText preview 흐름에 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import {
  activateTupletSlot,
  readDefaultNoteEditInput,
  syncDefaultEditToolFromDom,
  syncTupletEditToolFromDom,
} from "./edit_controller";
import {
  syncLeftStatus,
  syncUiControls,
} from "../app_ui_sync";
import { fitScoreHeight } from "../app_view_binding";
import {
  normalizeMicroPitchInput,
  resolveAutoDefaultText,
} from "../pitch_label";
import {
  normalizeNumberRawInput,
  setSelectedNumberRamp,
} from "./edit_number";

/** edit panel binding이 app 상태를 읽고 갱신하기 위한 session 입력. */
export type EditPanelBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  render(): void;
  resetRepeatedClickCycle(): void;
};

/**
 * edit panel 관련 DOM event를 AppState edit mode에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 edit helper callback 묶음
 * - 반환값 : 없음
 */
export function bindEditPanelControls(
  dom: AppDom,
  session: EditPanelBindingSession,
): void {
  dom.editToggle.addEventListener("change", () => {
    const state = session.getState();

    // checkbox 상태를 mode로 변환하고 edit panel의 현재 입력값을 rawText 합성 상태로 보관한다.
    session.setState({
      ...state,
      mode: dom.editToggle.checked
        ? {
            kind: "edit",
            tool: {
              kind: "default",
              input: resolveAutoDefaultText(
                state,
                readDefaultNoteEditInput(dom),
                state.selection?.rowId ?? null,
              ),
            },
          }
        : { kind: "view" },
      loop: dom.editToggle.checked
        ? {
            ...state.loop,
            enabled: false,
            pickMode: null,
          }
        : state.loop,
      statusMessage: {
        level: "info",
        text: dom.editToggle.checked ? "Edit mode: AUTO♯" : "View mode",
      },
    });
    syncLeftStatus(dom, session.getState());
    syncUiControls(dom, session.getState());

    if (dom.editToggle.checked) {
      fitScoreHeight(dom, session);
    }
  });

  const syncDefaultEditInput = (): void => {
    session.setState(syncDefaultEditToolFromDom(dom, session.getState()));
    syncUiControls(dom, session.getState());
  };

  // edit panel 입력이 바뀔 때마다 현재 rawText preview와 click 적용 상태를 동기화한다.
  dom.defaultModeSelect.addEventListener("change", syncDefaultEditInput);
  dom.customTextInput.addEventListener("input", syncDefaultEditInput);
  dom.holdTokenSelect.addEventListener("change", syncDefaultEditInput);
  dom.glissKindSelect.addEventListener("change", syncDefaultEditInput);
  dom.glissIdSelect.addEventListener("change", syncDefaultEditInput);
  dom.tremDivisionSelect.addEventListener("change", syncDefaultEditInput);
  dom.absolutePitchSelect.addEventListener("change", syncDefaultEditInput);
  dom.microPitchInput.addEventListener("input", () => {
    const normalizedValue = normalizeMicroPitchInput(dom.microPitchInput.value);

    if (dom.microPitchInput.value !== normalizedValue) {
      dom.microPitchInput.value = normalizedValue;
    }

    syncDefaultEditInput();
  });

  dom.numberRawInput.addEventListener("input", () => {
    const normalizedValue = normalizeNumberRawInput(dom.numberRawInput.value);

    if (dom.numberRawInput.value !== normalizedValue) {
      dom.numberRawInput.value = normalizedValue;
    }

    session.resetRepeatedClickCycle();
  });
  dom.numberRampButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const ramp = button.dataset.ramp;

      if (ramp === "none" || ramp === "start" || ramp === "end" || ramp === "endStart") {
        setSelectedNumberRamp(dom, ramp);
        session.resetRepeatedClickCycle();
      }
    });
  });

  dom.tupletModeToggle.addEventListener("click", () => {
    const state = session.getState();

    if (state.mode.kind !== "edit") {
      return;
    }

    const isTupletMode = state.mode.tool.kind === "tuplet" ||
      state.mode.tool.kind === "pletExtend";

    if (isTupletMode) {
      session.setState({
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
      });
    } else if (dom.tupletInsertModeSelect.value === "extend") {
      session.setState({
        ...state,
        mode: {
          kind: "edit",
          tool: {
            kind: "pletExtend",
          },
        },
      });
    } else {
      session.setState(syncTupletEditToolFromDom(dom, state));
    }

    syncUiControls(dom, session.getState());
  });

  const syncTupletEditInput = (): void => {
    const state = session.getState();

    if (
      state.mode.kind === "edit" &&
      state.mode.tool.kind === "pletExtend" &&
      dom.tupletInsertModeSelect.value !== "extend"
    ) {
      session.setState(syncTupletEditToolFromDom(dom, state));
    } else if (
      state.mode.kind === "edit" &&
      state.mode.tool.kind === "tuplet" &&
      dom.tupletInsertModeSelect.value === "extend"
    ) {
      session.setState({
        ...state,
        mode: {
          kind: "edit",
          tool: {
            kind: "pletExtend",
          },
        },
      });
    } else if (state.mode.kind === "edit" && state.mode.tool.kind === "tuplet") {
      session.setState(syncTupletEditToolFromDom(dom, state));
    }

    syncUiControls(dom, session.getState());
  };

  dom.tupletDivisionSelect.addEventListener("change", syncTupletEditInput);
  dom.tupletInsertModeSelect.addEventListener("change", syncTupletEditInput);
  dom.tupletFinalizeButton.addEventListener("click", () => {
    session.setState(syncTupletEditToolFromDom(dom, session.getState()));
    dom.tupletInsertModeSelect.value = "SELECT MODE";
    session.setState({
      ...session.getState(),
      statusMessage: {
        level: "info",
        text: "Tuplet value finalized. Select a score cell to apply.",
      },
    });
    syncLeftStatus(dom, session.getState());
    syncUiControls(dom, session.getState());
  });

  dom.tupletSlotInputs.forEach((input, slotIndex) => {
    input.addEventListener("click", () => {
      session.setState(activateTupletSlot(dom, session.getState(), slotIndex));
      syncLeftStatus(dom, session.getState());
      syncUiControls(dom, session.getState());
    });
    input.addEventListener("focus", () => {
      session.setState(activateTupletSlot(dom, session.getState(), slotIndex));
      syncLeftStatus(dom, session.getState());
      syncUiControls(dom, session.getState());
    });
    input.addEventListener("input", syncTupletEditInput);
  });
}
