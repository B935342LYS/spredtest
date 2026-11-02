/** YouTube의 브라우저별 보정값을 악보 데이터와 분리해 저장한다. */
export const MAX_YOUTUBE_LOCAL_OFFSET_MS = 5000;
const STORAGE_KEY = "regression-code:youtube-local-offset-ms";

/**
 * 저장값이 없는 브라우저의 환경별 초기 보정값을 고른다.
 * - 인수 : 없음
 * - 반환값 : 모바일로 식별되면 -220ms, Windows·그 외 환경은 0ms
 */
function getInitialYoutubeLocalOffsetMs(): number {
  if (typeof navigator === "undefined") return 0;
  const userAgent = navigator.userAgent;
  // 터치 지원 Windows도 데스크톱 기본값을 사용한다.
  if (/Windows/i.test(userAgent)) return 0;
  // iPadOS의 데스크톱 UA는 Macintosh 표기와 멀티터치 지원을 함께 확인한다.
  const isMobile = /Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
  return isMobile ? -220 : 0;
}

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
 * - 반환값 : 저장된 값. 부재 시 환경별 초기값, 오염·접근 실패 시 0
 */
export function loadYoutubeLocalOffsetMs(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // 저장된 0도 사용자 선택이다. 키가 없을 때만 초기값을 적용하며 자동 저장하지 않는다.
    if (raw === null) return getInitialYoutubeLocalOffsetMs();
    return normalizeYoutubeLocalOffsetMs(raw.trim() === "" ? 0 : Number(raw));
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
