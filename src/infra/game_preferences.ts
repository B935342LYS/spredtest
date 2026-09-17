/**
 * 게임 모드 사용자 환경값을 브라우저 localStorage에 저장하고 불러온다.
 */

import {
  DEFAULT_GAME_SYNC_OFFSET_MS,
  normalizeGameSyncOffsetMs,
  normalizeGameDisplayOffsetMs,
} from "../app/game/game_types";

const GAME_SYNC_OFFSET_STORAGE_KEY = "regression-code:game-sync-offset-ms";
const GAME_DISPLAY_OFFSET_STORAGE_KEY = "regression-code:game-display-offset-ms";

/**
 * 저장된 화면 보정값을 읽고 범위와 단위를 정규화한다.
 * - 인수 : 없음
 * - 반환값 : 화면 보정 ms 값. 저장값 부재·오염·접근 실패 시 0
 */
export function loadGameDisplayOffsetMsFromLocalStorage(): number {
  try {
    const value = localStorage.getItem(GAME_DISPLAY_OFFSET_STORAGE_KEY);
    return normalizeGameDisplayOffsetMs(value === null ? 0 : Number(value));
  } catch {
    return 0;
  }
}

/**
 * 입력 Sync와 별도 키에 화면 보정값을 저장한다.
 * - 인수 : value : 요청한 화면 보정 ms 값
 * - 반환값 : 저장 실패 시에도 현재 페이지에서 사용할 정규화 값
 */
export function saveGameDisplayOffsetMsToLocalStorage(value: number): number {
  const normalized = normalizeGameDisplayOffsetMs(value);
  try {
    localStorage.setItem(GAME_DISPLAY_OFFSET_STORAGE_KEY, String(normalized));
  } catch {
    // 저장소가 차단되어도 조절한 값은 런타임 상태에 적용한다.
  }
  return normalized;
}

/**
 * localStorage에서 Sync 입력 지연 보정값을 읽는다.
 * - 인수 : 없음
 * - 반환값 : 저장된 Sync ms 값. 없거나 접근할 수 없으면 기본값
 */
export function loadGameSyncOffsetMsFromLocalStorage(): number {
  if (typeof localStorage === "undefined") {
    return DEFAULT_GAME_SYNC_OFFSET_MS;
  }

  try {
    const rawValue = localStorage.getItem(GAME_SYNC_OFFSET_STORAGE_KEY);

    if (rawValue === null) {
      return DEFAULT_GAME_SYNC_OFFSET_MS;
    }

    return normalizeGameSyncOffsetMs(Number(rawValue));
  } catch {
    return DEFAULT_GAME_SYNC_OFFSET_MS;
  }
}

/**
 * Sync 입력 지연 보정값을 localStorage에 저장한다.
 * - 인수 : value : 저장할 Sync ms 값
 * - 반환값 : 저장된 정규화 Sync ms 값
 */
export function saveGameSyncOffsetMsToLocalStorage(value: number): number {
  const normalized = normalizeGameSyncOffsetMs(value);

  if (typeof localStorage === "undefined") {
    return normalized;
  }

  try {
    localStorage.setItem(GAME_SYNC_OFFSET_STORAGE_KEY, String(normalized));
  } catch {
    // localStorage 접근이 차단된 브라우저에서도 런타임 설정은 계속 동작하게 둔다.
  }

  return normalized;
}
