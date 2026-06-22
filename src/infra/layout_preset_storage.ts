/**
 * 레이아웃 프리셋을 브라우저 localStorage의 고정 슬롯에 저장하고 불러온다.
 */

import type { UserLayoutPresetData } from "../app/layout/layout_types";
import {
  parseUserLayoutPresetJson,
  serializeUserLayoutPresetData,
} from "../app/layout/layout_preset";

/** 악기 프리셋별 로컬 레이아웃 프리셋 슬롯 수. */
export const LOCAL_LAYOUT_PRESET_SLOT_COUNT = 3;

/** 로컬 레이아웃 프리셋 슬롯 번호. */
export type LocalLayoutPresetSlotNumber = 1 | 2 | 3;

/**
 * 로컬 레이아웃 프리셋 슬롯 표시 정보.
 * - 인수 : 없음
 * - 반환값 : 슬롯 번호와 저장된 프리셋 요약
 */
export type LocalLayoutPresetSlot = {
  slotNumber: LocalLayoutPresetSlotNumber;
  layoutPresetId: string;
  layoutPresetDisplayName: string;
  updatedAt: string | null;
  preset: UserLayoutPresetData | null;
};

/**
 * instrumentPresetId에 해당하는 local layout preset 3슬롯을 읽는다.
 * - 인수 : instrumentPresetId : 현재 score의 악기 프리셋 ID
 * - 반환값 : Slot 1..3의 현재 저장 상태
 */
export function loadLayoutPresetSlotsFromLocalStorage(
  instrumentPresetId: string,
): LocalLayoutPresetSlot[] {
  return getLocalLayoutPresetSlotNumbers().map((slotNumber) => {
    const preset = loadLayoutPresetSlotFromLocalStorage(instrumentPresetId, slotNumber);

    return {
      slotNumber,
      layoutPresetId: createSlotLayoutPresetId(slotNumber),
      layoutPresetDisplayName: preset?.layoutPresetDisplayName ?? `Slot ${slotNumber} Empty`,
      updatedAt: preset?.updatedAt ?? null,
      preset,
    };
  });
}

/**
 * 레이아웃 프리셋을 지정 슬롯에 저장한다.
 * - 인수 : preset : 저장할 레이아웃 프리셋 데이터
 * - 인수 : slotNumber : 저장할 슬롯 번호
 * - 반환값 : 갱신된 Slot 1..3 저장 상태
 */
export function saveLayoutPresetSlotToLocalStorage(
  preset: UserLayoutPresetData,
  slotNumber: LocalLayoutPresetSlotNumber,
): LocalLayoutPresetSlot[] {
  const normalizedPreset = {
    ...preset,
    layoutPresetId: createSlotLayoutPresetId(slotNumber),
  };
  const jsonResult = serializeUserLayoutPresetData(normalizedPreset);

  if (!jsonResult.ok) {
    throw new Error(jsonResult.message);
  }

  localStorage.setItem(
    createLayoutPresetSlotKey(preset.instrumentPresetId, slotNumber),
    jsonResult.value,
  );

  return loadLayoutPresetSlotsFromLocalStorage(preset.instrumentPresetId);
}

/**
 * localStorage에서 지정 슬롯의 레이아웃 프리셋 데이터를 읽고 검증한다.
 * - 인수 : instrumentPresetId : 현재 score의 악기 프리셋 ID
 * - 인수 : slotNumber : 불러올 슬롯 번호
 * - 반환값 : 검증된 레이아웃 프리셋 데이터, 비어 있으면 null
 */
export function loadLayoutPresetSlotFromLocalStorage(
  instrumentPresetId: string,
  slotNumber: LocalLayoutPresetSlotNumber,
): UserLayoutPresetData | null {
  const slotKey = createLayoutPresetSlotKey(instrumentPresetId, slotNumber);
  const presetText = localStorage.getItem(slotKey);

  if (presetText === null) {
    return null;
  }

  const result = parseUserLayoutPresetJson(presetText);

  if (!result.ok) {
    // 로컬 슬롯은 개인 캐시이므로 깨진 이전 데이터가 새 저장을 막지 않도록 비운다.
    localStorage.removeItem(slotKey);
    return null;
  }

  return result.value;
}

/**
 * slot select value를 슬롯 번호로 해석한다.
 * - 인수 : value : select option value
 * - 반환값 : 슬롯 번호 또는 null
 */
export function parseLocalLayoutPresetSlotNumber(
  value: string,
): LocalLayoutPresetSlotNumber | null {
  if (value === "slot-1") {
    return 1;
  }

  if (value === "slot-2") {
    return 2;
  }

  if (value === "slot-3") {
    return 3;
  }

  return null;
}

/**
 * 슬롯 번호를 layoutPresetId로 변환한다.
 * - 인수 : slotNumber : 슬롯 번호
 * - 반환값 : 프리셋 ID
 */
export function createSlotLayoutPresetId(
  slotNumber: LocalLayoutPresetSlotNumber,
): string {
  return `slot-${slotNumber}`;
}

/**
 * 사용할 수 있는 슬롯 번호 목록을 반환한다.
 * - 인수 : 없음
 * - 반환값 : Slot 1..3 번호 목록
 */
function getLocalLayoutPresetSlotNumbers(): LocalLayoutPresetSlotNumber[] {
  return [1, 2, 3];
}

/**
 * layout preset slot localStorage key를 만든다.
 * - 인수 : instrumentPresetId : 악기 프리셋 ID
 * - 인수 : slotNumber : 슬롯 번호
 * - 반환값 : slot data 저장 key
 */
function createLayoutPresetSlotKey(
  instrumentPresetId: string,
  slotNumber: LocalLayoutPresetSlotNumber,
): string {
  return `layout-slot:${instrumentPresetId}:${slotNumber}`;
}
