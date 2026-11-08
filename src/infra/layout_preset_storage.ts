/**
 * 레이아웃 프리셋을 브라우저 localStorage의 고정 슬롯에 저장하고 불러온다.
 */

import type { UserLayoutPresetData } from "../core/score/layout_preset";
import { NORMAL_SCORE_LAYOUT_PRESET } from "../assets/templates/normal-score-layout-preset";
import {
  parseUserLayoutPresetJson,
  serializeUserLayoutPresetData,
} from "../core/score/layout_preset";

/** 사용자 공통 로컬 레이아웃 프리셋 슬롯 수. */
export const LOCAL_LAYOUT_PRESET_SLOT_COUNT = 3;

/** 저장소 접근 실패와 구분하여 명시적 덮어쓰기를 허용할 손상 데이터 오류. */
export class InvalidLayoutPresetSlotError extends Error {}

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
  // preset이 null이어도 이 값이 있으면 빈 슬롯이 아니라 조회 실패다.
  readError?: string;
};

/**
 * 악보와 독립된 사용자 공통 3슬롯을 읽고 슬롯별 오류를 표시 정보에 담는다.
 * - 인수 : 없음
 * - 반환값 : Slot 1..3의 현재 저장 상태
 */
export function loadLayoutPresetSlotsFromLocalStorage(): LocalLayoutPresetSlot[] {
  return getLocalLayoutPresetSlotNumbers().map((slotNumber) => {
    let preset: UserLayoutPresetData | null = null;
    let readError: string | undefined;
    // 한 슬롯이 손상되거나 접근이 실패해도 다른 슬롯은 각각 조회한다.
    try {
      preset = loadLayoutPresetSlotFromLocalStorage(slotNumber);
    } catch (error: unknown) {
      readError = error instanceof Error ? error.message : "Layout slot could not be read.";
    }

    return {
      slotNumber,
      layoutPresetId: createSlotLayoutPresetId(slotNumber),
      layoutPresetDisplayName: preset?.layoutPresetDisplayName ?? `Slot ${slotNumber} Empty`,
      updatedAt: preset?.updatedAt ?? null,
      preset,
      readError,
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
    createLayoutPresetSlotKey(slotNumber),
    jsonResult.value,
  );

  return loadLayoutPresetSlotsFromLocalStorage();
}

/**
 * localStorage에서 지정 슬롯의 레이아웃 프리셋 데이터를 읽고 검증한다.
 * - 인수 : slotNumber : 불러올 슬롯 번호
 * - 반환값 : 검증된 레이아웃 프리셋 데이터, 비어 있으면 null
 */
export function loadLayoutPresetSlotFromLocalStorage(
  slotNumber: LocalLayoutPresetSlotNumber,
): UserLayoutPresetData | null {
  const slotKey = createLayoutPresetSlotKey(slotNumber);
  const presetText = localStorage.getItem(slotKey);

  if (presetText === null) {
    return getBundledLayoutPresetForSlot(slotNumber);
  }

  const result = parseUserLayoutPresetJson(presetText);

  if (!result.ok) {
    // 읽기는 원본을 변경하지 않으며, 명시적 덮어쓰기에서만 손상값을 교체한다.
    throw new InvalidLayoutPresetSlotError(`Slot ${slotNumber}: ${result.message}`);
  }

  return result.value;
}

/**
 * localStorage에 사용자 저장값이 없을 때 제공할 bundled layout preset을 반환한다.
 * - 인수 : slotNumber : 조회할 슬롯 번호
 * - 반환값 : 기본 제공 프리셋 또는 null
 */
function getBundledLayoutPresetForSlot(
  slotNumber: LocalLayoutPresetSlotNumber,
): UserLayoutPresetData | null {
  if (slotNumber === 1) {
    return cloneLayoutPreset(NORMAL_SCORE_LAYOUT_PRESET);
  }

  return null;
}

/**
 * bundled preset 원본을 외부에서 수정하지 못하도록 복사한다.
 * - 인수 : preset : 복사할 기본 제공 프리셋
 * - 반환값 : 독립적으로 사용할 프리셋 데이터
 */
function cloneLayoutPreset(preset: UserLayoutPresetData): UserLayoutPresetData {
  return {
    ...preset,
    instData: {
      ...preset.instData,
      strings: preset.instData.strings.map((stringInfo) => ({ ...stringInfo })),
    },
    rowDefinitions: preset.rowDefinitions.map((row) => ({ ...row })),
  };
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
 * - 인수 : slotNumber : 슬롯 번호
 * - 반환값 : slot data 저장 key
 */
function createLayoutPresetSlotKey(
  slotNumber: LocalLayoutPresetSlotNumber,
): string {
  return `layout-slot:shared:v1:${slotNumber}`;
}
