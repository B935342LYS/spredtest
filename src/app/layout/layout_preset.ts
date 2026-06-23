/**
 * 레이아웃 프리셋 JSON 생성, 검증, draft 복원을 담당한다.
 */

import type {
  InstrumentData,
  RowId,
  StringId,
} from "../../core/score/types";
import {
  formatByteSize,
  getUtf8ByteLength,
  MAX_ROW_HEIGHT,
} from "../../core/score/score_limits";
import type {
  LayoutDraftBundle,
  LayoutEditableRowDefinition,
  UserLayoutPresetData,
} from "./layout_types";

/** 레이아웃 프리셋 표시명 최대 글자 수. */
export const MAX_LAYOUT_PRESET_NAME_LENGTH = 30;

/** 레이아웃 프리셋 JSON 저장/불러오기 최대 UTF-8 byte 수. */
export const MAX_LAYOUT_PRESET_JSON_BYTES = 256 * 1024;

/** 레이아웃 프리셋 처리 결과. */
export type LayoutPresetResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      level: "warning" | "error";
      message: string;
    };

/**
 * draft를 저장 가능한 레이아웃 프리셋 데이터로 변환한다.
 * - 인수 : draft : 현재 layout draft
 * - 인수 : instrumentPresetId : 현재 score의 악기 프리셋 ID
 * - 인수 : existingPreset : 기존 프리셋을 덮어쓸 때 유지할 metadata
 * - 반환값 : localStorage와 파일 저장에 공통으로 사용할 프리셋 데이터
 */
export function createUserLayoutPresetData(
  draft: LayoutDraftBundle,
  instrumentPresetId: string,
  existingPreset?: UserLayoutPresetData,
): LayoutPresetResult<UserLayoutPresetData> {
  const displayName = draft.layoutPresetDisplayName.trim();

  if (displayName.length === 0) {
    return {
      ok: false,
      level: "warning",
      message: "Layout preset name is required.",
    };
  }

  if (countTextCharacters(displayName) > MAX_LAYOUT_PRESET_NAME_LENGTH) {
    return {
      ok: false,
      level: "warning",
      message: `Layout preset name must be ${MAX_LAYOUT_PRESET_NAME_LENGTH} characters or fewer.`,
    };
  }

  const now = new Date().toISOString();

  return {
    ok: true,
    value: {
      formatVersion: "1",
      layoutPresetId: existingPreset?.layoutPresetId ?? createLayoutPresetId(now),
      layoutPresetDisplayName: displayName,
      instrumentPresetId,
      createdAt: existingPreset?.createdAt ?? now,
      updatedAt: now,
      instData: cloneInstrumentData({
        ...draft.instData,
        instName: displayName,
      }),
      rowDefinitions: cloneEditableRows(draft.rowDefinitions),
    },
  };
}

/**
 * 프리셋 JSON 문자열을 파싱하고 저장 포맷을 검증한다.
 * - 인수 : jsonText : 파일 또는 localStorage에서 읽은 JSON 문자열
 * - 반환값 : 검증된 레이아웃 프리셋 데이터
 */
export function parseUserLayoutPresetJson(
  jsonText: string,
): LayoutPresetResult<UserLayoutPresetData> {
  let parsed: unknown;

  if (getUtf8ByteLength(jsonText) > MAX_LAYOUT_PRESET_JSON_BYTES) {
    return invalidPreset(
      `Layout preset JSON must be ${formatByteSize(MAX_LAYOUT_PRESET_JSON_BYTES)} or smaller.`,
    );
  }

  try {
    parsed = JSON.parse(jsonText);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON.";

    return {
      ok: false,
      level: "error",
      message,
    };
  }

  return validateUserLayoutPresetData(parsed);
}

/**
 * 레이아웃 프리셋 데이터를 저장용 JSON 문자열로 직렬화하고 용량을 검증한다.
 * - 인수 : preset : 저장할 레이아웃 프리셋 데이터
 * - 반환값 : pretty-print된 JSON 문자열 또는 용량 오류
 */
export function serializeUserLayoutPresetData(
  preset: UserLayoutPresetData,
): LayoutPresetResult<string> {
  const jsonText = `${JSON.stringify(preset, null, 2)}\n`;

  if (getUtf8ByteLength(jsonText) > MAX_LAYOUT_PRESET_JSON_BYTES) {
    return invalidPreset(
      `Layout preset JSON must be ${formatByteSize(MAX_LAYOUT_PRESET_JSON_BYTES)} or smaller.`,
    );
  }

  return {
    ok: true,
    value: jsonText,
  };
}

/**
 * unknown 값을 UserLayoutPresetData로 사용할 수 있는지 확인한다.
 * - 인수 : value : 검증할 JSON 파싱 결과
 * - 반환값 : 검증된 프리셋 데이터 또는 오류 메시지
 */
