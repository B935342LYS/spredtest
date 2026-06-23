/**
 * app 계층에서 공유하는 UI runtime 상태 타입을 정의한다.
 */

import type { AnalysisResult } from "../core/analyze/types";
import type { ParsedScoreDocument } from "../core/parse/types";
import type {
  RuntimeDocument,
  RowId,
  TrackId,
} from "../core/score/types";
import type {
  CanvasAnalyzedRenderInput,
  CanvasRenderTarget,
  CanvasRowKind,
  CanvasScoreLayout,
} from "../renderer/canvas_types";
import type { DefaultNoteEditInput } from "./edit/edit_default";
import type { TupletEditDraft } from "./edit/edit_tuplet";
import type { LayoutDraftBundle } from "./layout/layout_types";

/** 사용자가 볼 수 있는 짧은 상태 메시지의 중요도. */
export type UiStatusLevel = "info" | "warning" | "error";

/** number UI에서 선택하는 전역 행 선형 변화 표식. */
export type NumberEditRamp = "none" | "start" | "end" | "endStart";

/** 왼쪽 메뉴 하단에 표시할 사용자 조작 결과 메시지. */
export type UiStatusMessage = {
  level: UiStatusLevel;
  text: string;
};

/** 앱이 입력을 받아도 되는지 나타내는 전역 busy 상태. */
export type AppBusyState =
  | { kind: "idle" }
  | { kind: "loadingScore"; message: string }
  | { kind: "applyingEdit"; message: string }
  | { kind: "rebuilding"; message: string };

/** edit mode에서 활성화된 도구. */
export type EditTool =
  | {
      kind: "default";
      input: DefaultNoteEditInput;
    }
  | {
      kind: "pletExtend";
    }
  | {
      kind: "tuplet";
      draft: TupletEditDraft;
    };

/** score click을 어떤 의미로 해석할지 결정하는 앱 모드. */
export type AppMode =
  | { kind: "view" }
  | { kind: "edit"; tool: EditTool };

/** score 영역 click을 renderer 좌표에서 score 좌표로 변환한 결과. */
export type ScoreHit = {
  rowId: RowId;
  rowKind: CanvasRowKind;
  col: number;
};

/** UI가 현재 선택한 score 위치. */
export type ScoreSelection = ScoreHit & {
  trackId: TrackId;
};

/** 현재 score가 앱에 들어온 출처. timestamp 저장 정책을 결정할 때 사용한다. */
export type ScoreOrigin = "template" | "loaded" | "saved";

/** 메뉴 영역에 적용하는 UI theme. */
export type MenuTheme = "light" | "dark";

/** Loop 시작/끝 column 선택을 기다리는 상태. */
export type LoopPickMode = "start" | "end";

/** score JSON에 저장하지 않는 runtime loop range 상태. */
export type LoopState = {
  enabled: boolean;
  startTick: number | null;
  endTick: number | null;
  pickMode: LoopPickMode | null;
};

/** 문서, 파생 산출물, UI 모드를 함께 보관하는 앱 상태. */
export type AppState = {
  document: RuntimeDocument;
  scoreOrigin: ScoreOrigin;
  parsed: ParsedScoreDocument;
  analysis: AnalysisResult;
  renderInput: CanvasAnalyzedRenderInput;
  activeTrackIds: TrackId[];
  reverseRows: boolean;
  menuTheme: MenuTheme;
  speedScale: number;
  textOff: boolean;
  loop: LoopState;
  mode: AppMode;
  busy: AppBusyState;
  statusMessage: UiStatusMessage;
  selection: ScoreSelection | null;
  layout: CanvasScoreLayout | null;
  defaultLayoutDraft: LayoutDraftBundle;
};

