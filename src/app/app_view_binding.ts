/**
 * zoom, fullscreen, details dialog 같은 view control event를 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "./app_types";
import {
  columnToX,
  xToColumn,
} from "../renderer/canvas_coordinate";
import {
  applyClearAllScoreToState,
  applyExpandColumnsToState,
  applyMenuThemeToState,
  applyMusicDataEditToState,
  applyReverseRowsToState,
  applyTrimRightColumnsToState,
} from "./app_runtime";
import {
  fitScoreHeightZoom,
  populateDetailsDialog,
  readDetailsDialogMusicData,
  readIntegerInput,
  setZoomPercent,
  syncFullscreenButton,
  toggleFullscreen,
} from "./app_view_actions";
import {
  renderDynamicViewportLayers,
  syncLayoutScroll,
  syncLeftStatus,
  syncUiControls,
} from "./app_ui_sync";
import {
  bindLayoutDialogControls,
  syncLayoutToolbarPresetSelectForCurrentScore,
} from "./layout/layout_dialog_binding";
import type { YoutubePlaybackControl } from "./youtube/youtube_binding";

/** view binding이 app 상태와 render 흐름을 제어하기 위한 session 입력. */
export type ViewBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  render(): void;
  youtubeControl?: YoutubePlaybackControl;
};

/** view control 전체 binding이 layout 적용 후 playback 재생성을 요청하기 위한 session 입력. */
type ViewControlsBindingSession = ViewBindingSession & {
  resetPlaybackForCurrentState(): void;
  resetPlaybackForCurrentStatePreservingPosition(): void;
};

/**
 * 현재 score 높이에 맞춰 zoom을 갱신하고 상태 메시지를 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
export function fitScoreHeight(
  dom: AppDom,
  session: ViewBindingSession,
): void {
  const state = session.getState();
  const leftEdgeTick = getViewportLeftEdgeTick(dom, state);
  const statusMessage = fitScoreHeightZoom(dom, state);

  if (statusMessage.level === "info") {
    session.render();
    restoreViewportLeftEdgeTick(dom, session, leftEdgeTick);
  }

  session.setState({
    ...session.getState(),
    statusMessage,
  });
  syncLeftStatus(dom, session.getState());

  if (statusMessage.level !== "info") {
    return;
  }

  requestAnimationFrame(() => {
    const secondPassLeftEdgeTick = getViewportLeftEdgeTick(dom, session.getState());
    const previousZoomValue = dom.zoomInput.value;
    const nextStatusMessage = fitScoreHeightZoom(dom, session.getState());

    // 첫 render 이후 확정된 layout에서 목표 높이가 달라졌을 때만 한 번 더 보정한다.
    if (nextStatusMessage.level !== "info" || dom.zoomInput.value === previousZoomValue) {
      return;
    }

    session.render();
    restoreViewportLeftEdgeTick(dom, session, secondPassLeftEdgeTick);
    session.setState({
      ...session.getState(),
      statusMessage: nextStatusMessage,
    });
    syncLeftStatus(dom, session.getState());
  });
}

/**
 * 현재 viewport 왼쪽 edge가 가리키는 tick 값을 읽는다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 왼쪽 edge tick, layout이 없으면 null
 */
function getViewportLeftEdgeTick(dom: AppDom, state: AppState): number | null {
  if (state.layout === null) {
    return null;
  }

  return xToColumn(dom.scoreArea.scrollLeft, state.layout);
}

/**
 * 저장해 둔 tick이 viewport 왼쪽 edge에 오도록 scrollLeft를 복원하고 동적 layer를 다시 그린다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 인수 : leftEdgeTick : 복원할 왼쪽 edge tick
 * - 반환값 : 없음
 */
function restoreViewportLeftEdgeTick(
  dom: AppDom,
  session: ViewBindingSession,
  leftEdgeTick: number | null,
): void {
  const nextLayout = session.getState().layout;

  if (leftEdgeTick === null || nextLayout === null) {
    return;
  }

  const nextScrollLeft = columnToX(leftEdgeTick, nextLayout);
  const maxScrollLeft = Math.max(0, nextLayout.stageWidth);
  dom.scoreArea.scrollLeft = Math.min(Math.max(0, nextScrollLeft), maxScrollLeft);
  syncLayoutScroll(dom.scoreArea, dom.layoutStage);
  session.setState(renderDynamicViewportLayers(dom, session.getState()));
}

/**
 * details dialog를 현재 score metadata로 채운 뒤 연다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회 callback 묶음
 * - 반환값 : 없음
 */
export function openDetailsDialog(
  dom: AppDom,
  session: Pick<ViewBindingSession, "getState">,
): void {
  populateDetailsDialog(dom, session.getState().document.score.musicData);
  dom.detailsDialog.showModal();
}