function validateUserLayoutPresetData(
  value: unknown,
): LayoutPresetResult<UserLayoutPresetData> {
  if (!isRecord(value)) {
    return invalidPreset("Layout preset root must be an object.");
  }

  if (value.formatVersion !== "1") {
    return invalidPreset("Unsupported layout preset formatVersion.");
  }

  const stringFields = [
    "layoutPresetId",
    "layoutPresetDisplayName",
    "instrumentPresetId",
    "createdAt",
    "updatedAt",
  ] as const;

  for (const field of stringFields) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      return invalidPreset(`Layout preset field is required: ${field}.`);
    }
  }

  const layoutPresetId = String(value.layoutPresetId);
  const layoutPresetDisplayName = String(value.layoutPresetDisplayName);
  const instrumentPresetId = String(value.instrumentPresetId);
  const createdAt = String(value.createdAt);
  const updatedAt = String(value.updatedAt);

  if (countTextCharacters(layoutPresetDisplayName) > MAX_LAYOUT_PRESET_NAME_LENGTH) {
    return invalidPreset(`Layout preset name must be ${MAX_LAYOUT_PRESET_NAME_LENGTH} characters or fewer.`);
  }

  const instDataResult = validateInstrumentData(value.instData);

  if (!instDataResult.ok) {
    return instDataResult;
  }

  if (!Array.isArray(value.rowDefinitions)) {
    return invalidPreset("Layout preset rowDefinitions must be an array.");
  }

  const rowsResult = validatePresetRows(value.rowDefinitions, instDataResult.value);

  if (!rowsResult.ok) {
    return rowsResult;
  }

  return {
    ok: true,
    value: {
      formatVersion: "1",
      layoutPresetId,
      layoutPresetDisplayName,
      instrumentPresetId,
      createdAt,
      updatedAt,
      instData: instDataResult.value,
      rowDefinitions: rowsResult.value,
    },
  };
}

/**
 * 검증된 프리셋 데이터를 layout draft로 복원한다.
 * - 인수 : preset : 검증된 프리셋 데이터
 * - 인수 : currentDraft : 현재 선택 상태를 참고할 draft
 * - 반환값 : 프리셋 내용이 반영된 draft
 */
export function createLayoutDraftFromPreset(
  preset: UserLayoutPresetData,
  currentDraft: LayoutDraftBundle,
): LayoutDraftBundle {
  const rowDefinitions = cloneEditableRows(
    preset.rowDefinitions.filter(isEditableRowDefinition),
  );
  const firstStringId = preset.instData.strings[0]?.stringId ?? currentDraft.selectedStringId;
  const selectedStringId = currentDraft.selectedStringId !== null
    && preset.instData.strings.some((string) => string.stringId === currentDraft.selectedStringId)
    ? currentDraft.selectedStringId
    : firstStringId;
  const selectedRowId = rowDefinitions.find(
    (row) => row.stringId === selectedStringId,
  )?.rowId ?? null;

  return {
    layoutPresetDisplayName: preset.layoutPresetDisplayName,
    instData: cloneInstrumentData(preset.instData),
    rowDefinitions,
    selectedStringId,
    selectedRowId,
  };
}

/**
 * layout preset 다운로드 파일명을 만든다.
 * - 인수 : preset : 저장할 레이아웃 프리셋 데이터
 * - 반환값 : 다운로드 파일명
 */
export function createLayoutPresetFileName(preset: UserLayoutPresetData): string {
  const safeDisplayName = sanitizeFileNamePart(preset.layoutPresetDisplayName);

  return `layout-${safeDisplayName}.json`;
}

/**
 * 프리셋 ID를 생성한다.
 * - 인수 : isoText : 생성 기준 시각 ISO 문자열
 * - 반환값 : local/file 공통으로 사용할 프리셋 ID
 */
function createLayoutPresetId(isoText: string): string {
  return `layout-${isoText.replace(/[^0-9]/g, "").slice(0, 17)}`;
}

/**
 * 악기 정보를 검증하고 복사한다.
 * - 인수 : value : 검증할 instData 후보
 * - 반환값 : 검증된 악기 정보
 */
