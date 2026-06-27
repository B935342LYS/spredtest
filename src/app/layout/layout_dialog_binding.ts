/**
 * layout dialog와 layout preset toolbar event를 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import type {
  InstrumentString,
} from "../../core/score/types";
import { applyLayoutDraftEditToState } from "../app_runtime";
import {
  addLayoutDraftRow,
  createLayoutDraftBundle,
  deleteLayoutDraftRow,
  getLayoutDraftCommonNoteHeight,
  getRowsForSelectedString,
  selectLayoutDraftRow,
  selectLayoutDraftString,
  updateLayoutDraftCommonNoteHeight,
  updateLayoutDraftRowHeight,
  type LayoutDraftMutationResult,
  type LayoutInsertPosition,
} from "./layout_draft";
import type {
  LayoutDraftBundle,
  LayoutEditableRowDefinition,
} from "./layout_types";
import { calculateLayoutCellDeletionSummary } from "./layout_apply";
import {
  createLayoutDraftFromPreset,
  createLayoutPresetFileName,
  createUserLayoutPresetData,
  parseUserLayoutPresetJson,
  serializeUserLayoutPresetData,
} from "./layout_preset";
import { isGameModeLocked } from "../game/game_types";
import { formatPitchName } from "../pitch_label";
import { colorForLabelMidi } from "../../renderer/canvas_note_colors";
import { syncLeftStatus } from "../app_ui_sync";
import {
  downloadTextFile,
  readTextFile,
} from "../../infra/score_file_io";
import {
  type LocalLayoutPresetSlot,
  type LocalLayoutPresetSlotNumber,
  createSlotLayoutPresetId,
  loadLayoutPresetSlotFromLocalStorage,
  loadLayoutPresetSlotsFromLocalStorage,
  parseLocalLayoutPresetSlotNumber,
  saveLayoutPresetSlotToLocalStorage,
} from "../../infra/layout_preset_storage";

/** layout dialog binding이 app 상태와 render 흐름을 제어하기 위한 session 입력. */
export type LayoutDialogBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  render(): void;
  resetPlaybackForCurrentState(): void;
};

/** layout preview row drag 중 보관하는 pointer 기준값. */
type LayoutPreviewDragState = {
  dom: AppDom;
  rowId: string;
  edge: "top" | "bottom";
  startY: number;
  startHeight: number;
  lastHeight: number;
};

let activeLayoutDraft: LayoutDraftBundle | null = null;
let activeLayoutPreviewDrag: LayoutPreviewDragState | null = null;

/**
 * layout dialog의 instrument/string/row 영역을 현재 draft 값으로 채운다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : draft : 현재 layout dialog draft
 * - 인수 : message : 상태 줄에 표시할 문구
 * - 인수 : level : 상태 문구 중요도
 * - 반환값 : 없음
 */
function syncLayoutDialogFromDraft(
  dom: AppDom,
  draft: LayoutDraftBundle,
  message = "Layout draft is ready.",
  level: "info" | "warning" | "error" = "info",
): void {
  const instData = draft.instData;

  dom.layoutPresetNameInput.value = draft.layoutPresetDisplayName;
  if (!Array.from(dom.layoutFamilyInput.options).some((option) => option.value === instData.family)) {
    dom.layoutFamilyInput.value = "custom";
  } else {
    dom.layoutFamilyInput.value = instData.family;
  }
  dom.layoutSupportsOpenInput.checked = instData.supportsOpen;
  dom.layoutStringSelect.replaceChildren();
  dom.layoutStringList.replaceChildren();
  dom.layoutStatusLine.textContent = message;
  dom.layoutStatusLine.dataset.level = level;

  for (const stringInfo of instData.strings) {
    dom.layoutStringSelect.appendChild(createStringOption(stringInfo));
    dom.layoutStringList.appendChild(createStringSummaryRow(stringInfo));
  }
  bindLayoutStringPitchInputs(dom);

  dom.layoutStringSelect.value = draft.selectedStringId ?? "";
  dom.layoutNoteHeightInput.value = String(getLayoutDraftCommonNoteHeight(draft));
  syncLayoutAddRowHeightState(dom);
  renderLayoutDraftRows(dom, draft);
  renderLayoutDraftPreview(dom, draft);
}

/**
 * 현재 score의 악기 프리셋에 해당하는 로컬 layout preset 슬롯을 select에 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : slots : localStorage에서 읽은 Slot 1..3 저장 상태
 * - 인수 : selectedSlotNumber : 선택할 슬롯 번호
 * - 반환값 : 없음
 */
function syncLayoutPresetSelect(
  dom: AppDom,
  slots: LocalLayoutPresetSlot[],
  selectedSlotNumber: LocalLayoutPresetSlotNumber = 1,
): void {
  dom.layoutPresetSelect.replaceChildren();

  for (const slot of slots) {
    const option = document.createElement("option");
    const suffix = slot.preset === null ? "Empty" : slot.layoutPresetDisplayName;

    option.value = createSlotLayoutPresetId(slot.slotNumber);
    option.textContent = `Slot ${slot.slotNumber}: ${suffix}`;
    dom.layoutPresetSelect.appendChild(option);
  }

  dom.layoutPresetSelect.value = createSlotLayoutPresetId(selectedSlotNumber);
}

/**
 * layout toolbar의 preset dropdown을 현재 local slot 상태와 동기화한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : slots : localStorage에서 읽은 Slot 1..3 저장 상태
 * - 인수 : selectedValue : 선택할 option value
 * - 반환값 : 없음
 */
