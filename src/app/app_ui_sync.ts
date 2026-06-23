/**
 * AppState를 DOM과 canvas renderer에 반영하는 동기화 함수를 제공한다.
 */

import {
  renderCanvasScore,
  renderCanvasScorePartial,
} from "../renderer/canvas_score_renderer";
import type {
  CanvasDirtyTickRange,
  CanvasRedrawScope,
  CanvasRenderOptions,
  CanvasRenderResult,
} from "../renderer/canvas_types";
import type {
  AppDom,
  AppState,
  UiStatusMessage,
} from "./app_types";
import { composeEditRawText } from "./edit/edit_core";
import { resolveAutoDefaultText } from "./pitch_label";
import { isTrackId } from "../track/track_control";

/**
 * status footer의 특정 위치 문구를 바꾼다.
 * - 인수 : index : 바꿀 status span 순서
 * - 인수 : text : 표시할 문구
 * - 반환값 : 없음
 */
export function setStatus(index: number, text: string): void {
  const items = document.querySelectorAll(".status-area span");
  const item = items.item(index);

  if (item !== null) {
    item.textContent = text;
  }
}

/**
 * busy 상태를 우선하여 왼쪽 상태줄에 표시할 메시지를 고른다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : DOM에 표시할 상태 메시지
 */
export function getVisibleStatusMessage(state: AppState): UiStatusMessage {
  if (state.busy.kind !== "idle") {
    return {
      level: "info",
      text: state.busy.message,
    };
  }

  return state.statusMessage;
}

/**
 * AppState를 왼쪽 user-facing status line에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncLeftStatus(dom: AppDom, state: AppState): void {
  const message = getVisibleStatusMessage(state);

  // 긴 오류/상태 문구는 한 줄로 줄이고 전체 내용은 title에서 확인할 수 있게 둔다.
  dom.leftStatusLine.textContent = message.text;
  dom.leftStatusLine.dataset.level = message.level;
  dom.leftStatusLine.title = message.text;
}

/**
 * metadata 표시용 문자열을 정리한다.
 * - 인수 : value : ScoreFile musicData에서 읽은 원본 문자열
 * - 반환값 : 공문자열이면 unknown, 아니면 trim된 표시 문자열
 */
function formatMusicMetadataText(value: string): string {
  const text = value.trim();

  return text.length > 0 ? text : "unknown";
}

