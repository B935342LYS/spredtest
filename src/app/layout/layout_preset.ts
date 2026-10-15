/**
 * 레이아웃 편집 draft와 프리셋 저장 데이터의 변환, ID·다운로드 파일명 생성을 담당한다.
 */

import type { InstrumentData } from "../../core/score/types";
import { MAX_LAYOUT_PRESET_NAME_LENGTH, type LayoutPresetResult, type UserLayoutPresetData } from "../../core/score/layout_preset";
import type { LayoutDraftBundle, LayoutEditableRowDefinition } from "./layout_types";

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