function syncLayoutToolbarPresetSelect(
  dom: AppDom,
  slots: LocalLayoutPresetSlot[],
  selectedValue = "default",
): void {
  const defaultOption = document.createElement("option");

  dom.layoutPresetToolbarSelect.replaceChildren();
  defaultOption.value = "default";
  defaultOption.textContent = "Default Layout";
  dom.layoutPresetToolbarSelect.appendChild(defaultOption);

  for (const slot of slots) {
    const option = document.createElement("option");
    const suffix = slot.preset === null ? "Empty" : slot.layoutPresetDisplayName;

    option.value = createSlotLayoutPresetId(slot.slotNumber);
    option.textContent = `Slot ${slot.slotNumber}: ${suffix}`;
    dom.layoutPresetToolbarSelect.appendChild(option);
  }

  dom.layoutPresetToolbarSelect.value = selectedValue;

  if (dom.layoutPresetToolbarSelect.value === "") {
    dom.layoutPresetToolbarSelect.value = "default";
  }
}

/**
 * layout string 선택지를 만든다.
 * - 인수 : stringInfo : ScoreFile.instData.strings의 단일 현 정보
 * - 반환값 : stringId를 값으로 가진 option 요소
 */
function createStringOption(stringInfo: InstrumentString): HTMLOptionElement {
  const option = document.createElement("option");

  option.value = stringInfo.stringId;
  option.textContent = `${stringInfo.stringId} · ${stringInfo.stringName}`;

  return option;
}

/**
 * layout dialog의 string 요약 row를 만든다.
 * - 인수 : stringInfo : ScoreFile.instData.strings의 단일 현 정보
 * - 반환값 : string 정보를 표시하는 row 요소
 */
function createStringSummaryRow(stringInfo: InstrumentString): HTMLElement {
  const row = document.createElement("div");

  row.className = "layout-table-row";
  row.dataset.stringId = stringInfo.stringId;
  row.append(
    createLayoutCell(stringInfo.stringId),
    createLayoutCell(stringInfo.stringName),
    createPitchSelect(stringInfo.minMidi, "Min MIDI", "minMidi"),
    createPitchSelect(stringInfo.maxMidi, "Max MIDI", "maxMidi"),
    createPitchSelect(stringInfo.openMidi ?? stringInfo.minMidi, "Open MIDI", "openMidi", true),
  );

  return row;
}

/**
 * layout instrument string row에서 MIDI 값을 계이름 dropdown으로 표시한다.
 * - 인수 : selectedMidi : 현재 선택된 MIDI note number
 * - 인수 : label : 접근성 label
 * - 반환값 : 0..127 MIDI 선택지를 가진 select 요소
 */
function createPitchSelect(
  selectedMidi: number,
  label: string,
  field: "minMidi" | "maxMidi" | "openMidi",
  disabled = false,
): HTMLSelectElement {
  const select = document.createElement("select");

  select.className = "layout-string-pitch-select";
  select.dataset.field = field;
  select.setAttribute("aria-label", label);
  select.disabled = disabled;

  for (let midi = 127; midi >= 0; midi -= 1) {
    const option = document.createElement("option");

    option.value = String(midi);
    option.textContent = formatPitchName(midi, "sharp");
    select.appendChild(option);
  }

  select.value = String(selectedMidi);

  return select;
}

/**
 * layout dialog 표시에 사용할 단순 cell 요소를 만든다.
 * - 인수 : text : 표시할 문자열
 * - 반환값 : 텍스트가 들어간 span 요소
 */
function createLayoutCell(text: string): HTMLSpanElement {
  const cell = document.createElement("span");

  cell.textContent = text;

  return cell;
}

/**
 * layout dialog의 비어 있는 목록 표시 요소를 만든다.
 * - 인수 : message : 빈 상태 안내 문구
 * - 반환값 : 빈 상태 row 요소
 */
function createLayoutEmptyState(message: string): HTMLElement {
  const row = document.createElement("p");

  row.className = "layout-empty-state";
  row.textContent = message;

  return row;
}

/**
 * layout dialog의 선택 string row 목록을 렌더링한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : draft : 현재 layout draft
 * - 반환값 : 없음
 */
function renderLayoutDraftRows(dom: AppDom, draft: LayoutDraftBundle): void {
  const rows = getRowsForSelectedString(draft);

  dom.layoutRowList.replaceChildren();

  if (rows.length === 0) {
    dom.layoutRowList.appendChild(createLayoutEmptyState("No editable rows for this string."));
    return;
  }

  dom.layoutRowList.appendChild(createLayoutRowTableHead());

  for (const row of rows) {
    dom.layoutRowList.appendChild(createLayoutDraftRowElement(dom, draft, row));
  }
}

/**
 * layout dialog의 선택 string row를 작은 세로 preview로 렌더링한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : draft : 현재 layout draft
 * - 반환값 : 없음
 */
function renderLayoutDraftPreview(dom: AppDom, draft: LayoutDraftBundle): void {
  const rows = getRowsForSelectedString(draft);

  dom.layoutPreview.replaceChildren();

  if (rows.length === 0) {
    dom.layoutPreview.appendChild(createLayoutEmptyState("No rows to preview."));
    return;
  }

  const stack = document.createElement("div");

  stack.className = "layout-preview-stack";

  for (const row of rows) {
    const rowElement = createLayoutPreviewRow(dom, draft, row);

    stack.appendChild(rowElement);
  }

  dom.layoutPreview.appendChild(stack);
}

/**
 * layout preview row 하나를 만든다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : draft : 현재 layout draft
 * - 인수 : row : 표시할 note/gap row
 * - 반환값 : preview row 요소
 */