/**
 * 중앙 player group의 곡 metadata 표시를 현재 ScoreFile과 동기화한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncMusicMetadata(dom: AppDom, state: AppState): void {
  const musicData = state.document.score.musicData;
  const artist = formatMusicMetadataText(musicData.musicArtist);
  const title = formatMusicMetadataText(musicData.musicTitle);

  // 중앙 플레이어는 ScoreFile 원본 metadata를 직접 표시하고 전체 문구는 tooltip에도 둔다.
  dom.musicArtist.textContent = artist;
  dom.musicArtist.title = artist;
  dom.musicTitle.textContent = title;
  dom.musicTitle.title = title;
}

/**
 * Default 카드 상단의 current rawText preview를 현재 edit tool 상태로 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncCurrentRawTextPreview(dom: AppDom, state: AppState): void {
  if (state.mode.kind !== "edit") {
    dom.currentRawTextPreview.textContent = "current: empty";
    dom.currentRawTextPreview.title = "";
    return;
  }

  if (state.mode.tool.kind === "pletExtend") {
    dom.currentRawTextPreview.textContent = "current: /&";
    dom.currentRawTextPreview.title = "/&";
    return;
  }

  const result = state.mode.tool.kind === "tuplet"
    ? composeEditRawText({
        kind: "tuplet",
        draft: state.mode.tool.draft,
      })
    : composeEditRawText({
        kind: "default",
        input: resolveAutoDefaultText(
          state,
          state.mode.tool.input,
          state.selection?.rowId ?? null,
        ),
      });

  if (result.kind === "blocked") {
    dom.currentRawTextPreview.textContent = "current: blocked";
    dom.currentRawTextPreview.title = result.message;
    return;
  }

  if (result.kind === "delete") {
    dom.currentRawTextPreview.textContent = "current: delete";
    dom.currentRawTextPreview.title = "delete current cell";
    return;
  }

  dom.currentRawTextPreview.textContent = `current: ${result.rawText}`;
  dom.currentRawTextPreview.title = result.rawText;
}

/**
 * edit/busy 상태에 따라 최소 구현 대상 UI control을 활성화한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncUiControls(dom: AppDom, state: AppState): void {
  const isBusy = state.busy.kind !== "idle";
  const isEditMode = state.mode.kind === "edit";
  const isPletExtendTool = state.mode.kind === "edit" && state.mode.tool.kind === "pletExtend";
  const isTupletTool = state.mode.kind === "edit" && state.mode.tool.kind === "tuplet";
  const isTupletMode = isPletExtendTool || isTupletTool;
  const isTupletExtendMode = dom.tupletInsertModeSelect.value === "extend";
  const isNoteComposerMode = dom.defaultModeSelect.value !== "comment" &&
    dom.defaultModeSelect.value !== "eraser";
  const activeTupletSlots = Number.parseInt(dom.tupletDivisionSelect.value, 10);
  const activeTupletSlotIndex = state.mode.kind === "edit" && state.mode.tool.kind === "tuplet"
    ? state.mode.tool.draft.activeSlotIndex
    : null;

  // busy 중에는 edit 입력과 score 조작에 영향을 주는 컨트롤을 모두 잠근다.
  dom.editToggle.disabled = isBusy;
  dom.defaultModeSelect.disabled = isBusy || !isEditMode;
  dom.customTextInput.disabled = isBusy || !isEditMode || dom.defaultModeSelect.value === "eraser";
  dom.holdTokenSelect.disabled = isBusy || !isEditMode || !isNoteComposerMode;
  dom.glissKindSelect.disabled = isBusy || !isEditMode || !isNoteComposerMode;
  dom.glissIdSelect.disabled = dom.glissKindSelect.disabled || dom.glissKindSelect.value === "";
  dom.tremDivisionSelect.disabled = isBusy || !isEditMode || !isNoteComposerMode;
  dom.absolutePitchSelect.disabled = isBusy || !isEditMode || dom.defaultModeSelect.value === "comment" || dom.defaultModeSelect.value === "eraser";
  dom.microPitchInput.disabled = isBusy || !isEditMode || dom.defaultModeSelect.value === "comment" || dom.defaultModeSelect.value === "eraser";
  dom.tupletModeToggle.disabled = isBusy || !isEditMode;
  dom.tupletDivisionSelect.disabled = isBusy || !isTupletMode;
  dom.tupletInsertModeSelect.disabled = isBusy || !isTupletMode;
  dom.tupletFinalizeButton.disabled = isBusy || !isTupletMode || isTupletExtendMode;
  dom.tupletSlotInputs.forEach((input, slotIndex) => {
    input.disabled = isBusy || !isTupletMode || isTupletExtendMode || slotIndex >= activeTupletSlots;
    input.classList.toggle(
      "active",
      isTupletTool && slotIndex === activeTupletSlotIndex,
    );
  });
  dom.numberRawInput.disabled = isBusy;
  dom.numberRampButtons.forEach((button) => {
    button.disabled = isBusy;
  });
  dom.zoomInput.disabled = isBusy;
  dom.reverseButton.disabled = isBusy;
  dom.themeButton.disabled = isBusy;
  dom.expandColumnInput.disabled = isBusy;
  dom.expandRightButton.disabled = isBusy;
  dom.trimRightButton.disabled = isBusy;
  dom.clearAllButton.disabled = isBusy;
  dom.tupletModeToggle.textContent = isTupletMode ? "On" : "Off";
  dom.tupletModeToggle.classList.toggle("on", isTupletMode);
  dom.tupletModeToggle.classList.toggle("off", !isTupletMode);
  dom.tupletFinalizeButton.classList.toggle("on", isTupletTool);
  dom.tupletFinalizeButton.classList.toggle("off", !isTupletTool || isPletExtendTool);
  dom.jsonLoadButton.disabled = isBusy;
  dom.jsonDownloadButton.disabled = isBusy;
  dom.localSaveButton.disabled = isBusy;
  dom.localLoadButton.disabled = isBusy;
  dom.fullscreenButton.disabled = isBusy;
  dom.fitHeightButton.disabled = isBusy;
  dom.layoutPresetToolbarSelect.disabled = isBusy;
  dom.layoutModifyButton.disabled = isBusy;
  dom.detailsButton.disabled = isBusy;
  dom.seekInput.disabled = isBusy;
  syncTrackToggleButtons(dom, state);
  syncViewOptionControls(dom, state);
  syncCurrentRawTextPreview(dom, state);
}

/**
 * view option 버튼 문구와 menu theme attribute를 현재 AppState에 맞춘다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncViewOptionControls(dom: AppDom, state: AppState): void {
  dom.reverseButton.textContent = state.reverseRows ? "Reverse" : "Normal";
  dom.reverseButton.setAttribute("aria-pressed", String(state.reverseRows));
  dom.themeButton.textContent = state.menuTheme === "dark" ? "Dark" : "Light";
  dom.themeButton.setAttribute("aria-pressed", String(state.menuTheme === "dark"));
  dom.appShell.dataset.menuTheme = state.menuTheme;
}

/**
 * track toggle 버튼의 on/off와 disabled 상태를 현재 app/playback 상태에 맞춘다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : disabledByPlayback : playback 상태 때문에 track 조작을 막을지 여부
 * - 반환값 : 없음
 */
