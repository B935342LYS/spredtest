/**
 * 브라우저 앱 진입점이다.
 * sample RuntimeDocument를 로드하고 DOM event를 app 상태 갱신 흐름에 연결한다.
 */

import { applyEditEffects, type EditEffectsResult } from "./edit/edit_commit_effects";
import { collectAppDom } from "./app_dom";
import {
  applyRawTextBatchEditToState,
  loadScoreTextAsInitialState,
} from "./app_runtime";
import { bindFileControls } from "./app_file_binding";
import { bindExampleControls } from "./examples/example_binding";
import type { ExampleBindingSession } from "./examples/example_binding";
import { bindViewControls } from "./app_view_binding";
import type { AppState, UndoHistoryState } from "./app_types";
import type { ScoreTextEdit } from "../core/score/score_text_edit";
import {
  buildCellHistoryPatches,
  captureHistoryCellLookup,
  type HistoryCellLookup,
  createScoreTextEditsFromHistoryPatches,
  createUndoHistoryEntryId,
  popRedoHistoryEntry,
  popUndoHistoryEntry,
  pushUndoHistoryEntry,
} from "./edit/edit_history";
import { getScoreTextEditInvalidationKind } from "../core/score/score_text_edit";
import { bindEditPanelControls } from "./edit/edit_panel_binding";
import { bindScorePointerControls } from "./edit/edit_pointer_binding";
import { syncLayoutToolbarPresetSelectForCurrentScore } from "./layout/layout_dialog_binding";
import {
  populateAbsolutePitchOptions,
} from "./pitch_label";
import {
  renderApp,
  renderAppPartial,
  setStatus,
  syncLeftStatus,
  syncMusicMetadata,
  syncUiControls,
} from "./app_ui_sync";
import {
  createPlaybackLoopStateFromApp,
  createAppPlaybackRuntime,
  type AppPlaybackRuntime,
} from "./playback/app_playback";
import { bindPlaybackControls } from "./playback/app_playback_binding";
import {
  createAppNotePreviewRuntime,
  type AppNotePreviewRuntime,
} from "./playback/app_note_preview";
import {
  syncPlaybackUi,
} from "./playback/app_playback_ui";
import { bindTrackControls } from "./app_track_binding";
import {
  bindYoutubeControls,
  type YoutubePlaybackControl,
} from "./youtube/youtube_binding";
import { bindGameModeControls } from "./game/game_binding";
import { isGameModeLocked } from "./game/game_types";
import {
  beginPerfSession,
  endPerfSession,
  installPerfProfilerConsoleApi,
  measurePerf,
} from "../infra/perf_profiler";
import templateScoreJson from "../assets/templates/default-score.json?raw";

/** 드래그 중 성공한 편집을 하나의 이력으로 묶기 위한 시작 상태. */
type ScoreEditHistoryTransaction = {
  label: string;
  beforeLookup: HistoryCellLookup;
  edits: ScoreTextEdit[];
};

/**
 * sample JSON을 로드하고 base canvas renderer를 실행한다.
 * - 인수 : 없음
 * - 반환값 : 없음
 */
