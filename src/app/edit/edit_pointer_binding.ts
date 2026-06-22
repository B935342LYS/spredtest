/**
 * score canvas pointer/click event를 edit interaction과 selection 흐름에 연결한다.
 */

import type {
  AppDom,
  AppState,
  ScoreHit,
  ScoreSelection,
} from "../app_types";
import { handleScoreClick } from "./edit_controller";
import { syncLeftStatus } from "../app_ui_sync";
import type { AppNotePreviewRuntime } from "../playback/app_note_preview";
import { hitTestScoreCell } from "../score_hit_test";
import type { ScoreTextEdit } from "./edit_apply";
import {
  composeDragRawTextForHit,
  composeSingleEditForHit,
  getSelectionForHit as getSelectionForStateHit,
} from "./edit_interaction";
import {
  addDragEditForHit,
  shouldStartDragEdit,
  type DragEditState,
  type RepeatedClickCycleState,
} from "./edit_pointer";

const DRAG_START_DISTANCE_PX = 4;
const NOTE_ROW_HIT_SLOP_PX = 14;

/** pointer binding이 app 상태와 edit 적용 흐름에 접근하기 위한 session 입력. */
export type PointerBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  render(): void;
  getNotePreviewRuntime(): AppNotePreviewRuntime;
  applyScoreTextEdits(edits: ScoreTextEdit[]): void;
};

/** pointer binding이 edit panel 등 외부 입력 변경에 제공하는 control 객체. */
export type PointerBindingControl = {
  resetRepeatedClickCycle(): void;
};

/**
 * score canvas pointer/click/contextmenu event를 app edit 흐름에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태, renderer, note preview, edit 적용 callback 묶음
 * - 반환값 : 외부 입력 변경에서 사용할 pointer 상태 reset control
 */
