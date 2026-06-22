/**
 * 레이아웃 편집 팝업에서 사용하는 draft bundle 생성과 row 조작을 담당한다.
 */

import type {
  GapRowDefinition,
  InstrumentData,
  NoteRowDefinition,
  RowId,
  ScoreFile,
  StringId,
} from "../../core/score/types";
import { formatPitchName } from "../pitch_label";
import type {
  LayoutDraftBundle,
  LayoutEditableRowDefinition,
} from "./layout_types";

const MIN_ROW_HEIGHT = 1;
const MAX_ROW_HEIGHT = 500;
const MIN_GAP_BOUNDARY_MIDI = -1;
const MAX_GAP_BOUNDARY_MIDI = 128;

/** layout row 삽입 위치. */
export type LayoutInsertPosition = "above" | "below";

/** layout draft row 추가 입력. */
export type LayoutAddRowInput = {
  rowType: "note" | "gap";
  height: number;
  midi?: number;
  position: LayoutInsertPosition;
};

/** layout draft 변경 결과. */
export type LayoutDraftMutationResult =
  | {
      ok: true;
      draft: LayoutDraftBundle;
      message: string;
    }
  | {
      ok: false;
      level: "warning" | "error";
      message: string;
    };

/**
 * 현재 ScoreFile에서 layout dialog용 draft bundle을 만든다.
 * - 인수 : score : 현재 앱이 보유한 ScoreFile
 * - 반환값 : 악기 정보와 비전역 rowDefinitions를 복사한 LayoutDraftBundle
 */
export function createLayoutDraftBundle(score: ScoreFile): LayoutDraftBundle {
  const rowDefinitions = score.layout.rowDefinitions
    .filter(isEditableLayoutRow)
    .map(cloneEditableRow);
  const selectedStringId = score.instData.strings[0]?.stringId ?? null;
  const selectedRowId = findFirstRowIdForString(rowDefinitions, selectedStringId);

  return {
    layoutPresetDisplayName: score.instData.instName,
    instData: cloneInstrumentData(score.instData),
    rowDefinitions,
    selectedStringId,
    selectedRowId,
  };
}

/**
 * layout draft의 선택 string을 바꾼다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : stringId : 새로 선택할 stringId
 * - 반환값 : 선택 string과 선택 row가 갱신된 draft
 */
export function selectLayoutDraftString(
  draft: LayoutDraftBundle,
  stringId: StringId,
): LayoutDraftBundle {
  const selectedRowId = findFirstRowIdForString(draft.rowDefinitions, stringId);

  return {
    ...draft,
    selectedStringId: stringId,
    selectedRowId,
  };
}

/**
 * layout draft의 선택 row를 바꾼다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : rowId : 새로 선택할 rowId
 * - 반환값 : 선택 row가 갱신된 draft
 */
export function selectLayoutDraftRow(
  draft: LayoutDraftBundle,
  rowId: RowId,
): LayoutDraftBundle {
  return {
    ...draft,
    selectedRowId: rowId,
  };
}

/**
 * 선택 string에 속한 note/gap row만 표시 순서대로 반환한다.
 * - 인수 : draft : 현재 layout draft
 * - 반환값 : 선택 string에 속한 편집 가능 row 목록
 */
export function getRowsForSelectedString(
  draft: LayoutDraftBundle,
): LayoutEditableRowDefinition[] {
  if (draft.selectedStringId === null) {
    return [];
  }

  return draft.rowDefinitions.filter((row) => row.stringId === draft.selectedStringId);
}

/**
 * layout draft row 높이를 변경한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : rowId : 높이를 바꿀 rowId
 * - 인수 : height : 새 row height px
 * - 반환값 : 변경된 draft 또는 오류 메시지
 */
export function updateLayoutDraftRowHeight(
  draft: LayoutDraftBundle,
  rowId: RowId,
  height: number,
): LayoutDraftMutationResult {
  const heightError = validateRowHeight(height);

  if (heightError !== null) {
    return heightError;
  }

  let didUpdate = false;
  const rowDefinitions = draft.rowDefinitions.map((row) => {
    if (row.rowId !== rowId) {
      return row;
    }

    didUpdate = true;
    return {
      ...row,
      height,
    };
  });

  if (!didUpdate) {
    return {
      ok: false,
      level: "warning",
      message: `Cannot find row ${rowId}.`,
    };
  }

  return {
    ok: true,
    draft: {
      ...draft,
      rowDefinitions,
      selectedRowId: rowId,
    },
    message: `Updated ${rowId} height.`,
  };
}

