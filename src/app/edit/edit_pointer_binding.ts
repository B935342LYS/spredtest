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
import { isGameModeLocked } from "../game/game_types";
import {
  syncLeftStatus,
  syncPastePreviewOverlay,
  syncRangeSelectionOverlay,
} from "../app_ui_sync";
import type { AppNotePreviewRuntime } from "../playback/app_note_preview";
import { hitTestScoreCell } from "../score_hit_test";
import { xToColumn } from "../../renderer/canvas_coordinate";
import type { ScoreTextEdit } from "./edit_apply";
import {
  composeDragRawTextForHit,
  composeSingleEditForHit,
  getSelectionForHit as getSelectionForStateHit,
} from "./edit_interaction";
import {
  addDragEditForHit,
  getScoreTextEditKey,
  shouldStartDragEdit,
  type DragEditState,
  type RepeatedClickCycleState,
} from "./edit_pointer";
import {
  copyRangeSelectionToClipboard,
  createDeleteEditsForRangeSelection,
  createPasteEditsFromClipboard,
  createScoreRangeSelection,
} from "./edit_range_selection";

const DRAG_START_DISTANCE_PX = 4;
const NOTE_ROW_HIT_SLOP_PX = 14;

/** pointer binding이 app 상태와 edit 적용 흐름에 접근하기 위한 session 입력. */
export type PointerBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  render(): void;
  getNotePreviewRuntime(): AppNotePreviewRuntime;
  applyScoreTextEdits(edits: ScoreTextEdit[], options?: { label?: string }): void;
  beginScoreEditHistoryTransaction(label: string): void;
  endScoreEditHistoryTransaction(): void;
  cancelScoreEditHistoryTransaction(): void;
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
  let rangeDrag: {
    pointerId: number;
    anchorHit: ScoreHit;
  } | null = null;
  let suppressNextClick = false;
  let lastPreviewHitKey: string | null = null;
  let lastPointerColumn: number | null = null;
  let dragEditRafId: number | null = null;
  let isDragHistoryTransactionOpen = false;
  const pendingDragEdits = new Map<string, ScoreTextEdit>();

  const resetRepeatedClickCycle = (): void => {
    repeatedClickCycle = null;
  };

  const beginDragHistoryTransaction = (): void => {
    if (isDragHistoryTransactionOpen) {
      return;
    }

    isDragHistoryTransactionOpen = true;
    session.beginScoreEditHistoryTransaction("Drag edit");
  };

  const endDragHistoryTransaction = (): void => {
    if (!isDragHistoryTransactionOpen) {
      return;
    }

    isDragHistoryTransactionOpen = false;
    session.endScoreEditHistoryTransaction();
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

  /**
   * requestAnimationFrame까지 모인 drag edit batch를 실제 score edit으로 적용한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const flushPendingDragEdits = (): void => {
    if (dragEditRafId !== null) {
      cancelAnimationFrame(dragEditRafId);
      dragEditRafId = null;
    }

    if (pendingDragEdits.size === 0) {
      return;
    }

    const edits = Array.from(pendingDragEdits.values());

    pendingDragEdits.clear();
    session.applyScoreTextEdits(edits);
  };

  /**
   * drag edit을 frame 단위로 모아 과도한 rebuild/render 반복을 줄인다.
   * - 인수 : edits : 이번 pointermove에서 새로 생긴 edit 목록
   * - 반환값 : 없음
   */
  const queueDragEdits = (edits: ScoreTextEdit[]): void => {
    if (edits.length === 0) {
      return;
    }

    for (const edit of edits) {
      pendingDragEdits.set(getScoreTextEditKey(edit), edit);
    }

    if (dragEditRafId !== null) {
      return;
    }

    dragEditRafId = requestAnimationFrame(() => {
      dragEditRafId = null;
      flushPendingDragEdits();
    });
  };

  const getPointerEditHit = (event: MouseEvent): ScoreHit | null => {
    const state = session.getState();

    if (state.layout === null) {
      return null;
    }

    return hitTestScoreCell(event, dom.scoreStage, state.layout, {
      nearestNoteSlopPx: NOTE_ROW_HIT_SLOP_PX,
    });
  };

  const getPointerColumn = (event: MouseEvent, state = session.getState()): number | null => {
    if (state.layout === null) {
      return null;
    }

    const rect = dom.scoreStage.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const col = Math.floor(xToColumn(x, state.layout));

    if (x < 0 || x >= state.layout.scoreContentWidth || col < 0 || col >= state.layout.columnCount) {
      return null;
    }

    return col;
  };

  const clearPastePreview = (): void => {
    const state = session.getState();

    if (state.pastePreview.anchorCol === null) {
      return;
    }

    const nextState = {
      ...state,
      pastePreview: {
        anchorCol: null,
      },
    };

    session.setState(nextState);
    syncPastePreviewOverlay(dom, nextState);
  };

  const clearPasteState = (): void => {
    const state = session.getState();

    if (state.rangeClipboard === null && state.pastePreview.anchorCol === null) {
      return;
    }

    const nextState = {
      ...state,
      rangeClipboard: null,
      pastePreview: {
        anchorCol: null,
      },
    };

    session.setState(nextState);
    syncPastePreviewOverlay(dom, nextState);
  };

  const updatePastePreviewForPointer = (event: MouseEvent): void => {
    const state = session.getState();
    const col = getPointerColumn(event, state);

    lastPointerColumn = col;

    if (
      state.mode.kind !== "edit" ||
      state.busy.kind !== "idle" ||
      state.rangeClipboard === null
    ) {
      if (state.pastePreview.anchorCol !== null) {
        clearPastePreview();
      }
      return;
    }

    if (col === state.pastePreview.anchorCol) {
      return;
    }

    const nextState = {
      ...state,
      pastePreview: {
        anchorCol: col,
      },
    };

    session.setState(nextState);
    syncPastePreviewOverlay(dom, nextState);
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

  const setStatusMessage = (level: AppState["statusMessage"]["level"], text: string): void => {
    session.setState({
      ...session.getState(),
      statusMessage: {
        level,
        text,
      },
    });
    syncLeftStatus(dom, session.getState());
  };

  const updateRangeSelection = (anchorHit: ScoreHit, currentHit: ScoreHit): void => {
    const state = session.getState();

    if (state.layout === null) {
      return;
    }

    const rangeSelection = createScoreRangeSelection(
      state.layout,
      state.activeTrackIds,
      anchorHit,
      currentHit,
    );

    if (rangeSelection === null) {
      return;
    }

    const nextState: AppState = {
      ...state,
      rangeSelection,
      pastePreview: {
        anchorCol: null,
      },
      statusMessage: {
        level: "info",
        text: `Selected ${rangeSelection.rowIds.length} row(s), ${rangeSelection.endColExclusive - rangeSelection.startCol} col(s).`,
      },
    };

    session.setState(nextState);
    syncLeftStatus(dom, nextState);
    syncRangeSelectionOverlay(dom, nextState);
    syncPastePreviewOverlay(dom, nextState);
  };

  const deleteRangeSelection = (): void => {
    const state = session.getState();

    if (state.mode.kind !== "edit" || state.rangeSelection === null) {
      return;
    }

    const result = createDeleteEditsForRangeSelection(
      state.document.score,
      state.rangeSelection,
    );

    if (result.edits.length === 0) {
      const protectedText = result.protectedGlobalStartCellCount > 0
        ? ` Protected ${result.protectedGlobalStartCellCount} required start cell(s).`
        : "";

      setStatusMessage("warning", `No selected cells to delete.${protectedText}`);
      return;
    }

    session.setState({
      ...state,
      rangeSelection: null,
      rangeClipboard: null,
      pastePreview: {
        anchorCol: null,
      },
      statusMessage: {
        level: "info",
        text: result.protectedGlobalStartCellCount > 0
          ? `Deleting ${result.edits.length} cell(s). Protected ${result.protectedGlobalStartCellCount} required start cell(s).`
          : `Deleting ${result.edits.length} selected cell(s).`,
      },
    });
    syncRangeSelectionOverlay(dom, session.getState());
    syncPastePreviewOverlay(dom, session.getState());
    session.applyScoreTextEdits(result.edits, {
      label: `Delete ${result.edits.length} cells`,
    });
  };

  const copyRangeSelection = (): void => {
    const state = session.getState();

    if (state.rangeSelection === null) {
      return;
    }

    const rangeClipboard = copyRangeSelectionToClipboard(
      state.document.score,
      state.rangeSelection,
    );
    const anchorCol = lastPointerColumn ?? state.rangeSelection.startCol;

    session.setState({
      ...state,
      rangeSelection: null,
      rangeClipboard,
      pastePreview: {
        anchorCol,
      },
      statusMessage: {
        level: "info",
        text: `Copied ${rangeClipboard.cells.length} cell(s). Move mouse and press Ctrl+V to paste.`,
      },
    });
    syncLeftStatus(dom, session.getState());
    syncRangeSelectionOverlay(dom, session.getState());
    syncPastePreviewOverlay(dom, session.getState());
  };

  const cutRangeSelection = (): void => {
    const state = session.getState();

    if (state.mode.kind !== "edit" || state.rangeSelection === null) {
      return;
    }

    const rangeClipboard = copyRangeSelectionToClipboard(
      state.document.score,
      state.rangeSelection,
    );
    const result = createDeleteEditsForRangeSelection(
      state.document.score,
      state.rangeSelection,
    );

    if (rangeClipboard.cells.length === 0 || result.edits.length === 0) {
      const protectedText = result.protectedGlobalStartCellCount > 0
        ? ` Protected ${result.protectedGlobalStartCellCount} required start cell(s).`
        : "";

      setStatusMessage("warning", `No selected cells to cut.${protectedText}`);
      return;
    }

    const anchorCol = lastPointerColumn ?? state.rangeSelection.startCol;

    session.setState({
      ...state,
      rangeSelection: null,
      rangeClipboard,
      pastePreview: {
        anchorCol,
      },
      statusMessage: {
        level: "info",
        text: result.protectedGlobalStartCellCount > 0
          ? `Cut ${rangeClipboard.cells.length} cell(s). Protected ${result.protectedGlobalStartCellCount} required start cell(s). Move mouse and press Ctrl+V to paste.`
          : `Cut ${rangeClipboard.cells.length} cell(s). Move mouse and press Ctrl+V to paste.`,
      },
    });
    syncLeftStatus(dom, session.getState());
    syncRangeSelectionOverlay(dom, session.getState());
    syncPastePreviewOverlay(dom, session.getState());
    session.applyScoreTextEdits(result.edits, {
      label: `Cut ${result.edits.length} cells`,
    });
  };

  const pasteRangeClipboard = (): void => {
    const state = session.getState();

    if (state.mode.kind !== "edit" || state.layout === null || state.rangeClipboard === null) {
      return;
    }

    const anchorCol = state.pastePreview.anchorCol ??
      state.rangeSelection?.startCol ??
      state.selection?.col ??
      null;

    if (anchorCol === null) {
      setStatusMessage("warning", "Paste needs a score column.");
      return;
    }

    const result = createPasteEditsFromClipboard(
      state.document.score,
      state.layout,
      state.rangeClipboard,
      anchorCol,
    );

    if (result.edits.length === 0) {
      setStatusMessage("warning", "Nothing to paste at this location.");
      return;
    }

    session.setState({
      ...state,
      rangeSelection: null,
      rangeClipboard: null,
      pastePreview: {
        anchorCol: null,
      },
      statusMessage: {
        level: "info",
        text: `Pasting ${result.edits.length} cell(s).`,
      },
    });
    syncRangeSelectionOverlay(dom, session.getState());
    syncPastePreviewOverlay(dom, session.getState());
    session.applyScoreTextEdits(result.edits, {
      label: `Paste ${result.edits.length} cells`,
    });
  };

  const applyLoopPickForHit = (state: AppState, hit: ScoreHit): boolean => {
    if (state.mode.kind !== "view" || state.loop.pickMode === null || !state.loop.enabled) {
      return false;
    }

    const pickedStartTick = state.loop.pickMode === "start"
      ? hit.col
      : state.loop.startTick;
    const pickedEndTick = state.loop.pickMode === "end"
      ? hit.col + 1
      : state.loop.endTick;
    const normalizedLoop = normalizeLoopRange(
      pickedStartTick,
      pickedEndTick,
      state.renderInput.columnCount,
    );

    session.setState({
      ...state,
      loop: {
        ...state.loop,
        ...normalizedLoop,
        pickMode: null,
      },
      statusMessage: {
        level: "info",
        text: `Loop ${state.loop.pickMode} set: ${formatLoopRangeStatus(normalizedLoop, state.renderInput.columnCount)}`,
      },
    });
    syncLeftStatus(dom, session.getState());
    session.render();
    return true;
  };

  const applySinglePointerEdit = (
    hit: ScoreHit,
    options: {
      useClickCycle: boolean;
      forceDelete: boolean;
    },
  ): void => {
    const currentState = session.getState();

    if (
      currentState.rangeSelection !== null ||
      currentState.rangeClipboard !== null ||
      currentState.pastePreview.anchorCol !== null
    ) {
      session.setState({
        ...currentState,
        rangeSelection: null,
        rangeClipboard: null,
        pastePreview: {
          anchorCol: null,
        },
      });
      syncRangeSelectionOverlay(dom, session.getState());
      syncPastePreviewOverlay(dom, session.getState());
    }

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

    lastPointerColumn = getPointerColumn(event, state);

    if (
      state.busy.kind !== "idle" ||
      isGameModeLocked(state.gameMode) ||
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

    event.preventDefault();
    suppressNextClick = true;

    if (event.ctrlKey && event.button === 0) {
      if (hit !== null && (hit.rowKind === "note" || hit.rowKind === "global")) {
        rangeDrag = {
          pointerId: event.pointerId,
          anchorHit: hit,
        };
        updateRangeSelection(hit, hit);
        dom.scoreStage.setPointerCapture(event.pointerId);
        return;
      }

      setStatusMessage("warning", "Range selection needs a note or global cell.");
      return;
    }

    if (event.ctrlKey && event.button === 2) {
      setStatusMessage("warning", "Ctrl + right drag is not used for range selection.");
      return;
    }

    playNotePreviewForHit(hit);

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
          lockedRowKind: hit?.rowKind ?? null,
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
        lockedRowKind: hit?.rowKind ?? null,
        lastHit: hit,
        canDrag: false,
        isDragging: false,
        edits: new Map(),
      };
    }

    dom.scoreStage.setPointerCapture(event.pointerId);
  });

  dom.scoreStage.addEventListener("pointermove", (event) => {
    if (rangeDrag !== null && rangeDrag.pointerId === event.pointerId) {
      const state = session.getState();

      if (
        state.busy.kind !== "idle" ||
        isGameModeLocked(state.gameMode) ||
        state.layout === null
      ) {
        return;
      }

      const hit = getPointerEditHit(event);

      if (hit !== null) {
        updateRangeSelection(rangeDrag.anchorHit, hit);
      }

      return;
    }

    if (dragEdit === null) {
      updatePastePreviewForPointer(event);
      return;
    }

    if (
      dragEdit.pointerId !== event.pointerId ||
      session.getState().busy.kind !== "idle" ||
      isGameModeLocked(session.getState().gameMode) ||
      session.getState().layout === null
    ) {
      return;
    }

    let startedDragThisMove = false;

    if (shouldStartDragEdit(dragEdit, event, DRAG_START_DISTANCE_PX)) {
      dragEdit.isDragging = true;
      startedDragThisMove = true;
      resetRepeatedClickCycle();
      beginDragHistoryTransaction();
      if (dragEdit.startHit !== null) {
        const startEdits = addDragEditForHit(dragEdit, dragEdit.startHit, {
          getSelectionForHit,
          composeDragRawTextForHit: (hit, button) =>
            composeDragRawTextForHit(dom, session.getState(), hit, button),
        });

      queueDragEdits(expandEditsForActiveTracks(startEdits));
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

    queueDragEdits(expandEditsForActiveTracks(edits));
  });

  dom.scoreStage.addEventListener("pointerleave", () => {
    lastPointerColumn = null;
    clearPastePreview();
  });

  dom.scoreStage.addEventListener("pointerup", (event) => {
    if (rangeDrag !== null && rangeDrag.pointerId === event.pointerId) {
      rangeDrag = null;

      if (dom.scoreStage.hasPointerCapture(event.pointerId)) {
        dom.scoreStage.releasePointerCapture(event.pointerId);
      }

      return;
    }

    if (dragEdit === null || dragEdit.pointerId !== event.pointerId) {
      return;
    }

    const completedDrag = dragEdit;
    dragEdit = null;

    if (dom.scoreStage.hasPointerCapture(event.pointerId)) {
      dom.scoreStage.releasePointerCapture(event.pointerId);
    }

    if (completedDrag.isDragging) {
      flushPendingDragEdits();
      endDragHistoryTransaction();
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
    if (rangeDrag !== null && rangeDrag.pointerId === event.pointerId) {
      rangeDrag = null;
      return;
    }

    if (dragEdit === null || dragEdit.pointerId !== event.pointerId) {
      return;
    }

    dragEdit = null;
    flushPendingDragEdits();
    endDragHistoryTransaction();
    resetNotePreviewHit();
  });

  dom.scoreStage.addEventListener("click", (event) => {
    const state = session.getState();

    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    if (state.busy.kind !== "idle" || isGameModeLocked(state.gameMode) || state.layout === null) {
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

    if (applyLoopPickForHit(state, hit)) {
      return;
    }

    if (state.mode.kind === "view") {
      // view mode click은 score mutation 없이 selection/status만 갱신한다.
      session.setState(handleScoreClick(state, hit));
      session.render();
      return;
    }

    if (state.rangeSelection !== null) {
      session.setState({
        ...state,
        rangeSelection: null,
        pastePreview: {
          anchorCol: null,
        },
      });
      syncRangeSelectionOverlay(dom, session.getState());
      syncPastePreviewOverlay(dom, session.getState());
    }

    applySinglePointerEdit(hit, {
      useClickCycle: true,
      forceDelete: false,
    });
  });

  dom.scoreStage.addEventListener("contextmenu", (event) => {
    const state = session.getState();

    if (state.mode.kind !== "edit" || isGameModeLocked(state.gameMode)) {
      return;
    }

    // edit mode의 score stage 우클릭은 브라우저 메뉴 대신 pointer 삭제 입력으로 해석한다.
    event.preventDefault();
  });

  document.addEventListener("keydown", (event) => {
    if (isEditableKeyboardTarget(event.target)) {
      return;
    }

    const state = session.getState();

    if (state.busy.kind !== "idle" || isGameModeLocked(state.gameMode)) {
      return;
    }

    if (event.key === "Delete" || event.key === "Backspace") {
      if (state.rangeSelection !== null && state.mode.kind === "edit") {
        event.preventDefault();
        deleteRangeSelection();
      }

      return;
    }

    if (event.key === "Escape") {
      if (state.rangeClipboard !== null || state.pastePreview.anchorCol !== null) {
        event.preventDefault();
        clearPasteState();
      }

      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      if (state.rangeSelection !== null) {
        event.preventDefault();
        copyRangeSelection();
      }

      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
      if (state.rangeSelection !== null && state.mode.kind === "edit") {
        event.preventDefault();
        cutRangeSelection();
      }

      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      if (state.mode.kind === "edit" && state.rangeClipboard !== null) {
        event.preventDefault();
        pasteRangeClipboard();
      }
    }
  });

  return {
    resetRepeatedClickCycle,
  };
}

/**
 * keyboard shortcut이 텍스트 입력 DOM을 가로채면 안 되는지 확인한다.
 * - 인수 : target : keyboard event target
 * - 반환값 : 텍스트 편집 대상 여부
 */
function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable;
}

/**
 * 선택된 loop start/end tick을 score column 범위 안에서 start <= end가 되도록 정규화한다.
 * - 인수 : startTick : 선택된 시작 tick 또는 기본값
 * - 인수 : endTick : 선택된 끝 tick 또는 기본값
 * - 인수 : columnCount : 현재 score column 수
 * - 반환값 : 정규화된 loop start/end tick
 */
function normalizeLoopRange(
  startTick: number | null,
  endTick: number | null,
  columnCount: number,
): { startTick: number | null; endTick: number | null } {
  const boundedStart = Math.max(0, Math.min(columnCount, startTick ?? 0));
  const boundedEnd = Math.max(0, Math.min(columnCount, endTick ?? columnCount));
  const normalizedStart = Math.min(boundedStart, boundedEnd);
  const normalizedEnd = Math.max(boundedStart, boundedEnd);

  return {
    startTick: normalizedStart === 0 ? null : normalizedStart,
    endTick: normalizedEnd === columnCount ? null : normalizedEnd,
  };
}

/**
 * loop range 상태 메시지용 표시 문자열을 만든다.
 * - 인수 : loop : 정규화된 loop start/end tick
 * - 인수 : columnCount : 현재 score column 수
 * - 반환값 : 사용자에게 표시할 loop range 문자열
 */
function formatLoopRangeStatus(
  loop: { startTick: number | null; endTick: number | null },
  columnCount: number,
): string {
  const startLabel = loop.startTick === null ? "First" : `Col ${loop.startTick}`;
  const endLabel = loop.endTick === null ? "Last" : `Col ${Math.max(0, loop.endTick - 1)}`;

  return columnCount <= 0 ? "empty score" : `${startLabel} ~ ${endLabel}`;
}