export function bindScorePointerControls(
  dom: AppDom,
  session: PointerBindingSession,
): PointerBindingControl {
  let repeatedClickCycle: RepeatedClickCycleState | null = null;
  let dragEdit: DragEditState | null = null;
  let suppressNextClick = false;
  let lastPreviewHitKey: string | null = null;

  const resetRepeatedClickCycle = (): void => {
    repeatedClickCycle = null;
  };

  const getSelectionForHit = (hit: ScoreHit): ScoreSelection => ({
    ...getSelectionForStateHit(session.getState(), hit),
  });

  const expandEditForActiveTracks = (edit: ScoreTextEdit): ScoreTextEdit[] => {
    if (edit.selection.rowKind !== "note") {
      return [edit];
    }

    return session.getState().activeTrackIds.map((trackId) => ({
      selection: {
        ...edit.selection,
        trackId,
      },
      rawText: edit.rawText,
    }));
  };

  const expandEditsForActiveTracks = (edits: ScoreTextEdit[]): ScoreTextEdit[] =>
    edits.flatMap(expandEditForActiveTracks);

  const getPointerEditHit = (event: MouseEvent): ScoreHit | null => {
    const state = session.getState();

    if (state.layout === null) {
      return null;
    }

    return hitTestScoreCell(event, dom.scoreStage, state.layout, {
      nearestNoteSlopPx: NOTE_ROW_HIT_SLOP_PX,
    });
  };

  const resetNotePreviewHit = (): void => {
    lastPreviewHitKey = null;
  };

  const playNotePreviewForHit = (hit: ScoreHit | null): void => {
    if (hit === null || hit.rowKind !== "note") {
      return;
    }

    const row = session.getState().document.indexes.rowById.get(hit.rowId);

    if (row?.type !== "note") {
      return;
    }

    const previewHitKey = hit.rowId;

    if (previewHitKey === lastPreviewHitKey) {
      return;
    }

    lastPreviewHitKey = previewHitKey;
    session.getNotePreviewRuntime().previewMidi(row.midi);
  };

  const applySinglePointerEdit = (
    hit: ScoreHit,
    options: {
      useClickCycle: boolean;
      forceDelete: boolean;
    },
  ): void => {
    const result = composeSingleEditForHit(
      dom,
      session.getState(),
      hit,
      options,
      repeatedClickCycle,
    );

    repeatedClickCycle = result.repeatedClickCycle;

    if (result.kind === "blocked") {
      session.setState({
        ...session.getState(),
        statusMessage: {
          level: "warning",
          text: result.message,
        },
      });
      syncLeftStatus(dom, session.getState());
      return;
    }

    if (result.kind === "handled") {
      session.setState(result.state);
      syncLeftStatus(dom, session.getState());
      return;
    }

    session.applyScoreTextEdits(expandEditForActiveTracks(result.edit));
  };

  dom.scoreStage.addEventListener("pointerdown", (event) => {
    const state = session.getState();

    if (
      state.busy.kind !== "idle" ||
      state.layout === null ||
      (event.button !== 0 && event.button !== 2)
    ) {
      return;
    }

    const hit = getPointerEditHit(event);

    if (state.mode.kind !== "edit") {
      return;
    }

    resetNotePreviewHit();
    playNotePreviewForHit(hit);

    event.preventDefault();
    suppressNextClick = true;

    const button = event.button as 0 | 2;
    const dragRawText = hit === null
      ? null
      : composeDragRawTextForHit(dom, state, hit, button);
    const canStartFloatingDrag = button === 2 ||
      (
        state.mode.kind === "edit" &&
        (state.mode.tool.kind === "default" || state.mode.tool.kind === "pletExtend")
      );

    dragEdit = dragRawText?.kind === "apply" || (hit === null && canStartFloatingDrag)
      ? {
          pointerId: event.pointerId,
          button,
          startClientX: event.clientX,
          startClientY: event.clientY,
          startHit: hit,
          lastHit: hit,
          canDrag: true,
          isDragging: false,
          edits: new Map(),
        }
      : null;

    if (dragRawText?.kind === "blocked") {
      // 드래그 입력을 지원하지 않는 도구는 pointerup에서 단일 클릭 처리만 수행한다.
      dragEdit = {
        pointerId: event.pointerId,
        button,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startHit: hit,
        lastHit: hit,
        canDrag: false,
        isDragging: false,
        edits: new Map(),
      };
    }

    dom.scoreStage.setPointerCapture(event.pointerId);
  });

  dom.scoreStage.addEventListener("pointermove", (event) => {
    if (
      dragEdit === null ||
      dragEdit.pointerId !== event.pointerId ||
      session.getState().busy.kind !== "idle" ||
      session.getState().layout === null
    ) {
      return;
    }

    let startedDragThisMove = false;

    if (shouldStartDragEdit(dragEdit, event, DRAG_START_DISTANCE_PX)) {
      dragEdit.isDragging = true;
      startedDragThisMove = true;
      resetRepeatedClickCycle();
      if (dragEdit.startHit !== null) {
        const startEdits = addDragEditForHit(dragEdit, dragEdit.startHit, {
          getSelectionForHit,
          composeDragRawTextForHit: (hit, button) =>
            composeDragRawTextForHit(dom, session.getState(), hit, button),
        });

        session.applyScoreTextEdits(expandEditsForActiveTracks(startEdits));
      }
    }

    if (!dragEdit.isDragging) {
      return;
    }

    const hit = getPointerEditHit(event);

    if (hit === null) {
      return;
    }

    playNotePreviewForHit(hit);

    if (
      startedDragThisMove &&
      dragEdit.startHit !== null &&
      dragEdit.startHit.rowId === hit.rowId &&
      dragEdit.startHit.col === hit.col
    ) {
      return;
    }

    const edits = addDragEditForHit(dragEdit, hit, {
      getSelectionForHit,
      composeDragRawTextForHit: (targetHit, button) =>
        composeDragRawTextForHit(dom, session.getState(), targetHit, button),
    });

    session.applyScoreTextEdits(expandEditsForActiveTracks(edits));
  });

  dom.scoreStage.addEventListener("pointerup", (event) => {
    if (dragEdit === null || dragEdit.pointerId !== event.pointerId) {
      return;
    }

    const completedDrag = dragEdit;
    dragEdit = null;

    if (dom.scoreStage.hasPointerCapture(event.pointerId)) {
      dom.scoreStage.releasePointerCapture(event.pointerId);
    }

    if (completedDrag.isDragging) {
      resetNotePreviewHit();
      return;
    }

    if (completedDrag.startHit === null) {
      resetNotePreviewHit();
      return;
    }

    applySinglePointerEdit(completedDrag.startHit, {
      useClickCycle: completedDrag.button === 0,
      forceDelete: completedDrag.button === 2,
    });
    resetNotePreviewHit();
  });

  dom.scoreStage.addEventListener("pointercancel", (event) => {
    if (dragEdit === null || dragEdit.pointerId !== event.pointerId) {
      return;
    }

    dragEdit = null;
    resetNotePreviewHit();
  });

  dom.scoreStage.addEventListener("click", (event) => {
    const state = session.getState();

    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    if (state.busy.kind !== "idle" || state.layout === null) {
      return;
    }

    const hit = hitTestScoreCell(event, dom.scoreStage, state.layout);

    if (hit === null) {
      session.setState({
        ...state,
        statusMessage: {
          level: "warning",
          text: "Score click is outside editable cells.",
        },
      });
      syncLeftStatus(dom, session.getState());
      return;
    }

    if (state.mode.kind === "view") {
      // view mode click은 score mutation 없이 selection/status만 갱신한다.
      session.setState(handleScoreClick(state, hit));
      session.render();
      return;
    }

    applySinglePointerEdit(hit, {
      useClickCycle: true,
      forceDelete: false,
    });
  });

  dom.scoreStage.addEventListener("contextmenu", (event) => {
    if (session.getState().mode.kind !== "edit") {
      return;
    }

    // edit mode의 score stage 우클릭은 브라우저 메뉴 대신 pointer 삭제 입력으로 해석한다.
    event.preventDefault();
  });

  return {
    resetRepeatedClickCycle,
  };
}
