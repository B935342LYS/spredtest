/**
 * 브라우저 앱 진입점이다.
 * sample RuntimeDocument를 로드하고 DOM event를 app 상태 갱신 흐름에 연결한다.
 */

import { collectAppDom } from "./app_dom";
import {
  applyRawTextBatchEditToState,
  loadScoreTextAsInitialState,
} from "./app_runtime";
import { bindFileControls } from "./app_file_binding";
import { bindViewControls } from "./app_view_binding";
import type { ScoreTextEdit } from "./edit/edit_apply";
import {
  buildCellHistoryPatches,
  createScoreTextEditsFromHistoryPatches,
  createUndoHistoryEntryId,
  popRedoHistoryEntry,
  popUndoHistoryEntry,
  pushUndoHistoryEntry,
} from "./edit/edit_history";
import {
  createScoreTextEditPartialPlan,
  getScoreTextEditRedrawScope,
} from "../orchestration/partial_rebuild/partial_rebuild_app_plan";
import { applyPartialRenderInputPatch } from "../orchestration/partial_rebuild/partial_rebuild_render_patch";
import type { PartialRebuildPlan } from "../orchestration/partial_rebuild/partial_rebuild_types";
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
import type { ScoreFile } from "../core/score/types";
import {
  beginPerfSession,
  endPerfSession,
  installPerfProfilerConsoleApi,
  measurePerf,
} from "../infra/perf_profiler";
import templateScoreJson from "../assets/templates/default-score.json?raw";

type ScoreEditHistoryTransaction = {
  label: string;
  beforeScore: ScoreFile;
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

  const renderAfterScoreTextEdit = (edits: ScoreTextEdit[], plan: PartialRebuildPlan | null): void => {
    const redrawScope = plan?.renderer.redrawScope ?? getScoreTextEditRedrawScope(edits);

    if (redrawScope === "note") {
      state = measurePerf("app.editRender.renderAppPartial.note", () =>
        renderAppPartial(dom, state, "note", plan?.renderer.dirtyTickRange ?? null)
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

  const resetPlaybackForCurrentStatePreservingPosition = (): void => {
    const playbackState = playbackRuntime.controller.getState();

    if (playbackState.kind === "stopped") {
      resetPlaybackForCurrentState();
      return;
    }

    const currentTick = playbackRuntime.timeMapper.secondsToTick(
      playbackRuntime.controller.getCurrentScoreSeconds(),
    );

    measurePerf("playback.preserve.stopAnimation", () => stopPlaybackAnimation());
    measurePerf("playback.preserve.disposeController", () => playbackRuntime.controller.dispose());
    playbackRuntime = measurePerf("playback.preserve.createRuntime", () =>
      createAppPlaybackRuntime(dom, state)
    );
    measurePerf("playback.preserve.pauseAtSeconds", () =>
      playbackRuntime.controller.pauseAtSeconds(
        playbackRuntime.timeMapper.tickToSeconds(currentTick),
        createPlaybackLoopStateFromApp(state, playbackRuntime),
      )
    );
    measurePerf("playback.preserve.syncPlaybackUi", () => syncPlaybackUi(dom, state, playbackRuntime));
  };

  const resetNotePreviewForCurrentDom = (): void => {
    notePreviewRuntime.dispose();
    notePreviewRuntime = createAppNotePreviewRuntime(dom);
  };

  const applyScoreTextEdits = (
    edits: ScoreTextEdit[],
    options: {
      label?: string;
      recordHistory?: boolean;
      statusText?: string;
    } = {},
  ): void => {
    if (edits.length === 0) {
      return;
    }

    const perfSession = beginPerfSession(`app.applyScoreTextEdits ${edits.length} edit(s)`);
    const shouldRecordHistory = options.recordHistory !== false &&
      activeHistoryTransaction === null;
    const previousState = state;

    try {
      state = {
        ...state,
        busy: { kind: "applyingEdit", message: "Applying edit..." },
      };
      measurePerf("app.edit.syncBusyStatus", () => {
        syncLeftStatus(dom, state);
        syncUiControls(dom, state);
      });

      // 모아둔 rawText 편집을 하나의 full rebuild 경로로 넘겨 드래그 입력 중 rebuild 반복을 피한다.
      state = measurePerf("app.edit.applyRawTextBatchEditToState", () =>
        applyRawTextBatchEditToState(state, edits)
      );

      if (activeHistoryTransaction !== null && options.recordHistory !== false) {
        activeHistoryTransaction.edits.push(...edits);
      }

      if (shouldRecordHistory) {
        const patches = measurePerf("app.edit.buildCellHistoryPatches", () =>
          buildCellHistoryPatches(
            previousState.document.score,
            state.document.score,
            edits,
          )
        );

        state = {
          ...state,
          history: measurePerf("app.edit.pushUndoHistoryEntry", () =>
            pushUndoHistoryEntry(state.history, {
              id: createUndoHistoryEntryId(),
              label: options.label ?? createDefaultHistoryLabel(edits),
              patches,
            })
          ),
        };
      }

      if (options.statusText !== undefined) {
        state = {
          ...state,
          statusMessage: {
            level: "info",
            text: options.statusText,
          },
        };
      }

      const partialPlan = measurePerf("app.edit.createScoreTextEditPartialPlan", () =>
        createScoreTextEditPartialPlan({
          previousState,
          nextState: state,
          edits,
        })
      );

      if (partialPlan !== null) {
        state = {
          ...state,
          renderInput: measurePerf("app.edit.applyPartialRenderInputPatch", () =>
            applyPartialRenderInputPatch(
              previousState.renderInput,
              state.renderInput,
              partialPlan,
            )
          ),
        };
      }

      measurePerf("app.edit.renderAfterScoreTextEdit", () =>
        renderAfterScoreTextEdit(edits, partialPlan)
      );
      measurePerf("app.edit.resetPlaybackPreservingPosition", () =>
        resetPlaybackForCurrentStatePreservingPosition()
      );
    } finally {
      endPerfSession(perfSession);
    }
  };

  const beginScoreEditHistoryTransaction = (label: string): void => {
    if (activeHistoryTransaction !== null) {
      return;
    }

    activeHistoryTransaction = {
      label,
      beforeScore: state.document.score,
      edits: [],
    };
  };

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
      transaction.beforeScore,
      state.document.score,
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

  const cancelScoreEditHistoryTransaction = (): void => {
    activeHistoryTransaction = null;
  };

  const applyUndo = (): void => {
    if (state.busy.kind !== "idle" || isGameModeLocked(state.gameMode)) {
      return;
    }

    const result = popUndoHistoryEntry(state.history);

    if (result.entry === null) {
      return;
    }

    state = {
      ...state,
      history: result.history,
      selection: null,
      rangeSelection: null,
      rangeClipboard: null,
      pastePreview: {
        anchorCol: null,
      },
    };
    applyScoreTextEdits(
      createScoreTextEditsFromHistoryPatches(result.entry.patches, "before"),
      {
        recordHistory: false,
        statusText: `Undid: ${result.entry.label}`,
      },
    );
  };

  const applyRedo = (): void => {
    if (state.busy.kind !== "idle" || isGameModeLocked(state.gameMode)) {
      return;
    }

    const result = popRedoHistoryEntry(state.history);

    if (result.entry === null) {
      return;
    }

    state = {
      ...state,
      history: result.history,
      selection: null,
      rangeSelection: null,
      rangeClipboard: null,
      pastePreview: {
        anchorCol: null,
      },
    };
    applyScoreTextEdits(
      createScoreTextEditsFromHistoryPatches(result.entry.patches, "after"),
      {
        recordHistory: false,
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
