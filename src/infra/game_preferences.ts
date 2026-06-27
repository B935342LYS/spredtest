/**
 * 게임 모드 사용자 환경값을 브라우저 localStorage에 저장하고 불러온다.
 */

import {
  DEFAULT_GAME_SYNC_OFFSET_MS,
  normalizeGameSyncOffsetMs,
} from "../app/game/game_types";

const GAME_SYNC_OFFSET_STORAGE_KEY = "regression-code:game-sync-offset-ms";

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