/**
 * layout draft의 공통 note row height를 반환한다.
 * - 인수 : draft : 현재 layout draft
 * - 반환값 : 첫 note row height 또는 기본값
 */
export function getLayoutDraftCommonNoteHeight(
  draft: LayoutDraftBundle,
): number {
  return draft.rowDefinitions.find((row) => row.type === "note")?.height ?? 7;
}

/**
 * layout draft의 모든 note row 높이를 같은 값으로 변경한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : height : 모든 note row에 적용할 height px
 * - 반환값 : 변경된 draft 또는 오류 메시지
 */
export function updateLayoutDraftCommonNoteHeight(
  draft: LayoutDraftBundle,
  height: number,
): LayoutDraftMutationResult {
  const heightError = validateRowHeight(height);

  if (heightError !== null) {
    return heightError;
  }

  let didUpdate = false;
  const rowDefinitions = draft.rowDefinitions.map((row) => {
    if (row.type !== "note") {
      return row;
    }

    didUpdate = true;
    return {
      ...row,
      height,
    };
  });

  if (!didUpdate) {
    return {
      ok: false,
      level: "warning",
      message: "There are no note rows to resize.",
    };
  }

  return {
    ok: true,
    draft: {
      ...draft,
      rowDefinitions,
    },
    message: `Updated all note rows to ${height}px.`,
  };
}

/**
 * layout draft에 note 또는 gap row를 추가한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : input : 추가할 row 종류, 높이, pitch, 삽입 위치
 * - 반환값 : 변경된 draft 또는 오류 메시지
 */
export function addLayoutDraftRow(
  draft: LayoutDraftBundle,
  input: LayoutAddRowInput,
): LayoutDraftMutationResult {
  const heightError = validateRowHeight(input.height);

  if (heightError !== null) {
    return heightError;
  }

  if (draft.selectedStringId === null) {
    return {
      ok: false,
      level: "warning",
      message: "Select a string before adding a row.",
    };
  }

  if (input.rowType === "note") {
    return addNoteRow(draft, input);
  }

  return addGapRow(draft, input);
}

/**
 * layout draft에서 row를 삭제한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : rowId : 삭제할 rowId
 * - 반환값 : 변경된 draft 또는 오류 메시지
 */
export function deleteLayoutDraftRow(
  draft: LayoutDraftBundle,
  rowId: RowId,
): LayoutDraftMutationResult {
  const target = draft.rowDefinitions.find((row) => row.rowId === rowId);

  if (target === undefined) {
    return {
      ok: false,
      level: "warning",
      message: `Cannot find row ${rowId}.`,
    };
  }

  if (target.type === "note") {
    const deleteCheck = validateNoteRowDeletion(draft, target);

    if (deleteCheck !== null) {
      return deleteCheck;
    }
  }

  const rowDefinitions = draft.rowDefinitions.filter((row) => row.rowId !== rowId);
  const selectedRowId = findFirstRowIdForString(rowDefinitions, draft.selectedStringId);

  return {
    ok: true,
    draft: {
      ...draft,
      rowDefinitions,
      selectedRowId,
    },
    message: `Deleted draft row ${target.rowId}. Score cells are not changed until Apply is implemented.`,
  };
}

/**
 * note row 삭제가 선택 string의 양끝 삭제 정책에 맞는지 검사한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : target : 삭제 대상 note row
 * - 반환값 : 삭제 불가 오류 또는 null
 */
function validateNoteRowDeletion(
  draft: LayoutDraftBundle,
  target: NoteRowDefinition,
): Extract<LayoutDraftMutationResult, { ok: false }> | null {
  const noteRows = draft.rowDefinitions.filter(
    (row): row is NoteRowDefinition => row.type === "note" && row.stringId === target.stringId,
  );

  if (noteRows.length <= 1) {
    return {
      ok: false,
      level: "warning",
      message: "At least one note row must remain.",
    };
  }

  const firstRow = noteRows[0];
  const lastRow = noteRows[noteRows.length - 1];

  if (target.rowId !== firstRow?.rowId && target.rowId !== lastRow?.rowId) {
    return {
      ok: false,
      level: "warning",
      message: "Only the top or bottom note row can be deleted.",
    };
  }

  return null;
}

/**
 * rowDefinition이 layout dialog에서 편집 가능한 note/gap row인지 확인한다.
 * - 인수 : row : ScoreFile layout rowDefinition
 * - 반환값 : note/gap row 여부
 */
function isEditableLayoutRow(
  row: ScoreFile["layout"]["rowDefinitions"][number],
): row is LayoutEditableRowDefinition {
  return row.type === "note" || row.type === "gap";
}