export function syncTrackToggleButtons(
  dom: AppDom,
  state: AppState,
  disabledByPlayback = false,
): void {
  const activeSet = new Set(state.activeTrackIds);
  const isDisabled = state.busy.kind !== "idle" || disabledByPlayback;

  // 고정 track 버튼을 순회하며 app runtime의 activeTrackIds를 aria/class 상태에 반영한다.
  for (const button of dom.trackToggleButtons) {
    const trackId = button.dataset.trackId;
    const isActive = trackId !== undefined && isTrackId(trackId) && activeSet.has(trackId);

    button.disabled = isDisabled;
    button.classList.toggle("on", isActive);
    button.classList.toggle("off", !isActive);
    button.setAttribute("aria-pressed", String(isActive));
  }
}

/**
 * layout label canvas를 score 영역의 세로 스크롤과 동기화한다.
 * - 인수 : scoreArea : score canvas scroll container
 * - 인수 : layoutStage : layout label canvas stage
 * - 반환값 : 없음
 */
export function syncLayoutScroll(
  scoreArea: HTMLElement,
  layoutStage: HTMLElement,
): void {
  layoutStage.style.transform = `translateY(${-scoreArea.scrollTop}px)`;
}

/**
 * 현재 DOM 상태와 UI 옵션으로 renderer option을 만든다.
 * - 인수 : zoomInput : zoom slider DOM 요소
 * - 반환값 : renderer 좌표 계산 옵션
 */
export function createRenderOptions(
  zoomInput: HTMLInputElement,
  scoreArea?: HTMLElement,
): CanvasRenderOptions {
  const zoom = Number(zoomInput.value) / 100;
  const dynamicViewport = scoreArea !== undefined
    ? {
        scrollLeft: scoreArea.scrollLeft,
        width: scoreArea.clientWidth,
        overscanPx: Math.max(128, scoreArea.clientWidth * 0.25),
      }
    : undefined;

  return {
    zoom,
    devicePixelRatio: window.devicePixelRatio || 1,
    dynamicViewport,
  };
}

/**
 * renderer 결과 크기를 CSS 변수에 반영해 scroll container와 canvas style을 맞춘다.
 * - 인수 : stageWidth : score stage CSS pixel 너비
 * - 인수 : scrollWidth : score area에서 실제로 스크롤 가능한 stage CSS pixel 너비
 * - 인수 : stageHeight : score stage CSS pixel 높이
 * - 인수 : layoutWidth : layout label area CSS pixel 너비
 * - 인수 : viewportHeight : score area가 현재 화면에서 차지하는 CSS pixel 높이
 * - 반환값 : 없음
 */
