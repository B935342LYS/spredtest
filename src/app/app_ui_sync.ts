/**
 * AppState를 DOM과 canvas renderer에 반영하는 동기화 함수를 제공한다.
 */

import {
  renderCanvasScore,
  renderCanvasScorePartial,
} from "../renderer/canvas_score_renderer";
import { CANVAS_METRICS } from "../renderer/canvas_theme";
import type {
  CanvasDirtyTickRange,
  CanvasMarkerItem,
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
import { resolveAutoPitchInputs } from "./pitch_label";
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
        input: resolveAutoPitchInputs(
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
 * range selection overlay DOM을 현재 renderer layout에 맞춰 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncRangeSelectionOverlay(dom: AppDom, state: AppState): void {
  dom.selectionOverlay.replaceChildren();

  if (state.rangeSelection === null || state.layout === null) {
    return;
  }

  const rowById = new Map(state.layout.rows.map((row) => [row.rowId, row]));
  const left = state.rangeSelection.startCol * state.layout.columnWidth;
  const width = Math.max(
    1,
    (state.rangeSelection.endColExclusive - state.rangeSelection.startCol) *
      state.layout.columnWidth,
  );
  const selectionRows = state.rangeSelection.rowIds
    .map((rowId) => rowById.get(rowId))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);

  if (selectionRows.length === 0) {
    return;
  }

  const top = Math.min(...selectionRows.map((row) => row.y));
  const bottom = Math.max(...selectionRows.map((row) => row.y + row.height));
  const rect = document.createElement("div");

  // 실제 bulk 대상은 note/global row만 유지하되, 시각 표시는 gap을 포함한 하나의 박스로 그린다.
  rect.className = "selection-rect";
  rect.style.left = `${left}px`;
  rect.style.top = `${top}px`;
  rect.style.width = `${width}px`;
  rect.style.height = `${Math.max(1, bottom - top)}px`;
  dom.selectionOverlay.replaceChildren(rect);
}

/**
 * range clipboard 붙여넣기 preview overlay DOM을 현재 hover column에 맞춰 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncPastePreviewOverlay(dom: AppDom, state: AppState): void {
  dom.pastePreviewOverlay.replaceChildren();

  if (
    state.mode.kind !== "edit" ||
    state.layout === null ||
    state.rangeClipboard === null ||
    state.pastePreview.anchorCol === null
  ) {
    return;
  }

  const rowById = new Map(state.layout.rows.map((row) => [row.rowId, row]));
  const fragment = document.createDocumentFragment();

  for (const cell of state.rangeClipboard.cells) {
    const rowId = state.rangeClipboard.sourceRowIds[cell.rowOffset];
    const row = rowId === undefined ? undefined : rowById.get(rowId);
    const col = state.pastePreview.anchorCol + cell.colOffset;

    if (
      row === undefined ||
      row.kind !== state.rangeClipboard.rowKind ||
      col < 0 ||
      col >= state.layout.columnCount
    ) {
      continue;
    }

    const rect = document.createElement("div");
    const previewHeight = Math.max(
      CANVAS_METRICS.minNoteHeight,
      CANVAS_METRICS.baseNoteRenderHeight * getLayoutZoom(state.layout),
    );
    const previewTop = row.y + row.height / 2 - previewHeight / 2;

    // clipboard의 원본 rowId와 hover column을 조합해 실제 붙여넣기 위치만 가볍게 표시한다.
    rect.className = "paste-preview-rect";
    rect.style.left = `${col * state.layout.columnWidth}px`;
    rect.style.top = `${previewTop}px`;
    rect.style.width = `${Math.max(1, state.layout.columnWidth)}px`;
    rect.style.height = `${Math.max(1, previewHeight)}px`;
    fragment.append(rect);
  }

  dom.pastePreviewOverlay.replaceChildren(fragment);
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
  dom.speedInput.disabled = isBusy;
  dom.textOffInput.disabled = isBusy;
  dom.loopToggleButton.disabled = isBusy || isEditMode;
  dom.loopStartSelect.disabled = isBusy || isEditMode || !state.loop.enabled;
  dom.loopEndSelect.disabled = isBusy || isEditMode || !state.loop.enabled;
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
  dom.undoButton.disabled = isBusy || state.history.undoStack.length === 0;
  dom.undoButton.title = state.history.undoStack.at(-1)?.label ?? "Undo";
  dom.redoButton.disabled = isBusy || state.history.redoStack.length === 0;
  dom.redoButton.title = state.history.redoStack.at(-1)?.label ?? "Redo";
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
  syncRangeSelectionOverlay(dom, state);
  syncPastePreviewOverlay(dom, state);
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
  dom.speedInput.value = String(Math.round(state.speedScale * 100));
  dom.textOffInput.checked = state.textOff;
  dom.loopToggleButton.textContent = state.loop.enabled ? "On" : "Off";
  dom.loopToggleButton.setAttribute("aria-pressed", String(state.loop.enabled));
  dom.loopToggleButton.classList.toggle("on", state.loop.enabled);
  dom.loopToggleButton.classList.toggle("off", !state.loop.enabled);
  syncLoopSelectOptions(dom.loopStartSelect, {
    defaultValue: "first",
    defaultLabel: "First",
    pickSelected: state.loop.pickMode === "start",
    pickedValue: state.loop.startTick,
    formatPickedLabel: (tick) => `Col ${tick}`,
  });
  syncLoopSelectOptions(dom.loopEndSelect, {
    defaultValue: "last",
    defaultLabel: "Last",
    pickSelected: state.loop.pickMode === "end",
    pickedValue: state.loop.endTick,
    formatPickedLabel: (tick) => `Col ${Math.max(0, tick - 1)}`,
  });
  dom.loopStartValue.textContent = formatLoopStartValue(state);
  dom.loopEndValue.textContent = formatLoopEndValue(state);
  dom.appShell.dataset.menuTheme = state.menuTheme;
}

/**
 * loop start/end select에 기본값, 선택된 column 값, Select Column 항목을 동기화한다.
 * - 인수 : select : 갱신할 select DOM
 * - 인수 : options : 기본 항목과 현재 loop 선택값
 * - 반환값 : 없음
 */
function syncLoopSelectOptions(
  select: HTMLSelectElement,
  options: {
    defaultValue: string;
    defaultLabel: string;
    pickSelected: boolean;
    pickedValue: number | null;
    formatPickedLabel(tick: number): string;
  },
): void {
  const selectedValue = options.pickSelected
    ? "pick"
    : options.pickedValue === null
      ? options.defaultValue
      : `col:${options.pickedValue}`;
  const items = [
    {
      value: options.defaultValue,
      label: options.defaultLabel,
    },
  ];

  if (options.pickedValue !== null) {
    items.push({
      value: `col:${options.pickedValue}`,
      label: options.formatPickedLabel(options.pickedValue),
    });
  }

  items.push({
    value: "pick",
    label: "Select Column",
  });

  // 현재 선택된 column만 option으로 유지해 긴 악보에서 수천 개 option 생성을 피한다.
  select.replaceChildren(...items.map((item) => {
    const option = document.createElement("option");

    option.value = item.value;
    option.textContent = item.label;
    return option;
  }));
  select.value = selectedValue;
}

/**
 * loop start 표시 label을 만든다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : loop start 표시 문자열
 */
function formatLoopStartValue(state: AppState): string {
  if (state.loop.pickMode === "start" && state.loop.startTick === null) {
    return "Pick...";
  }

  return state.loop.startTick === null ? "First" : `Col ${state.loop.startTick}`;
}

/**
 * loop end 표시 label을 만든다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : loop end 표시 문자열
 */
function formatLoopEndValue(state: AppState): string {
  if (state.loop.pickMode === "end" && state.loop.endTick === null) {
    return "Pick...";
  }

  return state.loop.endTick === null ? "Last" : `Col ${Math.max(0, state.loop.endTick - 1)}`;
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
  state: AppState,
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
  const loopMarkers = createLoopMarkerItems(state);

  return {
    zoom,
    speedScale: state.speedScale,
    hideNoteText: state.textOff,
    loopMarkers,
    devicePixelRatio: window.devicePixelRatio || 1,
    dynamicViewport,
  };
}

/**
 * AppState의 runtime loop range를 renderer marker item으로 변환한다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : marker layer에 추가할 loop boundary item 목록
 */
function createLoopMarkerItems(state: AppState): CanvasMarkerItem[] {
  const columnCount = state.renderInput.columnCount;

  if (!state.loop.enabled || columnCount <= 0) {
    return [];
  }

  const rawStartTick = state.loop.startTick ?? 0;
  const rawEndTick = state.loop.endTick ?? columnCount;
  const startTick = Math.min(rawStartTick, rawEndTick);
  const endTick = Math.max(rawStartTick, rawEndTick);

  if (endTick <= startTick) {
    return [];
  }

  return [
    {
      kind: "loopBoundary",
      tick: Math.max(0, Math.min(columnCount, startTick)),
      role: "start",
    },
    {
      kind: "loopBoundary",
      tick: Math.max(0, Math.min(columnCount, endTick)),
      role: "end",
    },
  ];
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
    createRenderOptions(dom.zoomInput, state, dom.scoreArea),
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

  const nextState = {
    ...state,
    layout: result.layout,
  };

  syncRangeSelectionOverlay(dom, nextState);
  syncPastePreviewOverlay(dom, nextState);
  return nextState;
}

/**
 * renderer layout에서 현재 zoom 배율을 추정한다.
 * - 인수 : layout : renderer가 계산한 현재 score layout
 * - 반환값 : base note height에 곱할 zoom 배율
 */
function getLayoutZoom(layout: AppState["layout"]): number {
  if (layout === null || layout.layoutLabelWidth <= 0) {
    return 1;
  }

  return layout.layoutLabelWidth / CANVAS_METRICS.baseLayoutLabelWidth;
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
    createRenderOptions(dom.zoomInput, state, dom.scoreArea),
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

  const nextState = {
    ...state,
    layout: result.layout,
  };

  syncRangeSelectionOverlay(dom, nextState);
  syncPastePreviewOverlay(dom, nextState);
  return nextState;
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
    createRenderOptions(dom.zoomInput, state, dom.scoreArea),
    "note",
    state.layout,
    null,
  );

  const nextState = {
    ...state,
    layout: result.layout,
  };

  syncRangeSelectionOverlay(dom, nextState);
  syncPastePreviewOverlay(dom, nextState);
  return nextState;
}