/**
 * 악기 정보를 draft용으로 깊은 복사한다.
 * - 인수 : instData : ScoreFile.instData
 * - 반환값 : dialog draft에서 수정할 수 있는 InstrumentData 복사본
 */
function cloneInstrumentData(instData: InstrumentData): InstrumentData {
  return {
    ...instData,
    strings: instData.strings.map((stringInfo) => ({
      ...stringInfo,
    })),
  };
}

/**
 * note/gap row를 draft용으로 복사한다.
 * - 인수 : row : 복사할 note/gap row
 * - 반환값 : 새 객체로 복사된 rowDefinition
 */
function cloneEditableRow(
  row: LayoutEditableRowDefinition,
): LayoutEditableRowDefinition {
  return {
    ...row,
  };
}

/**
 * 특정 string의 첫 rowId를 찾는다.
 * - 인수 : rows : draft row 목록
 * - 인수 : stringId : 선택된 stringId
 * - 반환값 : 첫 rowId 또는 null
 */
function findFirstRowIdForString(
  rows: LayoutEditableRowDefinition[],
  stringId: StringId | null,
): RowId | null {
  if (stringId === null) {
    return null;
  }

  return rows.find((row) => row.stringId === stringId)?.rowId ?? null;
}

/**
 * row height 입력값이 draft 허용 범위인지 확인한다.
 * - 인수 : height : 검사할 row height px
 * - 반환값 : 오류 결과 또는 null
 */
function validateRowHeight(height: number): Extract<LayoutDraftMutationResult, { ok: false }> | null {
  if (!Number.isInteger(height) || height < MIN_ROW_HEIGHT || height > MAX_ROW_HEIGHT) {
    return {
      ok: false,
      level: "warning",
      message: `Height must be an integer from ${MIN_ROW_HEIGHT} to ${MAX_ROW_HEIGHT}.`,
    };
  }

  return null;
}

/**
 * note row를 draft에 추가한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : input : note row 추가 입력
 * - 반환값 : 변경된 draft 또는 오류 메시지
 */
function addNoteRow(
  draft: LayoutDraftBundle,
  input: LayoutAddRowInput,
): LayoutDraftMutationResult {
  const stringId = draft.selectedStringId;

  if (stringId === null) {
    return {
      ok: false,
      level: "warning",
      message: "Select a string before adding a note row.",
    };
  }

  const midi = input.midi ?? resolveAutoNoteMidi(draft, input.position);

  if (midi === null) {
    return {
      ok: false,
      level: "warning",
      message: "Select a note or gap row before adding an automatic note row.",
    };
  }

  if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
    return {
      ok: false,
      level: "warning",
      message: "Pitch must be a MIDI note from 0 to 127.",
    };
  }

  const stringInfo = draft.instData.strings.find((string) => string.stringId === stringId);

  if (stringInfo === undefined) {
    return {
      ok: false,
      level: "warning",
      message: `Cannot find string ${stringId}.`,
    };
  }

  if (midi < stringInfo.minMidi || midi > stringInfo.maxMidi) {
    return {
      ok: false,
      level: "warning",
      message: `${formatPitchName(midi, "sharp")} is outside ${stringId} range ${formatPitchName(stringInfo.minMidi, "sharp")}..${formatPitchName(stringInfo.maxMidi, "sharp")}.`,
    };
  }

  if (draft.rowDefinitions.some((row) => row.type === "note" && row.stringId === stringId && row.midi === midi)) {
    return {
      ok: false,
      level: "warning",
      message: `${formatPitchName(midi, "sharp")} already exists in ${stringId}.`,
    };
  }

  const row = createNoteRow(stringId, midi, input.height);

  return insertDraftRow(draft, row, input.position, `Added note row ${row.displayLabel}.`);
}

/**
 * 선택 row와 삽입 방향을 기준으로 새 note row MIDI를 자동 계산한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : position : 선택 row 위/아래 삽입 위치
 * - 반환값 : 자동 계산된 MIDI 또는 계산 불가 결과
 */
function resolveAutoNoteMidi(
  draft: LayoutDraftBundle,
  position: LayoutInsertPosition,
): number | null {
  if (draft.selectedStringId === null) {
    return null;
  }

  const insertIndex = resolveInsertIndex(draft, position);
  const baseNote = position === "above"
    ? findNearestNoteRow(draft.rowDefinitions, draft.selectedStringId, insertIndex, 1)
      ?? findNearestNoteRow(draft.rowDefinitions, draft.selectedStringId, insertIndex - 1, -1)
    : findNearestNoteRow(draft.rowDefinitions, draft.selectedStringId, insertIndex - 1, -1)
      ?? findNearestNoteRow(draft.rowDefinitions, draft.selectedStringId, insertIndex, 1);

  if (baseNote === null) {
    return null;
  }

  return position === "above" ? baseNote.midi + 1 : baseNote.midi - 1;
}