function createLayoutPreviewRow(
  dom: AppDom,
  draft: LayoutDraftBundle,
  row: LayoutEditableRowDefinition,
): HTMLElement {
  const rowElement = document.createElement("div");
  const leftPadding = document.createElement("span");
  const label = document.createElement("span");
  const rightPadding = document.createElement("span");

  rowElement.className = "layout-preview-row";
  rowElement.dataset.rowType = row.type;
  rowElement.dataset.selected = draft.selectedRowId === row.rowId ? "true" : "false";
  rowElement.style.height = `${row.height}px`;

  leftPadding.className = "layout-preview-padding-cell";
  label.className = "layout-preview-row-label";
  rightPadding.className = "layout-preview-padding-cell layout-preview-right-padding-cell";

  if (row.type === "note") {
    rowElement.style.setProperty("--layout-preview-label-bg", colorForLabelMidi(row.midi));
    label.textContent = row.displayLabel;
  } else {
    label.textContent = "";
  }

  rowElement.append(leftPadding, label, rightPadding);

  if (row.type === "gap") {
    const topHandle = createLayoutPreviewGapResizeHandle(row.rowId, "top");
    const bottomHandle = createLayoutPreviewGapResizeHandle(row.rowId, "bottom");

    rowElement.append(topHandle, bottomHandle);
    topHandle.addEventListener("pointerdown", (event) => {
      beginLayoutPreviewResize(dom, event, row, "top");
    });
    bottomHandle.addEventListener("pointerdown", (event) => {
      beginLayoutPreviewResize(dom, event, row, "bottom");
    });
  }

  rowElement.addEventListener("click", (event) => {
    if (event.target instanceof HTMLButtonElement) {
      return;
    }

    applyLayoutDraftChange(dom, {
      ok: true,
      draft: selectLayoutDraftRow(requireActiveLayoutDraft(), row.rowId),
      message: `Selected ${row.rowId}.`,
    });
  });

  return rowElement;
}

/**
 * gap row의 위/아래 resize handle을 만든다.
 * - 인수 : rowId : 조절할 gap rowId
 * - 인수 : edge : gap row의 위쪽 또는 아래쪽 경계
 * - 반환값 : pointer drag를 받을 button 요소
 */
function createLayoutPreviewGapResizeHandle(
  rowId: string,
  edge: "top" | "bottom",
): HTMLButtonElement {
  const handle = document.createElement("button");

  handle.type = "button";
  handle.className = `layout-preview-resize-handle layout-preview-resize-handle-${edge}`;
  handle.setAttribute("aria-label", `Resize ${rowId}`);

  return handle;
}

/**
 * layout preview row resize drag를 시작한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : event : resize handle pointerdown event
 * - 인수 : row : 높이를 조절할 draft row
 * - 인수 : edge : gap row의 위쪽 또는 아래쪽 경계
 * - 반환값 : 없음
 */
function beginLayoutPreviewResize(
  dom: AppDom,
  event: PointerEvent,
  row: LayoutEditableRowDefinition,
  edge: "top" | "bottom",
): void {
  event.preventDefault();
  event.stopPropagation();

  activeLayoutPreviewDrag = {
    dom,
    rowId: row.rowId,
    edge,
    startY: event.clientY,
    startHeight: row.height,
    lastHeight: row.height,
  };

  applyLayoutDraftChange(dom, {
    ok: true,
    draft: selectLayoutDraftRow(requireActiveLayoutDraft(), row.rowId),
    message: `Drag to resize ${row.rowId}.`,
  });

  window.addEventListener("pointermove", handleLayoutPreviewResizeMove);
  window.addEventListener("pointerup", handleLayoutPreviewResizeEnd);
  window.addEventListener("pointercancel", handleLayoutPreviewResizeEnd);
}

/**
 * layout preview row resize drag 중 pointer 이동을 draft height로 변환한다.
 * - 인수 : event : pointermove event
 * - 반환값 : 없음
 */
function handleLayoutPreviewResizeMove(event: PointerEvent): void {
  if (activeLayoutPreviewDrag === null) {
    return;
  }

  const drag = activeLayoutPreviewDrag;
  const delta = Math.round(event.clientY - drag.startY);
  const signedDelta = drag.edge === "top" ? -delta : delta;
  const nextHeight = Math.max(1, Math.min(500, drag.startHeight + signedDelta));

  if (nextHeight === drag.lastHeight) {
    return;
  }

  const draft = requireActiveLayoutDraft();
  const result = updateLayoutDraftRowHeight(draft, drag.rowId, nextHeight);

  if (!result.ok) {
    return;
  }

  activeLayoutPreviewDrag = {
    ...drag,
    lastHeight: nextHeight,
  };
  activeLayoutDraft = result.draft;
  syncLayoutDialogFromDraft(
    drag.dom,
    activeLayoutDraft,
    `Resized ${drag.rowId} to ${nextHeight}px.`,
  );
}

/**
 * layout preview row resize drag를 끝내고 전역 pointer listener를 해제한다.
 * - 인수 : 없음
 * - 반환값 : 없음
 */
function handleLayoutPreviewResizeEnd(): void {
  activeLayoutPreviewDrag = null;
  window.removeEventListener("pointermove", handleLayoutPreviewResizeMove);
  window.removeEventListener("pointerup", handleLayoutPreviewResizeEnd);
  window.removeEventListener("pointercancel", handleLayoutPreviewResizeEnd);
}

/**
 * layout row list의 머리글을 만든다.
 * - 인수 : 없음
 * - 반환값 : row list head 요소
 */
function createLayoutRowTableHead(): HTMLElement {
  const head = document.createElement("div");

  head.className = "layout-row-table-head";
  head.append(
    createLayoutCell(""),
    createLayoutCell("Type"),
    createLayoutCell("Row ID"),
    createLayoutCell("Pitch"),
    createLayoutCell("Height"),
    createLayoutCell(""),
  );

  return head;
}

