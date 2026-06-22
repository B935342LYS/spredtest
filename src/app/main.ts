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
import { bindEditPanelControls } from "./edit/edit_panel_binding";
import { bindScorePointerControls } from "./edit/edit_pointer_binding";
import { syncLayoutToolbarPresetSelectForCurrentScore } from "./layout/layout_dialog_binding";
import {
  populateAbsolutePitchOptions,
} from "./pitch_label";
import {
  renderApp,
  setStatus,
  syncLeftStatus,
  syncMusicMetadata,
  syncUiControls,
} from "./app_ui_sync";
import {
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
import templateScoreJson from "../assets/templates/default-score.json?raw";

/**
 * sample JSON을 로드하고 base canvas renderer를 실행한다.
 * - 인수 : 없음
 * - 반환값 : 없음
 */
async function boot(): Promise<void> {
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

  const render = (): void => {
    state = renderApp(dom, state);
    syncMusicMetadata(dom, state);
    syncLeftStatus(dom, state);
    syncUiControls(dom, state);
    syncLayoutToolbarPresetSelectForCurrentScore(dom, { getState: () => state });
    syncPlaybackUi(dom, state, playbackRuntime);
  };

  playbackRuntime = createAppPlaybackRuntime(dom, state);
  notePreviewRuntime = createAppNotePreviewRuntime(dom);
  youtubeControl = createNoopYoutubeControl();

  const resetPlaybackForCurrentState = (): void => {
    stopPlaybackAnimation();
    playbackRuntime.controller.dispose();
    playbackRuntime = createAppPlaybackRuntime(dom, state);
    syncPlaybackUi(dom, state, playbackRuntime);
  };

  const resetPlaybackForCurrentStatePausedAt = (scoreSeconds: number): void => {
    stopPlaybackAnimation();
    playbackRuntime.controller.dispose();
    playbackRuntime = createAppPlaybackRuntime(dom, state);
    playbackRuntime.controller.pauseAtSeconds(scoreSeconds);
    syncPlaybackUi(dom, state, playbackRuntime);
  };

  const resetNotePreviewForCurrentDom = (): void => {
    notePreviewRuntime.dispose();
    notePreviewRuntime = createAppNotePreviewRuntime(dom);
  };

  const applyScoreTextEdits = (edits: ScoreTextEdit[]): void => {
    if (edits.length === 0) {
      return;
    }

    state = {
      ...state,
      busy: { kind: "applyingEdit", message: "Applying edit..." },
    };
    syncLeftStatus(dom, state);
    syncUiControls(dom, state);

    // 모아둔 rawText 편집을 하나의 full rebuild 경로로 넘겨 드래그 입력 중 rebuild 반복을 피한다.
    state = applyRawTextBatchEditToState(state, edits);

    render();
    resetPlaybackForCurrentState();
  };

  const loadScoreJsonText = (jsonText: string, sourceLabel: string): void => {
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
    resetNotePreviewForCurrentDom,
    applyScoreTextEdits,
    get youtubeControl(): YoutubePlaybackControl {
      return youtubeControl;
    },
  };

  render();
  syncPlaybackUi(dom, state, playbackRuntime);
  setStatus(0, "template auto load: done");

  youtubeControl = bindYoutubeControls(dom, appSession);
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