/**
 * gap row를 draft에 추가한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : input : gap row 추가 입력
 * - 반환값 : 변경된 draft 또는 오류 메시지
 */
function addGapRow(
  draft: LayoutDraftBundle,
  input: LayoutAddRowInput,
): LayoutDraftMutationResult {
  const stringId = draft.selectedStringId;

  if (stringId === null) {
    return {
      ok: false,
      level: "warning",
      message: "Select a string before adding a gap row.",
    };
  }

  const insertIndex = resolveInsertIndex(draft, input.position);
  const neighborError = validateNoAdjacentGapRows(draft, stringId, insertIndex);

  if (neighborError !== null) {
    return neighborError;
  }

  const upperNote = findNearestNoteRow(draft.rowDefinitions, stringId, insertIndex - 1, -1);
  const lowerNote = findNearestNoteRow(draft.rowDefinitions, stringId, insertIndex, 1);
  const gapBoundary = resolveGapBoundaryMidi(upperNote, lowerNote);

  if (gapBoundary === null) {
    return {
      ok: false,
      level: "warning",
      message: "Gap rows need at least one neighboring note row.",
    };
  }

  const { fromMidi, toMidi } = gapBoundary;
  const boundaryError = validateGapBoundaryMidi(fromMidi, toMidi);

  if (boundaryError !== null) {
    return boundaryError;
  }

  if (draft.rowDefinitions.some((row) => row.type === "gap" && row.stringId === stringId && row.fromMidi === fromMidi && row.toMidi === toMidi)) {
    return {
      ok: false,
      level: "warning",
      message: `Gap ${fromMidi}-${toMidi} already exists.`,
    };
  }

  const row = createGapRow(stringId, fromMidi, toMidi, input.height);

  return insertDraftRow(draft, row, input.position, `Added gap row ${row.rowId}.`);
}

/**
 * 삽입 위치 바로 위/아래에 gap row가 있는지 확인한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : stringId : 선택 stringId
 * - 인수 : insertIndex : rowDefinitions 삽입 index
 * - 반환값 : 연속 gap 오류 또는 null
 */
function validateNoAdjacentGapRows(
  draft: LayoutDraftBundle,
  stringId: StringId,
  insertIndex: number,
): Extract<LayoutDraftMutationResult, { ok: false }> | null {
  const previousRow = draft.rowDefinitions[insertIndex - 1];
  const nextRow = draft.rowDefinitions[insertIndex];
  const hasAdjacentGap = [previousRow, nextRow].some(
    (row) => row?.type === "gap" && row.stringId === stringId,
  );

  if (!hasAdjacentGap) {
    return null;
  }

  return {
    ok: false,
    level: "warning",
    message: "Gap rows cannot be adjacent.",
  };
}

/**
 * 인접 note row에서 gap row의 boundary MIDI 값을 계산한다.
 * - 인수 : upperNote : 삽입 위치 위쪽에서 찾은 note row
 * - 인수 : lowerNote : 삽입 위치 아래쪽에서 찾은 note row
 * - 반환값 : gap row fromMidi/toMidi 또는 계산 불가 결과
 */
function resolveGapBoundaryMidi(
  upperNote: NoteRowDefinition | null,
  lowerNote: NoteRowDefinition | null,
): { fromMidi: number; toMidi: number } | null {
  if (upperNote !== null && lowerNote !== null) {
    return {
      fromMidi: Math.min(upperNote.midi, lowerNote.midi),
      toMidi: Math.max(upperNote.midi, lowerNote.midi),
    };
  }

  if (upperNote !== null) {
    return {
      fromMidi: upperNote.midi - 1,
      toMidi: upperNote.midi,
    };
  }

  if (lowerNote !== null) {
    return {
      fromMidi: lowerNote.midi,
      toMidi: lowerNote.midi + 1,
    };
  }

  return null;
}

/**
 * gap row boundary MIDI가 layout gap 허용 범위인지 검사한다.
 * - 인수 : fromMidi : gap row 낮은 boundary MIDI
 * - 인수 : toMidi : gap row 높은 boundary MIDI
 * - 반환값 : 범위 오류 또는 null
 */
