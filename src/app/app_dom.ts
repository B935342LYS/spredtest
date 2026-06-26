/**
 * app 진입점에서 사용하는 DOM 조회와 canvas target 생성을 담당한다.
 */

import type { AppDom } from "./app_types";
import type {
  CanvasLayerTarget,
  CanvasRenderTarget,
} from "../renderer/canvas_types";

/**
 * selector에 해당하는 HTML 요소를 찾고 타입을 확인한다.
 * - 인수 : selector : 조회할 CSS selector
 * - 인수 : ctor : 기대하는 HTMLElement 생성자
 * - 반환값 : 타입이 확인된 HTML 요소
 */
export function queryElement<T extends HTMLElement>(
  selector: string,
  ctor: { new (): T },
): T {
  const element = document.querySelector(selector);

  if (!(element instanceof ctor)) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

/**
 * canvas element에서 2D rendering target을 만든다.
 * - 인수 : selector : canvas selector
 * - 반환값 : canvas와 2D context 묶음
 */
export function createCanvasLayerTarget(selector: string): CanvasLayerTarget {
  const canvas = queryElement(selector, HTMLCanvasElement);
  const context = canvas.getContext("2d");

  if (context === null) {
    throw new Error(`2D context is unavailable: ${selector}`);
  }

  return {
    canvas,
    context,
  };
}

/**
 * DOM에 배치된 canvas layer를 renderer target으로 묶는다.
 * - 인수 : 없음
 * - 반환값 : renderer가 사용할 canvas target 묶음
 */
export function createCanvasRenderTarget(): CanvasRenderTarget {
  return {
    layout: createCanvasLayerTarget(".label-layer"),
    base: createCanvasLayerTarget(".base-layer"),
    note: createCanvasLayerTarget(".note-layer"),
    marker: createCanvasLayerTarget(".marker-layer"),
    noteMarker: createCanvasLayerTarget(".note-marker-layer"),
  };
}

/**
 * 앱 부팅에 필요한 DOM 요소를 한 번에 조회한다.
 * - 인수 : 없음
 * - 반환값 : 앱 이벤트 배선과 renderer가 사용할 DOM 요소 묶음
 */
export function collectAppDom(): AppDom {
  const tupletSlotInputs = Array.from(
    document.querySelectorAll(".tuplet-slot-input"),
  ).filter((element): element is HTMLInputElement => element instanceof HTMLInputElement);
  const numberRampButtons = Array.from(
    document.querySelectorAll(".number-ramp-button"),
  ).filter((element): element is HTMLButtonElement => element instanceof HTMLButtonElement);
  const trackToggleButtons = Array.from(
    document.querySelectorAll(".track-toggle"),
  ).filter((element): element is HTMLButtonElement => element instanceof HTMLButtonElement);

  return {
    appShell: queryElement(".app-shell", HTMLElement),
    scoreViewer: queryElement(".score-viewer", HTMLElement),
    scoreArea: queryElement(".score-area", HTMLElement),
    scoreStage: queryElement(".score-canvas-stage", HTMLElement),
    selectionOverlay: queryElement(".selection-overlay", HTMLElement),
    pastePreviewOverlay: queryElement(".paste-preview-overlay", HTMLElement),
    layoutStage: queryElement(".layout-canvas-stage", HTMLElement),
    target: createCanvasRenderTarget(),
    editToggle: queryElement("#edit-mode-toggle", HTMLInputElement),
    trackToggleButtons,
    defaultModeSelect: queryElement(".default-mode-select", HTMLSelectElement),
    customTextInput: queryElement(".custom-text-input", HTMLInputElement),
    holdTokenSelect: queryElement(".hold-token-select", HTMLSelectElement),
    glissKindSelect: queryElement(".gliss-kind-select", HTMLSelectElement),
    glissIdSelect: queryElement(".gliss-id-select", HTMLSelectElement),
    tremDivisionSelect: queryElement(".trem-division-select", HTMLSelectElement),
    absolutePitchSelect: queryElement(".absolute-pitch-select", HTMLSelectElement),
    microPitchInput: queryElement(".micro-pitch-input", HTMLInputElement),
    tupletModeToggle: queryElement(".tuplet-mode-toggle", HTMLButtonElement),
    tupletDivisionSelect: queryElement(".tuplet-division-select", HTMLSelectElement),
    tupletInsertModeSelect: queryElement(".tuplet-insert-mode-select", HTMLSelectElement),
    tupletFinalizeButton: queryElement(".tuplet-finalize-button", HTMLButtonElement),
    tupletSlotInputs,
    numberRawInput: queryElement(".number-raw-input", HTMLInputElement),
    numberRampButtons,
    currentRawTextPreview: queryElement(".current-raw-text-preview", HTMLElement),
    undoButton: queryElement(".undo-button", HTMLButtonElement),
    redoButton: queryElement(".redo-button", HTMLButtonElement),
    jsonLoadButton: queryElement(".json-load-button", HTMLButtonElement),
    jsonDownloadButton: queryElement(".json-download-button", HTMLButtonElement),
    jsonLoadInput: queryElement(".json-load-input", HTMLInputElement),
    localSaveButton: queryElement(".local-save-button", HTMLButtonElement),
    localLoadButton: queryElement(".local-load-button", HTMLButtonElement),
    zoomInput: queryElement(".zoom-input", HTMLInputElement),
    speedInput: queryElement(".speed-input", HTMLInputElement),
    textOffInput: queryElement(".text-off-input", HTMLInputElement),
    loopToggleButton: queryElement(".loop-toggle", HTMLButtonElement),
    loopStartSelect: queryElement(".loop-start-select", HTMLSelectElement),
    loopEndSelect: queryElement(".loop-end-select", HTMLSelectElement),
    loopStartValue: queryElement(".loop-start-value", HTMLElement),
    loopEndValue: queryElement(".loop-end-value", HTMLElement),
    fullscreenButton: queryElement(".fullscreen-button", HTMLButtonElement),
    fitHeightButton: queryElement(".fit-height-button", HTMLButtonElement),
    reverseButton: queryElement(".reverse-button", HTMLButtonElement),
    themeButton: queryElement(".theme-button", HTMLButtonElement),
    expandColumnInput: queryElement(".expand-column-input", HTMLInputElement),
    expandRightButton: queryElement(".expand-right-button", HTMLButtonElement),
    trimRightButton: queryElement(".trim-right-button", HTMLButtonElement),
    clearAllButton: queryElement(".clear-all-button", HTMLButtonElement),
    layoutPresetToolbarSelect: queryElement(".layout-preset-toolbar-select", HTMLSelectElement),
    layoutModifyButton: queryElement(".layout-modify-button", HTMLButtonElement),
    detailsButton: queryElement(".details-button", HTMLButtonElement),
    detailsDialog: queryElement("#score-details", HTMLDialogElement),
    detailsForm: queryElement(".details-form", HTMLFormElement),
    detailsCloseButton: queryElement(".details-close-button", HTMLButtonElement),
    detailsCancelButton: queryElement(".details-cancel-button", HTMLButtonElement),
    detailsTitleInput: queryElement(".details-title-input", HTMLInputElement),
    detailsArtistInput: queryElement(".details-artist-input", HTMLInputElement),
    detailsGenreInput: queryElement(".details-genre-input", HTMLInputElement),
    detailsWriterInput: queryElement(".details-writer-input", HTMLInputElement),
    detailsCommentInput: queryElement(".details-comment-input", HTMLTextAreaElement),
    detailsBasicDifficultyInput: queryElement(".details-basic-difficulty-input", HTMLInputElement),
    detailsOptionalDifficultyInput: queryElement(".details-optional-difficulty-input", HTMLInputElement),
    detailsExtraDifficultyInput: queryElement(".details-extra-difficulty-input", HTMLInputElement),
    youtubeToggle: queryElement(".youtube-toggle", HTMLInputElement),
    youtubeVideoInput: queryElement(".youtube-video-input", HTMLInputElement),
    youtubeOffsetInput: queryElement(".youtube-offset-input", HTMLInputElement),
    youtubeReloadButton: queryElement(".youtube-reload-button", HTMLButtonElement),
    youtubeStatus: queryElement(".youtube-status", HTMLElement),
    youtubePlayerShell: queryElement(".youtube-player-shell", HTMLElement),
    youtubePlayer: queryElement(".youtube-player", HTMLElement),
    layoutDialog: queryElement("#layout-editor", HTMLDialogElement),
    layoutForm: queryElement(".layout-form", HTMLFormElement),
    layoutCloseButton: queryElement(".layout-close-button", HTMLButtonElement),
    layoutCancelButton: queryElement(".layout-cancel-button", HTMLButtonElement),
    layoutResetButton: queryElement(".layout-reset-button", HTMLButtonElement),
    layoutApplyButton: queryElement(".layout-apply-button", HTMLButtonElement),
    layoutPresetSelect: queryElement(".layout-preset-select", HTMLSelectElement),
    layoutNewPresetButton: queryElement(".layout-new-preset-button", HTMLButtonElement),
    layoutPresetNameInput: queryElement(".layout-preset-name-input", HTMLInputElement),
    layoutLocalSaveButton: queryElement(".layout-local-save-button", HTMLButtonElement),
    layoutLocalLoadButton: queryElement(".layout-local-load-button", HTMLButtonElement),
    layoutFileSaveButton: queryElement(".layout-file-save-button", HTMLButtonElement),
    layoutFileLoadButton: queryElement(".layout-file-load-button", HTMLButtonElement),
    layoutFileLoadInput: queryElement(".layout-file-load-input", HTMLInputElement),
    layoutFamilyInput: queryElement(".layout-family-input", HTMLSelectElement),
    layoutSupportsOpenInput: queryElement(".layout-supports-open-input", HTMLInputElement),
    layoutStringList: queryElement(".layout-string-list", HTMLElement),
    layoutStringSelect: queryElement(".layout-string-select", HTMLSelectElement),
    layoutNoteHeightInput: queryElement(".layout-note-height-input", HTMLInputElement),
    layoutRowList: queryElement(".layout-row-list", HTMLElement),
    layoutPreview: queryElement(".layout-preview", HTMLElement),
    layoutRowTypeSelect: queryElement(".layout-row-type-select", HTMLSelectElement),
    layoutRowHeightInput: queryElement(".layout-row-height-input", HTMLInputElement),
    layoutAddRowBelowButton: queryElement(".layout-add-row-below-button", HTMLButtonElement),
    layoutAddRowAboveButton: queryElement(".layout-add-row-above-button", HTMLButtonElement),
    layoutStatusLine: queryElement(".layout-status-line", HTMLElement),
    playButton: queryElement(".transport-button[aria-label='Play or pause']", HTMLButtonElement),
    stopButton: queryElement(".transport-button[aria-label='Stop']", HTMLButtonElement),
    seekInput: queryElement(".seek-input", HTMLInputElement),
    seekCurrentLabel: queryElement(".seek-current-label", HTMLElement),
    seekDurationLabel: queryElement(".seek-duration-label", HTMLElement),
    playbackStatus: queryElement(".playback-status", HTMLElement),
    tempoStatus: queryElement(".step-info", HTMLElement),
    musicArtist: queryElement(".music-meta .artist", HTMLElement),
    musicTitle: queryElement(".music-meta .title", HTMLElement),
    volumeInput: queryElement(".audio-row input[type='range']", HTMLInputElement),
    waveSelect: queryElement(".audio-row select", HTMLSelectElement),
    leftStatusLine: queryElement(".left-status-line", HTMLElement),
  };
}