async function boot(): Promise<void> {
  installPerfProfilerConsoleApi();

  // score viewer DOM 요소와 renderer가 사용할 canvas target을 준비한다.
  const dom = collectAppDom();

  populateAbsolutePitchOptions(dom.absolutePitchSelect);

  const templateLoadResult = loadScoreTextAsInitialState(
    templateScoreJson,
    "template score",
    "template",
  );

  if (!templateLoadResult.ok) {
    throw new Error(templateLoadResult.message);
  }

  let state = templateLoadResult.state;
  let playbackRuntime: AppPlaybackRuntime;
  let notePreviewRuntime: AppNotePreviewRuntime;
  let youtubeControl: YoutubePlaybackControl;
  let stopPlaybackAnimation = (): void => {};
  let resetRepeatedClickCycle = (): void => {};
  let activeHistoryTransaction: ScoreEditHistoryTransaction | null = null;

  const render = (): void => {
    const perfSession = beginPerfSession("app.render");

    try {
      state = measurePerf("app.render.renderApp", () => renderApp(dom, state));
      measurePerf("app.render.syncMusicMetadata", () => syncMusicMetadata(dom, state));
      measurePerf("app.render.syncLeftStatus", () => syncLeftStatus(dom, state));
      measurePerf("app.render.syncUiControls", () => syncUiControls(dom, state));
      measurePerf("app.render.syncLayoutToolbarPresetSelect", () =>
        syncLayoutToolbarPresetSelectForCurrentScore(dom, { getState: () => state })
      );
      measurePerf("app.render.syncPlaybackUi", () => syncPlaybackUi(dom, state, playbackRuntime));
    } finally {
      endPerfSession(perfSession);
    }
  };

  /**
   * 완성된 artifact 입력을 편집 종류에 맞는 레이어에 렌더하고 UI를 동기화한다.
   * - 인수 : edits : 적용한 cell 편집 batch
   * - 반환값 : 없음
   */
  const renderAfterScoreTextEdit = (edits: ScoreTextEdit[]): void => {
    const redrawScope = getScoreTextEditRedrawScope(edits);

    if (redrawScope === "note") {
      state = measurePerf("app.editRender.renderAppPartial.note", () =>
        renderAppPartial(dom, state, "note")
      );
    } else if (redrawScope === "global") {
      state = measurePerf("app.editRender.renderAppPartial.global", () =>
        renderAppPartial(dom, state, "global")
      );
    } else {
      state = measurePerf("app.editRender.renderApp.full", () => renderApp(dom, state));
    }

    measurePerf("app.editRender.syncMusicMetadata", () => syncMusicMetadata(dom, state));
    measurePerf("app.editRender.syncLeftStatus", () => syncLeftStatus(dom, state));
    measurePerf("app.editRender.syncUiControls", () => syncUiControls(dom, state));
    measurePerf("app.editRender.syncLayoutToolbarPresetSelect", () =>
      syncLayoutToolbarPresetSelectForCurrentScore(dom, { getState: () => state })
    );
    measurePerf("app.editRender.syncPlaybackUi", () => syncPlaybackUi(dom, state, playbackRuntime));
  };

  playbackRuntime = createAppPlaybackRuntime(dom, state);
  notePreviewRuntime = createAppNotePreviewRuntime(dom);
  youtubeControl = createNoopYoutubeControl();

  const resetPlaybackForCurrentState = (): void => {
    measurePerf("playback.reset.stopAnimation", () => stopPlaybackAnimation());
    measurePerf("playback.reset.disposeController", () => playbackRuntime.controller.dispose());
    playbackRuntime = measurePerf("playback.reset.createRuntime", () =>
      createAppPlaybackRuntime(dom, state)
    );
    measurePerf("playback.reset.syncPlaybackUi", () => syncPlaybackUi(dom, state, playbackRuntime));
  };

  const resetPlaybackForCurrentStatePausedAt = (scoreSeconds: number): void => {
    stopPlaybackAnimation();
    playbackRuntime.controller.dispose();
    playbackRuntime = createAppPlaybackRuntime(dom, state);
    playbackRuntime.controller.pauseAtSeconds(
      scoreSeconds,
      createPlaybackLoopStateFromApp(state, playbackRuntime),
    );
    syncPlaybackUi(dom, state, playbackRuntime);
  };

  /**
   * 새 재생 후보를 준비한 뒤 기존 runtime을 교체하고 현재 tick을 일시정지 위치로 보존한다.
   * - 인수 : 없음
   * - 반환값 : 없음. 실패 시 후보 자원을 정리하고 상위 복구 경계로 예외 전달
   */
  const resetPlaybackForCurrentStatePreservingPosition = (): void => {
    const previous = playbackRuntime;
    const wasStopped = previous.controller.getState().kind === "stopped";
    const currentTick = previous.timeMapper.secondsToTick(previous.controller.getCurrentScoreSeconds());
    const candidate = createAppPlaybackRuntime(dom, state);
    try {
      if (!wasStopped) {
        candidate.controller.pauseAtSeconds(
          candidate.timeMapper.tickToSeconds(currentTick),
          createPlaybackLoopStateFromApp(state, candidate),
        );
      }
      stopPlaybackAnimation();
      previous.controller.dispose();
    } catch (error: unknown) {
      candidate.controller.dispose();
      throw error;
    }
    playbackRuntime = candidate;
    syncPlaybackUi(dom, state, playbackRuntime);
  };

  /**
   * 하나의 정리 실패가 나머지 오디오·영상 중단을 가로막지 않게 각각 실행한다.
   * - 인수 : 없음
   * - 반환값 : 없음. 정리 실패가 있으면 모두 시도한 뒤 예외 전달
   */
  const stopPlaybackAfterEditFailure = (): void => {
    const errors: unknown[] = [];
    for (const stop of [stopPlaybackAnimation, () => playbackRuntime.controller.stop(),
      () => playbackRuntime.backend.stopAll(), () => youtubeControl.pause(), () => notePreviewRuntime.dispose()]) {
      try { stop(); } catch (error: unknown) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Playback cleanup failed.");
  };

  /**
   * 오류 상태를 UI에 반영하되 UI 자체의 예외로 편집 확정 여부를 바꾸지 않는다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const syncEditOutcomeUi = (): void => {
    for (const sync of [() => syncLeftStatus(dom, state), () => syncUiControls(dom, state),
      () => syncPlaybackUi(dom, state, playbackRuntime)]) {
      try { sync(); } catch (error: unknown) { console.error("Edit UI sync failed", error); }
    }
    // 공용 UI 동기화가 실패해도 재생 진입 버튼은 독립적으로 잠근다.
    if (state.outputSyncError !== undefined) {
      dom.playButton.disabled = true;
      dom.seekInput.disabled = true;
      dom.practiceModeButton.disabled = true;
    }
  };

  const resetNotePreviewForCurrentDom = (): void => {
    notePreviewRuntime.dispose();
    notePreviewRuntime = createAppNotePreviewRuntime(dom);
  };

  /**
   * 편집 후보와 이력을 함께 확정한 뒤 화면과 재생을 갱신한다.
   * - 인수 : edits : 적용할 cell 편집 batch
   * - 인수 : options : 이력 기록 여부와 Undo/Redo 성공 시 확정할 history 후보
   * - 반환값 : 편집 거절 또는 변경·무변경 확정과 외부 효과의 반영 결과
   */
  const applyScoreTextEdits = (
    edits: ScoreTextEdit[],
    options: {
      label?: string;
      recordHistory?: boolean;
      statusText?: string;
      historyAfter?: UndoHistoryState;
      uiAfter?: Pick<AppState, "rangeSelection" | "rangeClipboard" | "pastePreview">;
    } = {},
  ): { kind: "rejected" } | { kind: "applied" | "unchanged"; output: EditEffectsResult } => {
    if (edits.length === 0) return { kind: "rejected" };

    const perfSession = beginPerfSession(`app.applyScoreTextEdits ${edits.length} edit(s)`);
    const previousState = state;
    const shouldRecordHistory = options.recordHistory !== false &&
      options.historyAfter === undefined && activeHistoryTransaction === null;

    try {
      let nextState: AppState;
      let changed = false;
      try {
        state = {
          ...previousState,
          busy: { kind: "applyingEdit", message: "Applying edit..." },
        };
        measurePerf("app.edit.syncBusyStatus", () => {
          syncLeftStatus(dom, state);
          syncUiControls(dom, state);
        });

        // 부분 산출물 계산은 이전 정상 상태로 수행하고 성공 여부를 먼저 확인한다.
        const result = measurePerf("app.edit.applyRawTextBatchEditToState", () =>
          applyRawTextBatchEditToState(previousState, edits)
        );
        if (result.kind === "rejected") {
          state = { ...previousState, busy: { kind: "idle" }, statusMessage: result.message };
          syncEditOutcomeUi();
          return { kind: "rejected" };
        }
        nextState = result.state;
        changed = result.kind === "applied";

        // history 생성까지 후보 상태에서 끝내어 계산 실패가 악보만 확정하지 않게 한다.
        if (shouldRecordHistory && changed) {
          const patches = measurePerf("app.edit.buildCellHistoryPatches", () =>
            buildCellHistoryPatches(previousState.document.indexes, nextState.document.indexes, edits)
          );
          nextState = {
            ...nextState,
            history: measurePerf("app.edit.pushUndoHistoryEntry", () =>
              pushUndoHistoryEntry(previousState.history, {
                id: createUndoHistoryEntryId(),
                label: options.label ?? createDefaultHistoryLabel(edits),
                patches,
              })
            ),
          };
        }
        if (options.uiAfter !== undefined) nextState = { ...nextState, ...options.uiAfter };
        if (options.historyAfter !== undefined) {
          // Undo/Redo의 스택 이동과 선택 해제는 실제 복원에 성공한 경우에만 확정한다.
          nextState = {
            ...nextState,
            history: options.historyAfter,
            selection: null,
            rangeSelection: null,
            rangeClipboard: null,
            pastePreview: { anchorCol: null },
          };
        }
        if (options.statusText !== undefined) {
          nextState = { ...nextState, statusMessage: { level: "info", text: options.statusText } };
        }
      } catch (error: unknown) {
        // 상태 확정 이전의 계산/UI 준비 오류는 기존 악보·산출물·이력을 보존한다.
        state = {
          ...previousState,
          busy: { kind: "idle" },
          statusMessage: {
            level: "error",
            text: error instanceof Error ? error.message : "Unknown edit error.",
          },
        };
        syncEditOutcomeUi();
        return { kind: "rejected" };
      }

      state = { ...nextState, busy: { kind: "idle" } };
      if (changed && activeHistoryTransaction !== null && options.recordHistory !== false &&
          options.historyAfter === undefined) {
        activeHistoryTransaction.edits.push(...edits);
      }
      // 저장된 편집은 유지하고 화면·재생의 반영 결과만 별도로 판단한다.
      let requiresPlaybackUpdate = changed || previousState.outputSyncError !== undefined;
      const output = applyEditEffects({
        render: () => {
          if (previousState.outputSyncError !== undefined) render();
          else if (changed) renderAfterScoreTextEdit(edits);
          else {
            // 악보는 같아도 선택·범위·미리보기와 busy 표시는 성공 상태로 반영한다.
            syncLeftStatus(dom, state);
            syncUiControls(dom, state);
            syncPlaybackUi(dom, state, playbackRuntime);
          }
        },
        refresh: () => { requiresPlaybackUpdate = true; render(); },
        updatePlayback: () => { if (requiresPlaybackUpdate) resetPlaybackForCurrentStatePreservingPosition(); },
        stopPlayback: stopPlaybackAfterEditFailure,
      });
      state = {
        ...state,
        outputSyncError: output.kind === "failed" ? `${output.stage}: ${output.message}` : undefined,
        statusMessage: output.kind === "failed"
          ? { level: "error", text: `Edit applied, but ${output.stage} update failed. Playback blocked; retry an edit or save and reload. ${output.message}` }
          : output.recovered
            ? { level: "warning", text: "Edit applied. Display recovered; playback is stopped." }
            : state.statusMessage,
      };
      if (output.kind === "failed" || output.recovered || previousState.outputSyncError !== undefined) syncEditOutcomeUi();
      return { kind: changed ? "applied" : "unchanged", output };
    } finally {
      endPerfSession(perfSession);
    }
  };

  /**
   * 드래그 시작 시 두 좌표 Map만 참조하여 순변경 비교의 기준을 보관한다.
   * - 인수 : label : 완료 이력의 이름
   * - 반환값 : 없음. 진행 중인 transaction이 있으면 유지한다.
   */
  const beginScoreEditHistoryTransaction = (label: string): void => {
    if (activeHistoryTransaction !== null) {
      return;
    }

    activeHistoryTransaction = {
      label,
      beforeLookup: captureHistoryCellLookup(state.document.indexes),
      edits: [],
    };
  };

  /**
   * 시작/종료 인덱스로 드래그의 순변경을 기록하고 시작 snapshot을 해제한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const endScoreEditHistoryTransaction = (): void => {
    if (activeHistoryTransaction === null) {
      return;
    }

    const transaction = activeHistoryTransaction;

    activeHistoryTransaction = null;

    if (transaction.edits.length === 0) {
      return;
    }

    const patches = buildCellHistoryPatches(
      transaction.beforeLookup,
      state.document.indexes,
      transaction.edits,
    );

    state = {
      ...state,
      history: pushUndoHistoryEntry(state.history, {
        id: createUndoHistoryEntryId("drag"),
        label: transaction.label,
        patches,
      }),
    };
    syncLeftStatus(dom, state);
    syncUiControls(dom, state);
  };

  /**
   * 이력 transaction과 시작 snapshot 참조를 해제한다. 적용된 악보를 되돌리지는 않는다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const cancelScoreEditHistoryTransaction = (): void => {
    activeHistoryTransaction = null;
  };

  /**
   * 최근 이력의 이전 값을 적용하고 성공한 경우에만 redo로 이동한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const applyUndo = (): void => {
    if (state.busy.kind !== "idle" || isGameModeLocked(state.gameMode)) {
      return;
    }

    const result = popUndoHistoryEntry(state.history);

    if (result.entry === null) {
      return;
    }

    applyScoreTextEdits(
      createScoreTextEditsFromHistoryPatches(result.entry.patches, "before"),
      {
        recordHistory: false,
        historyAfter: result.history,
        statusText: `Undid: ${result.entry.label}`,
      },
    );
  };

  /**
   * redo 이력의 이후 값을 적용하고 성공한 경우에만 undo로 이동한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const applyRedo = (): void => {
    if (state.busy.kind !== "idle" || isGameModeLocked(state.gameMode)) {
      return;
    }

    const result = popRedoHistoryEntry(state.history);

    if (result.entry === null) {
      return;
    }

    applyScoreTextEdits(
      createScoreTextEditsFromHistoryPatches(result.entry.patches, "after"),
      {
        recordHistory: false,
        historyAfter: result.history,
        statusText: `Redid: ${result.entry.label}`,
      },
    );
  };

  const loadScoreJsonText = (jsonText: string, sourceLabel: string): void => {
    const previousPracticeJudgeMode = state.practiceJudgeMode;

    state = {
      ...state,
      busy: { kind: "loadingScore", message: `Loading ${sourceLabel}...` },
    };
    syncLeftStatus(dom, state);
    syncUiControls(dom, state);

    const nextLoadResult = loadScoreTextAsInitialState(jsonText, sourceLabel);

    if (!nextLoadResult.ok) {
      state = {
        ...state,
        busy: { kind: "idle" },
        statusMessage: {
          level: "error",
          text: nextLoadResult.message,
        },
      };
      syncLeftStatus(dom, state);
      syncUiControls(dom, state);
      return;
    }

    dom.editToggle.checked = false;
    state = {
      ...nextLoadResult.state,
      // 악보를 교체해도 저장소 접근 실패 시의 페이지 내 환경 보정을 보존한다.
      youtubeLocalOffsetMs: state.youtubeLocalOffsetMs,
      practiceJudgeMode: previousPracticeJudgeMode,
      busy: { kind: "idle" },
    };
    render();
    resetPlaybackForCurrentState();
    youtubeControl.syncInputsFromScore();
  };

  const appSession = {
    getState: () => state,
    setState: (nextState: typeof state): void => {
      state = nextState;
    },
    render,
    loadScoreJsonText,
    getPlaybackRuntime: () => playbackRuntime,
    getNotePreviewRuntime: () => notePreviewRuntime,
    resetPlaybackForCurrentState,
    resetPlaybackForCurrentStatePausedAt,
    resetPlaybackForCurrentStatePreservingPosition,
    resetNotePreviewForCurrentDom,
    applyScoreTextEdits,
    beginScoreEditHistoryTransaction,
    endScoreEditHistoryTransaction,
    cancelScoreEditHistoryTransaction,
    get youtubeControl(): YoutubePlaybackControl {
      return youtubeControl;
    },
  };

  render();
  syncPlaybackUi(dom, state, playbackRuntime);
  setStatus(0, "template auto load: done");

  dom.undoButton.addEventListener("click", () => {
    applyUndo();
  });
  dom.redoButton.addEventListener("click", () => {
    applyRedo();
  });
  document.addEventListener("keydown", (event) => {
    if (isEditableKeyboardTarget(event.target)) {
      return;
    }

    const key = event.key.toLowerCase();

    if ((event.ctrlKey || event.metaKey) && key === "z" && !event.shiftKey) {
      event.preventDefault();
      applyUndo();
      return;
    }

    if (
      ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "z") ||
      (event.ctrlKey && key === "y")
    ) {
      event.preventDefault();
      applyRedo();
    }
  }, { capture: true });

  youtubeControl = bindYoutubeControls(dom, appSession);
  bindGameModeControls(dom, appSession);
  bindViewControls(dom, appSession);
  stopPlaybackAnimation = bindPlaybackControls(dom, appSession).stopPlaybackAnimation;
  bindTrackControls(dom, appSession);
  bindFileControls(dom, appSession);
  // Examples에는 전체 상태 참조/교체 권한 대신 필요한 작업만 전달한다.
  const exampleSession: ExampleBindingSession = {
    /**
     * 실행 시점의 Practice 잠금을 조회한다.
     * - 인수 : 없음
     * - 반환값 : Practice 잠금 여부
     */
    isPracticeLocked: () => isGameModeLocked(state.gameMode),
    /**
     * 최신 앱 상태에 로딩 표시를 반영하고 입력 잠금을 동기화한다.
     * - 인수 : message : 진행 안내
     * - 반환값 : 없음
     */
    beginLoading(message) {
      state = { ...state, busy: { kind: "loadingScore", message } };
      syncLeftStatus(dom, state);
      syncUiControls(dom, state);
    },
    /**
     * 최신 앱 상태의 busy를 해제하고 결과를 동기화한다.
     * - 인수 : text : 결과 문구
     * - 인수 : level : 상태 중요도
     * - 반환값 : 없음
     */
    reportIdleStatus(text, level) {
      state = { ...state, busy: { kind: "idle" }, statusMessage: { text, level } };
      syncLeftStatus(dom, state);
      syncUiControls(dom, state);
    },
    /**
     * 공통 로드 경로의 처리 직후 결과만 Examples에 전달한다.
     * - 인수 : jsonText : 받은 Score JSON
     * - 인수 : sourceLabel : 로드 출처
     * - 반환값 : 기존 dialog 닫기 조건인 오류 상태 아님 여부
     */
    loadScoreJsonText(jsonText, sourceLabel) {
      loadScoreJsonText(jsonText, sourceLabel);
      return state.statusMessage.level !== "error";
    },
  };
  bindExampleControls(dom, exampleSession);
  dom.manualButton.addEventListener("click", () => {
    window.open("./manual/index.html", "_blank", "noopener");
  });
  resetRepeatedClickCycle = bindScorePointerControls(dom, appSession).resetRepeatedClickCycle;
  bindEditPanelControls(dom, {
    ...appSession,
    resetRepeatedClickCycle: () => {
      resetRepeatedClickCycle();
    },
  });
}