/**
 * layout draft row 하나를 표시하는 DOM 요소를 만든다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : draft : 현재 layout draft
 * - 인수 : row : 표시할 note/gap row
 * - 반환값 : row DOM 요소
 */
function createLayoutDraftRowElement(
  dom: AppDom,
  draft: LayoutDraftBundle,
  row: LayoutEditableRowDefinition,
): HTMLElement {
  const element = document.createElement("div");
  const selectInput = document.createElement("input");
  const heightCell = document.createElement("span");
  const deleteCell = document.createElement("span");

  element.className = "layout-row-table-row";
  element.dataset.selected = draft.selectedRowId === row.rowId ? "true" : "false";
  element.dataset.rowType = row.type;

  selectInput.type = "radio";
  selectInput.name = "layout-row-selection";
  selectInput.value = row.rowId;
  selectInput.checked = draft.selectedRowId === row.rowId;
  selectInput.setAttribute("aria-label", `Select ${row.rowId}`);

  if (row.type === "gap") {
    const heightInput = document.createElement("input");

    heightInput.type = "number";
    heightInput.min = "1";
    heightInput.max = "500";
    heightInput.step = "1";
    heightInput.value = String(row.height);
    heightInput.className = "layout-row-height-edit";
    heightInput.setAttribute("aria-label", `Height for ${row.rowId}`);
    heightInput.addEventListener("change", () => {
      applyLayoutDraftChange(
        dom,
        updateLayoutDraftRowHeight(
          requireActiveLayoutDraft(),
          row.rowId,
          Number(heightInput.value),
        ),
      );
    });
    heightCell.appendChild(heightInput);
  }

  if (canShowLayoutRowDeleteButton(draft, row)) {
    const deleteButton = document.createElement("button");

    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.className = "layout-row-delete-button";
    deleteButton.addEventListener("click", () => {
      applyLayoutDraftChange(dom, deleteLayoutDraftRow(requireActiveLayoutDraft(), row.rowId));
    });
    deleteCell.appendChild(deleteButton);
  }

  element.append(
    wrapLayoutControl(selectInput),
    createLayoutCell(row.type),
    createLayoutCell(row.rowId),
    createLayoutCell(formatLayoutRowPitch(row)),
    heightCell,
    deleteCell,
  );

  // row 클릭은 radio와 같은 선택 동작으로 처리한다.
  element.addEventListener("click", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) {
      return;
    }

    applyLayoutDraftChange(dom, {
      ok: true,
      draft: selectLayoutDraftRow(requireActiveLayoutDraft(), row.rowId),
      message: `Selected ${row.rowId}.`,
    });
  });
  selectInput.addEventListener("change", () => {
    applyLayoutDraftChange(dom, {
      ok: true,
      draft: selectLayoutDraftRow(requireActiveLayoutDraft(), row.rowId),
      message: `Selected ${row.rowId}.`,
    });
  });
  return element;
}

/**
 * row list에서 delete 버튼을 표시할지 결정한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : row : 표시 중인 note/gap row
 * - 반환값 : delete 버튼 표시 여부
 */
function canShowLayoutRowDeleteButton(
  draft: LayoutDraftBundle,
  row: LayoutEditableRowDefinition,
): boolean {
  if (row.type === "gap") {
    return true;
  }

  const noteRows = draft.rowDefinitions.filter(
    (candidate) => candidate.type === "note" && candidate.stringId === row.stringId,
  );

  if (noteRows.length <= 1) {
    return false;
  }

  return row.rowId === noteRows[0]?.rowId
    || row.rowId === noteRows[noteRows.length - 1]?.rowId;
}

/**
 * row list 안에 들어갈 control을 고정 크기 cell에 감싼다.
 * - 인수 : control : input 또는 button 요소
 * - 반환값 : control을 담은 span 요소
 */
function wrapLayoutControl(control: HTMLElement): HTMLSpanElement {
  const cell = document.createElement("span");

  cell.appendChild(control);

  return cell;
}

/**
 * note row의 pitch 표시 문자열을 만든다.
 * - 인수 : row : 표시할 note/gap row
 * - 반환값 : note pitch 문자열. gap row는 사용자에게 내부 MIDI range를 표시하지 않는다.
 */
function formatLayoutRowPitch(row: LayoutEditableRowDefinition): string {
  if (row.type === "note") {
    return `${row.displayLabel} (${row.midi})`;
  }

  return "";
}

/**
 * active layout draft를 반환한다.
 * - 인수 : 없음
 * - 반환값 : 현재 열린 layout dialog draft
 */
function requireActiveLayoutDraft(): LayoutDraftBundle {
  if (activeLayoutDraft === null) {
    throw new Error("Layout draft is not initialized.");
  }

  return activeLayoutDraft;
}

/**
 * layout draft 변경 결과를 dialog에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : result : draft 변경 결과
 * - 반환값 : 없음
 */
function applyLayoutDraftChange(
  dom: AppDom,
  result: LayoutDraftMutationResult,
): void {
  if (!result.ok) {
    setLayoutDialogNotice(dom, result.message, result.level);
    return;
  }

  activeLayoutDraft = result.draft;
  syncLayoutDialogFromDraft(dom, activeLayoutDraft, result.message);
}

/**
 * dialog의 현재 입력값 중 즉시 draft에 반영할 상위 설정을 병합한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : dialog 입력값이 반영된 layout draft
 */
function readLayoutDraftFromDialog(dom: AppDom): LayoutDraftBundle {
  const draft = requireActiveLayoutDraft();
  const layoutPresetDisplayName = dom.layoutPresetNameInput.value.trim()
    || draft.layoutPresetDisplayName;
  const strings = readLayoutInstrumentStringsFromDialog(dom, draft);

  return {
    ...draft,
    layoutPresetDisplayName,
    instData: {
      ...draft.instData,
      family: dom.layoutFamilyInput.value,
      instName: layoutPresetDisplayName,
      supportsOpen: dom.layoutSupportsOpenInput.checked,
      strings,
    },
  };
}

