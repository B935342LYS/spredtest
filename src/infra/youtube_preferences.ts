/** YouTube의 브라우저별 보정값을 악보 데이터와 분리해 저장한다. */
export const MAX_YOUTUBE_LOCAL_OFFSET_MS = 5000;
const STORAGE_KEY = "regression-code:youtube-local-offset-ms";

/**
 * Local offset을 정수 ms와 허용 범위로 정규화한다.
 * - 인수 : value : 요청한 보정값
 * - 반환값 : ±5000ms 정수. 비정상 값은 0
 */
export function normalizeYoutubeLocalOffsetMs(value: number): number {
  return Number.isFinite(value)
    ? Math.max(-MAX_YOUTUBE_LOCAL_OFFSET_MS, Math.min(MAX_YOUTUBE_LOCAL_OFFSET_MS, Math.round(value)))
    : 0;
}

/**
 * 현재 브라우저의 Local offset을 읽는다.
 * - 인수 : 없음
 * - 반환값 : 저장된 값. 부재·오염·접근 실패 시 0
 */
export function loadYoutubeLocalOffsetMs(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeYoutubeLocalOffsetMs(raw === null || raw.trim() === "" ? 0 : Number(raw));
  } catch {
    return 0;
  }
}

/**
 * Local offset을 저장하며 저장소 실패 시에도 페이지 내 조절값을 유지한다.
 * - 인수 : value : 요청한 보정값
 * - 반환값 : 정규화된 보정값
 */
export function saveYoutubeLocalOffsetMs(value: number): number {
  const normalized = normalizeYoutubeLocalOffsetMs(value);
  try {
    localStorage.setItem(STORAGE_KEY, String(normalized));
  } catch {
    // 저장소가 차단되어도 호출자는 반환값을 런타임 설정으로 사용할 수 있다.
  }
  return normalized;
}