/**
 * edit batch의 기본 undo history label을 만든다.
 * - 인수 : edits : 적용된 score text edit 목록
 * - 반환값 : Undo button tooltip과 status에 사용할 짧은 label
 */
function createDefaultHistoryLabel(edits: readonly ScoreTextEdit[]): string {
  if (edits.length === 1) {
    const edit = edits[0];

    return edit === undefined
      ? "Edit cell"
      : `Edit ${edit.selection.rowId}:${edit.selection.col}`;
  }

  return `Edit ${edits.length} cells`;
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
 * YouTube binding 생성 전 playback session에 넣어둘 no-op control을 만든다.
 * - 인수 : 없음
 * - 반환값 : 아무 동작도 하지 않는 YouTube playback control
 */
function createNoopYoutubeControl(): YoutubePlaybackControl {
  return {
    syncInputsFromScore(): void {},
    playAtCurrentScoreTime(): void {},
    pause(): void {},
    stop(): void {},
    seekToCurrentScoreTime(): void {},
    dispose(): void {},
  };
}

window.addEventListener("DOMContentLoaded", () => {
  boot().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown boot error.";
    setStatus(0, "template auto load: failed");
    setStatus(1, message);
  });
});

/**
 * score text edit batch의 renderer redraw scope를 계산한다.
 * - 인수 : edits : 적용한 score text edit batch
 * - 반환값 : note/global/all redraw scope
 */
function getScoreTextEditRedrawScope(edits: ScoreTextEdit[]): "note" | "global" | "all" {
  const invalidationKind = getScoreTextEditInvalidationKind(edits);

  if (invalidationKind === "noteCell") {
    return "note";
  }

  if (invalidationKind === "globalCell") {
    return "global";
  }

  return "all";
}