function validateInstrumentData(value: unknown): LayoutPresetResult<InstrumentData> {
  if (!isRecord(value)) {
    return invalidPreset("Layout preset instData must be an object.");
  }

  if (typeof value.presetId !== "string" || value.presetId.trim().length === 0) {
    return invalidPreset("Layout preset instData.presetId is required.");
  }

  if (typeof value.family !== "string" || value.family.trim().length === 0) {
    return invalidPreset("Layout preset instData.family is required.");
  }

  if (typeof value.instName !== "string" || value.instName.trim().length === 0) {
    return invalidPreset("Layout preset instData.instName is required.");
  }

  if (countTextCharacters(value.instName.trim()) > MAX_LAYOUT_PRESET_NAME_LENGTH) {
    return invalidPreset(`Layout preset instData.instName must be ${MAX_LAYOUT_PRESET_NAME_LENGTH} characters or fewer.`);
  }

  if (typeof value.supportsOpen !== "boolean") {
    return invalidPreset("Layout preset instData.supportsOpen must be a boolean.");
  }

  if (!Array.isArray(value.strings) || value.strings.length === 0) {
    return invalidPreset("Layout preset instData.strings must not be empty.");
  }

  const stringIds = new Set<StringId>();
  const strings: InstrumentData["strings"] = [];

  for (const [index, stringInfo] of value.strings.entries()) {
    if (!isRecord(stringInfo)) {
      return invalidPreset(`Layout preset string must be an object: ${index}.`);
    }

    if (typeof stringInfo.stringId !== "string" || stringInfo.stringId.trim().length === 0) {
      return invalidPreset(`Layout preset stringId is required: ${index}.`);
    }

    if (stringIds.has(stringInfo.stringId)) {
      return invalidPreset(`Duplicate layout preset stringId: ${stringInfo.stringId}.`);
    }

    if (typeof stringInfo.stringName !== "string" || stringInfo.stringName.trim().length === 0) {
      return invalidPreset(`Layout preset stringName is required: ${stringInfo.stringId}.`);
    }

    if (!isMidiNumber(stringInfo.minMidi) || !isMidiNumber(stringInfo.maxMidi)) {
      return invalidPreset(`Layout preset string MIDI range is invalid: ${stringInfo.stringId}.`);
    }

    if (stringInfo.minMidi > stringInfo.maxMidi) {
      return invalidPreset(`Layout preset string minMidi must be <= maxMidi: ${stringInfo.stringId}.`);
    }

    if (stringInfo.openMidi !== undefined && !isMidiNumber(stringInfo.openMidi)) {
      return invalidPreset(`Layout preset openMidi is invalid: ${stringInfo.stringId}.`);
    }

    stringIds.add(stringInfo.stringId);
    strings.push({
      stringId: stringInfo.stringId,
      stringName: stringInfo.stringName,
      minMidi: stringInfo.minMidi,
      maxMidi: stringInfo.maxMidi,
      ...(stringInfo.openMidi === undefined ? {} : { openMidi: stringInfo.openMidi }),
    });
  }

  return {
    ok: true,
    value: {
      presetId: value.presetId,
      family: value.family,
      instName: value.instName,
      supportsOpen: value.supportsOpen,
      strings,
    },
  };
}

/**
 * 프리셋 rowDefinitions를 검증하고 복사한다.
 * - 인수 : rows : 검증할 rowDefinitions 후보
 * - 인수 : instData : row stringId와 MIDI 범위 검증 기준
 * - 반환값 : 검증된 note/gap rowDefinitions
 */
function validatePresetRows(
  rows: unknown[],
  instData: InstrumentData,
): LayoutPresetResult<LayoutEditableRowDefinition[]> {
  const rowIds = new Set<RowId>();
  const noteKeys = new Set<string>();
  const stringById = new Map(instData.strings.map((string) => [string.stringId, string]));
  const editableRows: LayoutEditableRowDefinition[] = [];

  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) {
      return invalidPreset(`Layout preset row must be an object: ${index}.`);
    }

    if (row.type !== "note" && row.type !== "gap") {
      return invalidPreset(`Layout preset row type must be note or gap: ${index}.`);
    }

    if (typeof row.rowId !== "string" || row.rowId.trim().length === 0) {
      return invalidPreset(`Layout preset rowId is required: ${index}.`);
    }

    if (rowIds.has(row.rowId)) {
      return invalidPreset(`Duplicate layout preset rowId: ${row.rowId}.`);
    }

    if (typeof row.stringId !== "string" || !stringById.has(row.stringId)) {
      return invalidPreset(`Layout preset row stringId is unknown: ${row.rowId}.`);
    }

    if (!isRowHeight(row.height)) {
      return invalidPreset(`Layout preset row height must be an integer from 1 to ${MAX_ROW_HEIGHT}: ${row.rowId}.`);
    }

    rowIds.add(row.rowId);

    if (row.type === "note") {
      if (!isMidiNumber(row.midi)) {
        return invalidPreset(`Layout preset note MIDI is invalid: ${row.rowId}.`);
      }

      const stringInfo = stringById.get(row.stringId);

      if (stringInfo === undefined || row.midi < stringInfo.minMidi || row.midi > stringInfo.maxMidi) {
        return invalidPreset(`Layout preset note MIDI is outside string range: ${row.rowId}.`);
      }

      if (typeof row.displayLabel !== "string" || row.displayLabel.length === 0) {
        return invalidPreset(`Layout preset note displayLabel is required: ${row.rowId}.`);
      }

      const noteKey = `${row.stringId}|${row.midi}`;

      if (noteKeys.has(noteKey)) {
        return invalidPreset(`Duplicate layout preset note MIDI: ${row.stringId} ${row.midi}.`);
      }

      noteKeys.add(noteKey);
      editableRows.push({
        rowId: row.rowId,
        type: "note",
        stringId: row.stringId,
        midi: row.midi,
        height: row.height,
        displayLabel: row.displayLabel,
      });
    } else {
      if (!isGapBoundaryMidi(row.fromMidi) || !isGapBoundaryMidi(row.toMidi)) {
        return invalidPreset(`Layout preset gap boundary MIDI is invalid: ${row.rowId}.`);
      }

      if (row.fromMidi >= row.toMidi) {
        return invalidPreset(`Layout preset gap fromMidi must be < toMidi: ${row.rowId}.`);
      }

      editableRows.push({
        rowId: row.rowId,
        type: "gap",
        stringId: row.stringId,
        fromMidi: row.fromMidi,
        toMidi: row.toMidi,
        height: row.height,
      });
    }
  }

  const adjacentGapError = findAdjacentGapError(editableRows);

  if (adjacentGapError !== null) {
    return invalidPreset(adjacentGapError);
  }

  return {
    ok: true,
    value: editableRows,
  };
}