/**
 * details dialog 입력값을 score metadata에 적용한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
export function applyDetailsDialog(
  dom: AppDom,
  session: ViewBindingSession,
): void {
  const state = session.getState();
  const currentMusicData = state.document.score.musicData;

  session.setState(
    applyMusicDataEditToState(
      state,
      readDetailsDialogMusicData(dom, currentMusicData),
    ),
  );
  dom.detailsDialog.close();
  session.render();
}

/**
 * zoom 변경 전 viewport 왼쪽 edge에 있던 tick이 변경 후에도 왼쪽 edge에 오도록 보정한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 인수 : nextZoomPercent : 적용할 다음 zoom percent
 * - 반환값 : 없음
 */
function applyZoomPreservingViewportLeftEdge(
  dom: AppDom,
  session: ViewBindingSession,
  nextZoomPercent: number,
): void {
  const leftEdgeTick = getViewportLeftEdgeTick(dom, session.getState());

  setZoomPercent(dom, nextZoomPercent);
  session.render();
  restoreViewportLeftEdgeTick(dom, session, leftEdgeTick);
}

/**
 * speed 배율 변경 전 viewport 왼쪽 edge tick을 변경 후에도 유지한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
function applySpeedPreservingViewportLeftEdge(
  dom: AppDom,
  session: ViewBindingSession,
): void {
  const leftEdgeTick = getViewportLeftEdgeTick(dom, session.getState());
  const speedPercent = Number(dom.speedInput.value);
  const speedScale = Number.isFinite(speedPercent)
    ? Math.min(Math.max(speedPercent / 100, 1), 4)
    : 1;

  session.setState({
    ...session.getState(),
    speedScale,
    statusMessage: {
      level: "info",
      text: `Speed: ${speedScale.toFixed(2)}x`,
    },
  });
  session.render();
  restoreViewportLeftEdgeTick(dom, session, leftEdgeTick);
}

/**
 * Text off 설정을 note/mute text layer에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
function applyTextOff(
  dom: AppDom,
  session: ViewBindingSession,
): void {
  session.setState({
    ...session.getState(),
    textOff: dom.textOffInput.checked,
    statusMessage: {
      level: "info",
      text: dom.textOffInput.checked ? "Text off enabled." : "Text off disabled.",
    },
  });
  session.setState(renderDynamicViewportLayers(dom, session.getState()));
  syncLeftStatus(dom, session.getState());
}

/**
 * Loop on/off toggle을 AppState와 marker layer에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
function toggleLoop(
  dom: AppDom,
  session: ViewBindingSession,
): void {
  const state = session.getState();

  if (state.mode.kind === "edit") {
    return;
  }

  const enabled = !state.loop.enabled;

  session.setState({
    ...state,
    loop: {
      ...state.loop,
      enabled,
      pickMode: enabled ? state.loop.pickMode : null,
    },
    statusMessage: {
      level: "info",
      text: enabled ? "Loop enabled." : "Loop disabled.",
    },
  });
  session.setState(renderDynamicViewportLayers(dom, session.getState()));
  syncLeftStatus(dom, session.getState());
  syncUiControls(dom, session.getState());
}

/**
 * loop start select 변경을 runtime loop state에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
function applyLoopStartSelect(
  dom: AppDom,
  session: ViewBindingSession,
): void {
  const state = session.getState();
  const pickMode = dom.loopStartSelect.value === "pick" ? "start" : null;

  session.setState({
    ...state,
    loop: {
      ...state.loop,
      startTick: pickMode === null ? null : state.loop.startTick,
      pickMode,
    },
    statusMessage: {
      level: "info",
      text: pickMode === "start" ? "Click a score column for loop start." : "Loop start: First",
    },
  });
  session.setState(renderDynamicViewportLayers(dom, session.getState()));
  syncLeftStatus(dom, session.getState());
  syncUiControls(dom, session.getState());
}

/**
 * loop end select 변경을 runtime loop state에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
function applyLoopEndSelect(
  dom: AppDom,
  session: ViewBindingSession,
): void {
  const state = session.getState();
  const pickMode = dom.loopEndSelect.value === "pick" ? "end" : null;

  session.setState({
    ...state,
    loop: {
      ...state.loop,
      endTick: pickMode === null ? null : state.loop.endTick,
      pickMode,
    },
    statusMessage: {
      level: "info",
      text: pickMode === "end" ? "Click a score column for loop end." : "Loop end: Last",
    },
  });
  session.setState(renderDynamicViewportLayers(dom, session.getState()));
  syncLeftStatus(dom, session.getState());
  syncUiControls(dom, session.getState());
}

/**
 * view 관련 DOM event를 app 상태 변경 흐름에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
export function bindViewControls(
  dom: AppDom,
  session: ViewControlsBindingSession,
): void {
  syncLayoutToolbarPresetSelectForCurrentScore(dom, session);
  bindLayoutDialogControls(dom, session);
  let dynamicViewportScrollRafId: number | null = null;

  // score 영역이 스크롤될 때 layout label stage의 세로 위치를 함께 이동한다.
  dom.scoreArea.addEventListener("scroll", () => {
    syncLayoutScroll(dom.scoreArea, dom.layoutStage);

    if (dynamicViewportScrollRafId !== null) {
      return;
    }

    dynamicViewportScrollRafId = requestAnimationFrame(() => {
      dynamicViewportScrollRafId = null;
      session.setState(renderDynamicViewportLayers(dom, session.getState()));
    });
  });

  window.addEventListener("resize", session.render);

  document.addEventListener("fullscreenchange", () => {
    syncFullscreenButton(dom);
    requestAnimationFrame(() => {
      fitScoreHeight(dom, session);
    });
  });

  // zoom 값이 확정되면 현재 입력값으로 전체 canvas score를 다시 그린다.
  dom.zoomInput.addEventListener("change", () => {
    applyZoomPreservingViewportLeftEdge(dom, session, Number(dom.zoomInput.value));
  });

  dom.speedInput.addEventListener("change", () => {
    applySpeedPreservingViewportLeftEdge(dom, session);
  });

  dom.textOffInput.addEventListener("change", () => {
    applyTextOff(dom, session);
  });

  dom.loopToggleButton.addEventListener("click", () => {
    toggleLoop(dom, session);
  });

  dom.loopStartSelect.addEventListener("change", () => {
    applyLoopStartSelect(dom, session);
  });

  dom.loopEndSelect.addEventListener("change", () => {
    applyLoopEndSelect(dom, session);
  });

  dom.fitHeightButton.addEventListener("click", () => {
    fitScoreHeight(dom, session);
  });

  dom.fullscreenButton.addEventListener("click", () => {
    toggleFullscreen(dom, (message) => {
      const state = session.getState();

      session.setState({
        ...state,
        statusMessage: {
          level: "error",
          text: message,
        },
      });
      syncLeftStatus(dom, session.getState());
    });
  });

  dom.reverseButton.addEventListener("click", () => {
    const state = session.getState();

    session.setState(applyReverseRowsToState(state, !state.reverseRows));
    session.render();
  });

  dom.themeButton.addEventListener("click", () => {
    const state = session.getState();
    const nextTheme = state.menuTheme === "light" ? "dark" : "light";

    session.setState(applyMenuThemeToState(state, nextTheme));
    session.render();
  });

  dom.expandRightButton.addEventListener("click", () => {
    const state = session.getState();

    if (state.busy.kind !== "idle") {
      return;
    }

    session.setState(applyExpandColumnsToState(
      state,
      readIntegerInput(dom.expandColumnInput, 0),
    ));
    session.render();
    session.resetPlaybackForCurrentStatePreservingPosition();
  });

  dom.trimRightButton.addEventListener("click", () => {
    const state = session.getState();
    const trimColumns = readIntegerInput(dom.expandColumnInput, 0);

    if (state.busy.kind !== "idle") {
      return;
    }

    if (
      !Number.isInteger(trimColumns) ||
      trimColumns <= 0 ||
      state.document.score.globalLines.columnCount - trimColumns < 1
    ) {
      session.setState(applyTrimRightColumnsToState(state, trimColumns));
      session.render();
      return;
    }

    if (!window.confirm(`Trim ${trimColumns} column(s) from the right?`)) {
      return;
    }

    session.setState(applyTrimRightColumnsToState(state, trimColumns));
    session.render();
    session.resetPlaybackForCurrentState();
  });

  dom.clearAllButton.addEventListener("click", () => {
    const state = session.getState();

    if (state.busy.kind !== "idle") {
      return;
    }

    if (!window.confirm("Clear all score cells and reset to 1000 columns?")) {
      return;
    }

    session.setState(applyClearAllScoreToState(state));
    session.render();
    session.resetPlaybackForCurrentState();
    session.youtubeControl?.syncInputsFromScore();
  });

  dom.detailsButton.addEventListener("click", () => {
    openDetailsDialog(dom, session);
  });
  dom.detailsCloseButton.addEventListener("click", () => {
    dom.detailsDialog.close();
  });
  dom.detailsCancelButton.addEventListener("click", () => {
    dom.detailsDialog.close();
  });
  dom.detailsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    applyDetailsDialog(dom, session);
  });
}