/**
 * layout dialog의 string MIDI select 값을 draft instData strings로 읽는다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : draft : 기존 string 정보를 보관한 현재 layout draft
 * - 반환값 : dialog 입력값이 반영된 악기 string 목록
 */
function readLayoutInstrumentStringsFromDialog(
  dom: AppDom,
  draft: LayoutDraftBundle,
): InstrumentString[] {
  const rowByStringId = new Map<string, HTMLElement>();

  dom.layoutStringList.querySelectorAll<HTMLElement>(".layout-table-row").forEach((row) => {
    const stringId = row.dataset.stringId;

    if (stringId !== undefined) {
      rowByStringId.set(stringId, row);
    }
  });

  return draft.instData.strings.map((stringInfo) => {
    const row = rowByStringId.get(stringInfo.stringId);

    if (row === undefined) {
      return { ...stringInfo };
    }

    const minMidi = readLayoutStringPitchSelect(row, "minMidi", stringInfo.minMidi);
    const maxMidi = readLayoutStringPitchSelect(row, "maxMidi", stringInfo.maxMidi);
    const openMidi = readLayoutStringPitchSelect(row, "openMidi", stringInfo.openMidi ?? minMidi);

    const { openMidi: _openMidi, ...baseStringInfo } = stringInfo;

    return {
      ...baseStringInfo,
      minMidi,
      maxMidi,
      ...(dom.layoutSupportsOpenInput.checked ? { openMidi } : {}),
    };
  });
}

/**
 * string 요약 row에서 지정한 MIDI select 값을 읽는다.
 * - 인수 : row : string 요약 row DOM 요소
 * - 인수 : field : 읽을 MIDI 필드명
 * - 인수 : fallback : select를 찾지 못하거나 숫자가 아니면 사용할 값
 * - 반환값 : 선택된 MIDI 값
 */
function readLayoutStringPitchSelect(
  row: HTMLElement,
  field: "minMidi" | "maxMidi" | "openMidi",
  fallback: number,
): number {
  const select = row.querySelector<HTMLSelectElement>(`select[data-field="${field}"]`);
  const value = select === null ? Number.NaN : Number.parseInt(select.value, 10);

  return Number.isInteger(value) ? value : fallback;
}

/**
 * string MIDI select 변경을 현재 active layout draft의 instData에 즉시 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
function bindLayoutStringPitchInputs(dom: AppDom): void {
  dom.layoutStringList.querySelectorAll<HTMLSelectElement>(".layout-string-pitch-select").forEach((select) => {
    select.addEventListener("change", () => {
      activeLayoutDraft = readLayoutDraftFromDialog(dom);
    });
  });
}

/**
 * layout draft를 현재 ScoreFile에 적용한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
function applyLayoutDialogDraft(
  dom: AppDom,
  session: LayoutDialogBindingSession,
): void {
  if (isGameModeLocked(session.getState().gameMode)) {
    setLayoutDialogNotice(dom, "Exit practice mode before applying layout changes.", "warning");
    return;
  }

  const draft = readLayoutDraftFromDialog(dom);
  const deletionSummary = calculateLayoutCellDeletionSummary(
    session.getState().document.score,
    draft,
  );
  let allowCellDeletion = false;

  if (deletionSummary.totalCount > 0) {
    allowCellDeletion = window.confirm(
      `This layout change will delete ${deletionSummary.totalCount} track cell(s). Continue?`,
    );

    if (!allowCellDeletion) {
      setLayoutDialogNotice(
        dom,
        "Layout apply was cancelled before deleting track cells.",
        "warning",
      );
      return;
    }
  }

  const nextState = applyLayoutDraftEditToState(
    session.getState(),
    draft,
    allowCellDeletion,
  );

  session.setState(nextState);

  if (nextState.statusMessage.level !== "info") {
    setLayoutDialogNotice(dom, nextState.statusMessage.text, nextState.statusMessage.level);
    return;
  }

  handleLayoutPreviewResizeEnd();
  activeLayoutDraft = null;
  dom.layoutDialog.close();
  session.render();
  session.resetPlaybackForCurrentState();
  syncLeftStatus(dom, session.getState());
}

/**
 * 아직 구현되지 않은 layout dialog action에 대한 상태 문구를 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : message : 사용자에게 표시할 안내 문구
 * - 반환값 : 없음
 */
function setLayoutDialogNotice(
  dom: AppDom,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  dom.layoutStatusLine.textContent = message;
  dom.layoutStatusLine.dataset.level = level;
}

/**
 * layout dialog를 현재 score 값으로 채운 뒤 연다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회 callback 묶음
 * - 반환값 : 없음
 */
export function openLayoutDialog(
  dom: AppDom,
  session: Pick<LayoutDialogBindingSession, "getState">,
): void {
  const score = session.getState().document.score;

  activeLayoutDraft = createLayoutDraftBundle(score);
  syncLayoutDialogFromDraft(dom, activeLayoutDraft, "Layout draft is ready.");
  syncLayoutPresetSelect(
    dom,
    loadLayoutPresetSlotsForDialog(dom, score.instData.presetId),
  );
  dom.layoutDialog.showModal();
}

/**
 * 현재 score의 악기 프리셋 ID를 반환한다.
 * - 인수 : session : app 상태 조회 callback 묶음
 * - 반환값 : 현재 score의 instrument preset ID
 */
function getCurrentInstrumentPresetId(session: Pick<LayoutDialogBindingSession, "getState">): string {
  return session.getState().document.score.instData.presetId;
}