export function updateStageCssVars(
  stageWidth: number,
  scrollWidth: number,
  stageHeight: number,
  layoutWidth: number,
  viewportHeight: number,
): void {
  document.documentElement.style.setProperty(
    "--score-stage-width",
    `${stageWidth}px`,
  );
  document.documentElement.style.setProperty(
    "--score-scroll-width",
    `${scrollWidth}px`,
  );
  document.documentElement.style.setProperty(
    "--score-stage-height",
    `${stageHeight}px`,
  );
  document.documentElement.style.setProperty(
    "--score-viewport-height",
    `${viewportHeight}px`,
  );
  document.documentElement.style.setProperty(
    "--label-width",
    `${layoutWidth}px`,
  );
}

/**
 * renderer 결과 요약을 status footer에 표시한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : result : renderer 호출 결과
 * - 반환값 : 없음
 */
function syncRendererStatus(state: AppState, result: CanvasRenderResult): void {
  setStatus(1, `analysis: ${state.renderInput.noteItems.length} notes`);
  setStatus(
    2,
    `renderer: ${result.layout.rows.length} rows, ${state.renderInput.columnCount} cols`,
  );
}

/**
 * AppState 안의 renderInput으로 canvas score를 다시 그리고 layout을 상태에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : renderer layout이 반영된 새 상태
 */
export function renderApp(dom: AppDom, state: AppState): AppState {
  // CanvasRenderInput과 현재 UI 옵션으로 canvas score를 다시 그린다.
  const result: CanvasRenderResult = renderCanvasScore(
    dom.target,
    state.renderInput,
    createRenderOptions(dom.zoomInput, dom.scoreArea),
  );

  // renderer가 계산한 stage 크기를 CSS 변수에 반영하고 label scroll 위치를 맞춘다.
  // 오른쪽 tail 폭은 playback 기준선이 마지막 tick까지 따라갈 수 있도록 scroll extent만 확장한다.
  const horizontalTailWidth = Math.max(0, dom.scoreArea.clientWidth);

  updateStageCssVars(
    result.layout.stageWidth,
    result.layout.stageWidth + horizontalTailWidth,
    result.layout.stageHeight,
    result.layout.layoutWidth,
    Math.max(0, dom.scoreArea.clientHeight),
  );
  syncLayoutScroll(dom.scoreArea, dom.layoutStage);
  syncRendererStatus(state, result);

  return {
    ...state,
    layout: result.layout,
  };
}

/**
 * AppState 안의 renderInput으로 편집 영향 layer만 다시 그리고 layout 상태를 유지한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : scope : 다시 그릴 canvas 동적 layer 범위
 * - 인수 : dirtyTickRange : note scope에서 부분 redraw할 tick 범위
 * - 반환값 : renderer layout이 반영된 새 상태
 */
export function renderAppPartial(
  dom: AppDom,
  state: AppState,
  scope: Exclude<CanvasRedrawScope, "all">,
  dirtyTickRange: CanvasDirtyTickRange | null = null,
): AppState {
  if (state.layout === null) {
    return renderApp(dom, state);
  }

  const previousLayout = state.layout;
  const result: CanvasRenderResult = renderCanvasScorePartial(
    dom.target,
    state.renderInput,
    createRenderOptions(dom.zoomInput, dom.scoreArea),
    scope,
    previousLayout,
    dirtyTickRange,
  );
  const horizontalTailWidth = Math.max(0, dom.scoreArea.clientWidth);

  updateStageCssVars(
    result.layout.stageWidth,
    result.layout.stageWidth + horizontalTailWidth,
    result.layout.stageHeight,
    result.layout.layoutWidth,
    Math.max(0, dom.scoreArea.clientHeight),
  );
  syncLayoutScroll(dom.scoreArea, dom.layoutStage);
  syncRendererStatus(state, result);

  return {
    ...state,
    layout: result.layout,
  };
}

/**
 * scroll 위치가 바뀐 뒤 현재 viewport에 맞춰 note/note marker 동적 layer만 다시 그린다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : renderer layout이 유지/갱신된 앱 상태
 */
export function renderDynamicViewportLayers(dom: AppDom, state: AppState): AppState {
  if (state.layout === null) {
    return state;
  }

  const result = renderCanvasScorePartial(
    dom.target,
    state.renderInput,
    createRenderOptions(dom.zoomInput, dom.scoreArea),
    "note",
    state.layout,
    null,
  );

  return {
    ...state,
    layout: result.layout,
  };
}