/**
 * rowDefinitions 안에서 연속 gap row 오류를 찾는다.
 * - 인수 : rows : 검증된 note/gap rowDefinitions
 * - 반환값 : 오류 메시지 또는 null
 */
function findAdjacentGapError(rows: LayoutEditableRowDefinition[]): string | null {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];

    if (
      previous?.type === "gap"
      && current?.type === "gap"
      && previous.stringId === current.stringId
    ) {
      return `Layout preset gap rows cannot be adjacent: ${previous.rowId}, ${current.rowId}.`;
    }
  }

  return null;
}

/**
 * note/gap rowDefinition 여부를 확인한다.
 * - 인수 : row : rowDefinition 후보
 * - 반환값 : note/gap rowDefinition 여부
 */
function isEditableRowDefinition(row: unknown): row is LayoutEditableRowDefinition {
  return isRecord(row) && (row.type === "note" || row.type === "gap");
}

/**
 * 악기 정보를 복사한다.
 * - 인수 : instData : 복사할 악기 정보
 * - 반환값 : 독립 악기 정보
 */
function cloneInstrumentData(instData: InstrumentData): InstrumentData {
  return {
    ...instData,
    strings: instData.strings.map((string) => ({ ...string })),
  };
}

/**
 * note/gap rowDefinitions를 복사한다.
 * - 인수 : rows : 복사할 note/gap rowDefinitions
 * - 반환값 : 독립 rowDefinitions
 */
function cloneEditableRows(
  rows: LayoutEditableRowDefinition[],
): LayoutEditableRowDefinition[] {
  return rows.map((row) => ({ ...row }));
}

/**
 * 파일명 일부에 부적합한 문자를 정리한다.
 * - 인수 : text : 파일명 일부 후보
 * - 반환값 : 파일명에 사용할 문자열
 */
function sanitizeFileNamePart(text: string): string {
  return (text.trim() || "layout")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

/**
 * 사용자 입력 문자열의 글자 수를 code point 기준으로 센다.
 * - 인수 : text : 글자 수를 셀 문자열
 * - 반환값 : code point 글자 수
 */
function countTextCharacters(text: string): number {
  return Array.from(text).length;
}

/**
 * unknown 값이 object record인지 확인한다.
 * - 인수 : value : 확인할 값
 * - 반환값 : object record 여부
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * MIDI note 번호인지 확인한다.
 * - 인수 : value : 확인할 값
 * - 반환값 : 0..127 정수 여부
 */
function isMidiNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 127;
}

/**
 * gap boundary MIDI 번호인지 확인한다.
 * - 인수 : value : 확인할 값
 * - 반환값 : -1..128 정수 여부
 */
function isGapBoundaryMidi(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -1 && value <= 128;
}

/**
 * 양의 정수인지 확인한다.
 * - 인수 : value : 확인할 값
 * - 반환값 : 양의 정수 여부
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * layout row height 허용 범위인지 확인한다.
 * - 인수 : value : 확인할 값
 * - 반환값 : 1..MAX_ROW_HEIGHT 정수 여부
 */
function isRowHeight(value: unknown): value is number {
  return isPositiveInteger(value) && value <= MAX_ROW_HEIGHT;
}

/**
 * 프리셋 검증 실패 결과를 만든다.
 * - 인수 : message : 실패 메시지
 * - 반환값 : warning 수준 실패 결과
 */
function invalidPreset<T>(message: string): LayoutPresetResult<T> {
  return {
    ok: false,
    level: "warning",
    message,
  };
}