/**
 * localStorage layout preset 슬롯을 읽되 오류가 나도 dialog를 계속 사용할 수 있게 한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : instrumentPresetId : 현재 score의 악기 프리셋 ID
 * - 반환값 : 읽기에 성공한 Slot 1..3 저장 상태 또는 빈 슬롯 목록
 */
function loadLayoutPresetSlotsForDialog(
  dom: AppDom,
  instrumentPresetId: string,
): LocalLayoutPresetSlot[] {
  try {
    return loadLayoutPresetSlotsFromLocalStorage(instrumentPresetId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown local layout preset slot error.";

    setLayoutDialogNotice(dom, message, "error");
    return [1, 2, 3].map((slotNumber) => ({
      slotNumber: slotNumber as LocalLayoutPresetSlotNumber,
      layoutPresetId: createSlotLayoutPresetId(slotNumber as LocalLayoutPresetSlotNumber),
      layoutPresetDisplayName: `Slot ${slotNumber} Empty`,
      updatedAt: null,
      preset: null,
    }));
  }
}

/**
 * 현재 score의 악기 프리셋에 맞춰 layout toolbar preset 목록을 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회 callback 묶음
 * - 인수 : selectedValue : 선택할 option value
 * - 반환값 : 없음
 */
export function syncLayoutToolbarPresetSelectForCurrentScore(
  dom: AppDom,
  session: Pick<LayoutDialogBindingSession, "getState">,
  selectedValue = dom.layoutPresetToolbarSelect.value || "default",
): void {
  syncLayoutToolbarPresetSelect(
    dom,
    loadLayoutPresetSlotsForDialog(dom, getCurrentInstrumentPresetId(session)),
    selectedValue,
  );
}

/**
 * layout toolbar에서 선택한 로컬 프리셋을 현재 ScoreFile에 즉시 적용한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
function applyLayoutToolbarPreset(
  dom: AppDom,
  session: LayoutDialogBindingSession,
): void {
  const selectedValue = dom.layoutPresetToolbarSelect.value;
  const state = session.getState();

  if (isGameModeLocked(state.gameMode)) {
    syncLayoutToolbarPresetSelectForCurrentScore(dom, session);
    session.setState({
      ...state,
      statusMessage: {
        level: "warning",
        text: "Exit practice mode before changing layout.",
      },
    });
    syncLeftStatus(dom, session.getState());
    return;
  }

  if (selectedValue === "default") {
    applyLayoutToolbarDraft(
      dom,
      session,
      state.defaultLayoutDraft,
      selectedValue,
      "Default layout",
    );
    return;
  }

  const slotNumber = parseLocalLayoutPresetSlotNumber(selectedValue);

  if (slotNumber === null) {
    syncLayoutToolbarPresetSelectForCurrentScore(dom, session);
    return;
  }

  try {
    const instrumentPresetId = state.document.score.instData.presetId;
    const preset = loadLayoutPresetSlotFromLocalStorage(instrumentPresetId, slotNumber);

    if (preset === null) {
      applyLayoutToolbarDraft(
        dom,
        session,
        state.defaultLayoutDraft,
        "default",
        `Slot ${slotNumber} fallback default layout`,
      );
      return;
    }

    const draft = createLayoutDraftFromPreset(
      preset,
      createLayoutDraftBundle(state.document.score),
    );
    applyLayoutToolbarDraft(dom, session, draft, selectedValue, "Layout preset");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown layout preset apply error.";
    const nextState = {
      ...state,
      statusMessage: {
        level: "error" as const,
        text: message,
      },
    };

    session.setState(nextState);
    syncLayoutToolbarPresetSelectForCurrentScore(dom, session);
    syncLeftStatus(dom, nextState);
  }
}

/**
 * toolbar에서 선택한 layout draft를 현재 score에 적용한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 인수 : draft : 적용할 layout draft
 * - 인수 : selectedValue : 적용 성공 후 toolbar에서 유지할 선택값
 * - 인수 : label : 확인창과 상태 메시지에 사용할 layout 종류
 * - 반환값 : 없음
 */
function applyLayoutToolbarDraft(
  dom: AppDom,
  session: LayoutDialogBindingSession,
  draft: LayoutDraftBundle,
  selectedValue: string,
  label: string,
): void {
  const state = session.getState();

  if (isGameModeLocked(state.gameMode)) {
    syncLayoutToolbarPresetSelectForCurrentScore(dom, session);
    session.setState({
      ...state,
      statusMessage: {
        level: "warning",
        text: "Exit practice mode before changing layout.",
      },
    });
    syncLeftStatus(dom, session.getState());
    return;
  }

  const deletionSummary = calculateLayoutCellDeletionSummary(state.document.score, draft);
  let allowCellDeletion = false;

  if (deletionSummary.totalCount > 0) {
    allowCellDeletion = window.confirm(
      `${label} will delete ${deletionSummary.totalCount} track cell(s). Continue?`,
    );

    if (!allowCellDeletion) {
      const nextState = {
        ...state,
        statusMessage: {
          level: "warning" as const,
          text: `${label} apply was cancelled before deleting track cells.`,
        },
      };

      session.setState(nextState);
      syncLayoutToolbarPresetSelectForCurrentScore(dom, session);
      syncLeftStatus(dom, nextState);
      return;
    }
  }

  const nextState = applyLayoutDraftEditToState(state, draft, allowCellDeletion);

  session.setState(nextState);

  if (nextState.statusMessage.level !== "info") {
    syncLayoutToolbarPresetSelectForCurrentScore(dom, session);
    syncLeftStatus(dom, nextState);
    return;
  }

  session.render();
  session.resetPlaybackForCurrentState();
  syncLeftStatus(dom, session.getState());
  syncLayoutToolbarPresetSelectForCurrentScore(dom, session, selectedValue);
}

/**
 * localStorage에 현재 draft를 레이아웃 프리셋으로 저장한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회 callback 묶음
 * - 반환값 : 없음
 */
function saveLayoutDraftToLocalPreset(
  dom: AppDom,
  session: Pick<LayoutDialogBindingSession, "getState">,
): void {
  try {
    const instrumentPresetId = getCurrentInstrumentPresetId(session);
    const draft = readLayoutDraftFromDialog(dom);
    const slotNumber = parseLocalLayoutPresetSlotNumber(dom.layoutPresetSelect.value);

    if (slotNumber === null) {
      setLayoutDialogNotice(dom, "Select a local layout preset slot first.", "warning");
      return;
    }

    const existingPreset = loadLayoutPresetSlotFromLocalStorage(instrumentPresetId, slotNumber) ?? undefined;

    if (
      existingPreset !== undefined
      && !window.confirm(`Overwrite Slot ${slotNumber}: ${existingPreset.layoutPresetDisplayName}?`)
    ) {
      setLayoutDialogNotice(dom, "Local layout preset save was cancelled.", "warning");
      return;
    }

    const presetResult = createUserLayoutPresetData(draft, instrumentPresetId, existingPreset);

    if (!presetResult.ok) {
      setLayoutDialogNotice(dom, presetResult.message, presetResult.level);
      return;
    }

    const jsonResult = serializeUserLayoutPresetData(presetResult.value);

    if (!jsonResult.ok) {
      setLayoutDialogNotice(dom, jsonResult.message, jsonResult.level);
      return;
    }

    const nextSlots = saveLayoutPresetSlotToLocalStorage(presetResult.value, slotNumber);

    activeLayoutDraft = draft;
    syncLayoutPresetSelect(dom, nextSlots, slotNumber);
    syncLayoutToolbarPresetSelect(dom, nextSlots, createSlotLayoutPresetId(slotNumber));
    setLayoutDialogNotice(dom, `Saved Slot ${slotNumber}: ${presetResult.value.layoutPresetDisplayName}.`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown local layout preset save error.";

    setLayoutDialogNotice(dom, message, "error");
  }
}

/**
 * 선택된 localStorage 레이아웃 프리셋을 draft로 불러온다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회 callback 묶음
 * - 반환값 : 없음
 */
function loadLayoutDraftFromLocalPreset(
  dom: AppDom,
  session: Pick<LayoutDialogBindingSession, "getState">,
): void {
  const slotNumber = parseLocalLayoutPresetSlotNumber(dom.layoutPresetSelect.value);

  if (slotNumber === null) {
    setLayoutDialogNotice(dom, "Select a local layout preset slot first.", "warning");
    return;
  }

  try {
    const instrumentPresetId = getCurrentInstrumentPresetId(session);
    const preset = loadLayoutPresetSlotFromLocalStorage(instrumentPresetId, slotNumber);

    if (preset === null) {
      setLayoutDialogNotice(dom, `Slot ${slotNumber} is empty.`, "warning");
      return;
    }

    activeLayoutDraft = createLayoutDraftFromPreset(preset, requireActiveLayoutDraft());
    syncLayoutDialogFromDraft(dom, activeLayoutDraft, `Loaded Slot ${slotNumber}: ${preset.layoutPresetDisplayName}.`);
    syncLayoutPresetSelect(
      dom,
      loadLayoutPresetSlotsForDialog(dom, instrumentPresetId),
      slotNumber,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown local layout preset load error.";

    setLayoutDialogNotice(dom, message, "error");
  }
}

/**
 * 현재 draft를 레이아웃 프리셋 JSON 파일로 다운로드한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회 callback 묶음
 * - 반환값 : 없음
 */
function saveLayoutDraftToPresetFile(
  dom: AppDom,
  session: Pick<LayoutDialogBindingSession, "getState">,
): void {
  const presetResult = createUserLayoutPresetData(
    readLayoutDraftFromDialog(dom),
    getCurrentInstrumentPresetId(session),
  );

  if (!presetResult.ok) {
    setLayoutDialogNotice(dom, presetResult.message, presetResult.level);
    return;
  }

  const jsonResult = serializeUserLayoutPresetData(presetResult.value);

  if (!jsonResult.ok) {
    setLayoutDialogNotice(dom, jsonResult.message, jsonResult.level);
    return;
  }

  downloadTextFile(
    createLayoutPresetFileName(presetResult.value),
    jsonResult.value,
    "application/json;charset=utf-8",
  );
  setLayoutDialogNotice(dom, `Downloaded layout preset: ${presetResult.value.layoutPresetDisplayName}.`);
}

/**
 * 레이아웃 프리셋 파일 내용을 draft로 불러온다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회 callback 묶음
 * - 인수 : file : 사용자가 선택한 JSON 파일
 * - 반환값 : 없음
 */
function loadLayoutDraftFromPresetFile(
  dom: AppDom,
  session: Pick<LayoutDialogBindingSession, "getState">,
  file: File,
): void {
  readTextFile(file)
    .then((jsonText) => {
      const presetResult = parseUserLayoutPresetJson(jsonText);

      if (!presetResult.ok) {
        setLayoutDialogNotice(dom, presetResult.message, presetResult.level);
        return;
      }

      const currentInstrumentPresetId = getCurrentInstrumentPresetId(session);

      if (
        presetResult.value.instrumentPresetId !== currentInstrumentPresetId
        && !window.confirm("This layout preset was made for a different instrument preset. Load it anyway?")
      ) {
        setLayoutDialogNotice(dom, "Layout preset file load was cancelled.", "warning");
        return;
      }

      activeLayoutDraft = createLayoutDraftFromPreset(
        presetResult.value,
        requireActiveLayoutDraft(),
      );
      syncLayoutDialogFromDraft(
        dom,
        activeLayoutDraft,
        `Loaded layout preset file: ${presetResult.value.layoutPresetDisplayName}.`,
      );
      syncLayoutPresetSelect(
        dom,
        loadLayoutPresetSlotsForDialog(dom, currentInstrumentPresetId),
      );
      syncLayoutToolbarPresetSelectForCurrentScore(dom, session);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown layout preset file load error.";

      setLayoutDialogNotice(dom, message, "error");
    })
    .finally(() => {
      dom.layoutFileLoadInput.value = "";
    });
}

/**
 * layout row 추가 입력을 읽어 draft에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : position : 선택 row 위/아래 삽입 위치
 * - 반환값 : 없음
 */
function addLayoutRowFromDialog(
  dom: AppDom,
  position: LayoutInsertPosition,
): void {
  const rowType = dom.layoutRowTypeSelect.value === "gap" ? "gap" : "note";

  applyLayoutDraftChange(
    dom,
    addLayoutDraftRow(requireActiveLayoutDraft(), {
      rowType,
      height: rowType === "note"
        ? Number(dom.layoutNoteHeightInput.value)
        : Number(dom.layoutRowHeightInput.value),
      position,
    }),
  );
}

/**
 * Add Row의 height 입력이 gap row 추가에만 쓰인다는 점을 UI 상태에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
function syncLayoutAddRowHeightState(dom: AppDom): void {
  const isGap = dom.layoutRowTypeSelect.value === "gap";

  dom.layoutRowHeightInput.disabled = !isGap;
}

/**
 * layout dialog와 layout preset toolbar event를 app 상태 변경 흐름에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
export function bindLayoutDialogControls(
  dom: AppDom,
  session: LayoutDialogBindingSession,
): void {
  dom.layoutModifyButton.addEventListener("click", () => {
    if (isGameModeLocked(session.getState().gameMode)) {
      return;
    }

    openLayoutDialog(dom, session);
  });
  dom.layoutPresetToolbarSelect.addEventListener("change", () => {
    applyLayoutToolbarPreset(dom, session);
  });

  dom.layoutCloseButton.addEventListener("click", () => {
    handleLayoutPreviewResizeEnd();
    dom.layoutDialog.close();
    activeLayoutDraft = null;
  });
  dom.layoutCancelButton.addEventListener("click", () => {
    handleLayoutPreviewResizeEnd();
    dom.layoutDialog.close();
    activeLayoutDraft = null;
  });
  dom.layoutForm.addEventListener("submit", (event) => {
    event.preventDefault();
    applyLayoutDialogDraft(dom, session);
  });
  dom.layoutStringSelect.addEventListener("change", () => {
    applyLayoutDraftChange(dom, {
      ok: true,
      draft: selectLayoutDraftString(requireActiveLayoutDraft(), dom.layoutStringSelect.value),
      message: `Selected string ${dom.layoutStringSelect.value}.`,
    });
  });
  dom.layoutNoteHeightInput.addEventListener("change", () => {
    applyLayoutDraftChange(
      dom,
      updateLayoutDraftCommonNoteHeight(
        requireActiveLayoutDraft(),
        Number(dom.layoutNoteHeightInput.value),
      ),
    );
  });
  dom.layoutResetButton.addEventListener("click", () => {
    const score = session.getState().document.score;

    handleLayoutPreviewResizeEnd();
    activeLayoutDraft = createLayoutDraftBundle(score);
    syncLayoutDialogFromDraft(dom, activeLayoutDraft, "Layout draft was reset to the current score.");
    syncLayoutPresetSelect(
      dom,
      loadLayoutPresetSlotsForDialog(dom, score.instData.presetId),
    );
  });
  dom.layoutNewPresetButton.addEventListener("click", () => {
    const instrumentPresetId = getCurrentInstrumentPresetId(session);
    const slots = loadLayoutPresetSlotsForDialog(dom, instrumentPresetId);
    const emptySlot = slots.find((slot) => slot.preset === null);

    if (emptySlot === undefined) {
      setLayoutDialogNotice(dom, "All local layout preset slots are full. Select a slot to overwrite or use File Save.", "warning");
      return;
    }

    syncLayoutPresetSelect(dom, slots, emptySlot.slotNumber);
    dom.layoutPresetNameInput.value = `Slot ${emptySlot.slotNumber} layout`;
    setLayoutDialogNotice(dom, `Slot ${emptySlot.slotNumber} is ready. Use Local Save to store it.`);
  });
  dom.layoutAddRowBelowButton.addEventListener("click", () => {
    addLayoutRowFromDialog(dom, "below");
  });
  dom.layoutAddRowAboveButton.addEventListener("click", () => {
    addLayoutRowFromDialog(dom, "above");
  });
  dom.layoutRowTypeSelect.addEventListener("change", () => {
    syncLayoutAddRowHeightState(dom);
  });
  dom.layoutLocalSaveButton.addEventListener("click", () => {
    saveLayoutDraftToLocalPreset(dom, session);
  });
  dom.layoutLocalLoadButton.addEventListener("click", () => {
    loadLayoutDraftFromLocalPreset(dom, session);
  });
  dom.layoutFileSaveButton.addEventListener("click", () => {
    saveLayoutDraftToPresetFile(dom, session);
  });
  dom.layoutFileLoadButton.addEventListener("click", () => {
    dom.layoutFileLoadInput.click();
  });
  dom.layoutFileLoadInput.addEventListener("change", () => {
    const file = dom.layoutFileLoadInput.files?.item(0);

    if (file === null || file === undefined) {
      return;
    }

    loadLayoutDraftFromPresetFile(dom, session, file);
  });
}