/** 앱 진입점에서 제어하는 DOM 요소 묶음. */
export type AppDom = {
  appShell: HTMLElement;
  scoreViewer: HTMLElement;
  scoreArea: HTMLElement;
  scoreStage: HTMLElement;
  layoutStage: HTMLElement;
  target: CanvasRenderTarget;
  editToggle: HTMLInputElement;
  trackToggleButtons: HTMLButtonElement[];
  defaultModeSelect: HTMLSelectElement;
  customTextInput: HTMLInputElement;
  holdTokenSelect: HTMLSelectElement;
  glissKindSelect: HTMLSelectElement;
  glissIdSelect: HTMLSelectElement;
  tremDivisionSelect: HTMLSelectElement;
  absolutePitchSelect: HTMLSelectElement;
  microPitchInput: HTMLInputElement;
  tupletModeToggle: HTMLButtonElement;
  tupletDivisionSelect: HTMLSelectElement;
  tupletInsertModeSelect: HTMLSelectElement;
  tupletFinalizeButton: HTMLButtonElement;
  tupletSlotInputs: HTMLInputElement[];
  numberRawInput: HTMLInputElement;
  numberRampButtons: HTMLButtonElement[];
  currentRawTextPreview: HTMLElement;
  jsonLoadButton: HTMLButtonElement;
  jsonDownloadButton: HTMLButtonElement;
  jsonLoadInput: HTMLInputElement;
  localSaveButton: HTMLButtonElement;
  localLoadButton: HTMLButtonElement;
  zoomInput: HTMLInputElement;
  speedInput: HTMLInputElement;
  textOffInput: HTMLInputElement;
  loopToggleButton: HTMLButtonElement;
  loopStartSelect: HTMLSelectElement;
  loopEndSelect: HTMLSelectElement;
  loopStartValue: HTMLElement;
  loopEndValue: HTMLElement;
  fullscreenButton: HTMLButtonElement;
  fitHeightButton: HTMLButtonElement;
  reverseButton: HTMLButtonElement;
  themeButton: HTMLButtonElement;
  expandColumnInput: HTMLInputElement;
  expandRightButton: HTMLButtonElement;
  trimRightButton: HTMLButtonElement;
  clearAllButton: HTMLButtonElement;
  layoutPresetToolbarSelect: HTMLSelectElement;
  layoutModifyButton: HTMLButtonElement;
  detailsButton: HTMLButtonElement;
  detailsDialog: HTMLDialogElement;
  detailsForm: HTMLFormElement;
  detailsCloseButton: HTMLButtonElement;
  detailsCancelButton: HTMLButtonElement;
  detailsTitleInput: HTMLInputElement;
  detailsArtistInput: HTMLInputElement;
  detailsGenreInput: HTMLInputElement;
  detailsWriterInput: HTMLInputElement;
  detailsCommentInput: HTMLTextAreaElement;
  detailsBasicDifficultyInput: HTMLInputElement;
  detailsOptionalDifficultyInput: HTMLInputElement;
  detailsExtraDifficultyInput: HTMLInputElement;
  youtubeToggle: HTMLInputElement;
  youtubeVideoInput: HTMLInputElement;
  youtubeOffsetInput: HTMLInputElement;
  youtubeReloadButton: HTMLButtonElement;
  youtubeStatus: HTMLElement;
  youtubePlayerShell: HTMLElement;
  youtubePlayer: HTMLElement;
  layoutDialog: HTMLDialogElement;
  layoutForm: HTMLFormElement;
  layoutCloseButton: HTMLButtonElement;
  layoutCancelButton: HTMLButtonElement;
  layoutResetButton: HTMLButtonElement;
  layoutApplyButton: HTMLButtonElement;
  layoutPresetSelect: HTMLSelectElement;
  layoutNewPresetButton: HTMLButtonElement;
  layoutPresetNameInput: HTMLInputElement;
  layoutLocalSaveButton: HTMLButtonElement;
  layoutLocalLoadButton: HTMLButtonElement;
  layoutFileSaveButton: HTMLButtonElement;
  layoutFileLoadButton: HTMLButtonElement;
  layoutFileLoadInput: HTMLInputElement;
  layoutFamilyInput: HTMLSelectElement;
  layoutSupportsOpenInput: HTMLInputElement;
  layoutStringList: HTMLElement;
  layoutStringSelect: HTMLSelectElement;
  layoutNoteHeightInput: HTMLInputElement;
  layoutRowList: HTMLElement;
  layoutPreview: HTMLElement;
  layoutRowTypeSelect: HTMLSelectElement;
  layoutRowHeightInput: HTMLInputElement;
  layoutAddRowBelowButton: HTMLButtonElement;
  layoutAddRowAboveButton: HTMLButtonElement;
  layoutStatusLine: HTMLElement;
  playButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  seekInput: HTMLInputElement;
  seekCurrentLabel: HTMLElement;
  seekDurationLabel: HTMLElement;
  playbackStatus: HTMLElement;
  tempoStatus: HTMLElement;
  musicArtist: HTMLElement;
  musicTitle: HTMLElement;
  volumeInput: HTMLInputElement;
  waveSelect: HTMLSelectElement;
  leftStatusLine: HTMLElement;
};