function validateGapBoundaryMidi(
  fromMidi: number,
  toMidi: number,
): Extract<LayoutDraftMutationResult, { ok: false }> | null {
  if (
    fromMidi < MIN_GAP_BOUNDARY_MIDI ||
    toMidi > MAX_GAP_BOUNDARY_MIDI
  ) {
    return {
      ok: false,
      level: "warning",
      message: `Gap boundary MIDI must be from ${MIN_GAP_BOUNDARY_MIDI} to ${MAX_GAP_BOUNDARY_MIDI}.`,
    };
  }

  return null;
}

/**
 * note row 저장 객체를 만든다.
 * - 인수 : stringId : row가 속한 stringId
 * - 인수 : midi : note row MIDI
 * - 인수 : height : row height px
 * - 반환값 : NoteRowDefinition
 */
function createNoteRow(
  stringId: StringId,
  midi: number,
  height: number,
): NoteRowDefinition {
  return {
    rowId: `${stringId}-note-${midi}`,
    type: "note",
    stringId,
    midi,
    height,
    displayLabel: formatPitchName(midi, "sharp"),
  };
}

/**
 * gap row 저장 객체를 만든다.
 * - 인수 : stringId : row가 속한 stringId
 * - 인수 : fromMidi : 인접 note 중 낮은 MIDI
 * - 인수 : toMidi : 인접 note 중 높은 MIDI
 * - 인수 : height : row height px
 * - 반환값 : GapRowDefinition
 */
function createGapRow(
  stringId: StringId,
  fromMidi: number,
  toMidi: number,
  height: number,
): GapRowDefinition {
  return {
    rowId: `${stringId}-gap-${fromMidi}-${toMidi}`,
    type: "gap",
    stringId,
    fromMidi,
    toMidi,
    height,
  };
}

/**
 * 새 draft row를 선택 위치 기준으로 삽입한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : row : 삽입할 note/gap row
 * - 인수 : position : 선택 row 위/아래 삽입 위치
 * - 인수 : message : 성공 메시지
 * - 반환값 : 변경된 draft
 */
function insertDraftRow(
  draft: LayoutDraftBundle,
  row: LayoutEditableRowDefinition,
  position: LayoutInsertPosition,
  message: string,
): LayoutDraftMutationResult {
  const insertIndex = resolveInsertIndex(draft, position);
  const rowDefinitions = [
    ...draft.rowDefinitions.slice(0, insertIndex),
    row,
    ...draft.rowDefinitions.slice(insertIndex),
  ];

  return {
    ok: true,
    draft: {
      ...draft,
      rowDefinitions,
      selectedRowId: row.rowId,
    },
    message,
  };
}

/**
 * 현재 선택 row와 삽입 방향으로 rowDefinitions 삽입 index를 계산한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : position : 선택 row 위/아래 삽입 위치
 * - 반환값 : rowDefinitions 배열 삽입 index
 */
function resolveInsertIndex(
  draft: LayoutDraftBundle,
  position: LayoutInsertPosition,
): number {
  const selectedIndex = draft.selectedRowId === null
    ? -1
    : draft.rowDefinitions.findIndex((row) => row.rowId === draft.selectedRowId);

  if (selectedIndex >= 0) {
    return position === "above" ? selectedIndex : selectedIndex + 1;
  }

  if (draft.selectedStringId === null) {
    return draft.rowDefinitions.length;
  }

  // 선택 row가 없으면 선택 string의 마지막 row 아래에 추가한다.
  for (let index = draft.rowDefinitions.length - 1; index >= 0; index -= 1) {
    if (draft.rowDefinitions[index]?.stringId === draft.selectedStringId) {
      return index + 1;
    }
  }

  return draft.rowDefinitions.length;
}

/**
 * 삽입 위치 주변의 가장 가까운 note row를 찾는다.
 * - 인수 : rows : draft row 목록
 * - 인수 : stringId : 선택 stringId
 * - 인수 : startIndex : 검색 시작 index
 * - 인수 : step : 위쪽 검색은 -1, 아래쪽 검색은 1
 * - 반환값 : 가장 가까운 note row 또는 null
 */
function findNearestNoteRow(
  rows: LayoutEditableRowDefinition[],
  stringId: StringId,
  startIndex: number,
  step: -1 | 1,
): NoteRowDefinition | null {
  for (let index = startIndex; index >= 0 && index < rows.length; index += step) {
    const row = rows[index];

    if (row?.stringId !== stringId) {
      continue;
    }

    if (row.type === "note") {
      return row;
    }
  }

  return null;
}
