/**
 * YouTube URL 또는 raw id 입력을 score에 저장할 video id로 정규화한다.
 */

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * 사용자 입력에서 YouTube video id를 추출한다.
 * - 인수 : value : 사용자가 입력한 URL 또는 video id
 * - 반환값 : 정규화된 video id. 실패하면 null
 */
export function parseYoutubeVideoId(value: string): string | null {
  const trimmedValue = value.trim();

  if (trimmedValue.length === 0) {
    return null;
  }

  if (YOUTUBE_ID_PATTERN.test(trimmedValue) && !trimmedValue.includes(".")) {
    return trimmedValue;
  }

  try {
    const url = new URL(trimmedValue);
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtube.com" || host === "m.youtube.com") {
      const queryId = url.searchParams.get("v");

      if (isYoutubeVideoId(queryId)) {
        return queryId;
      }

      return parseYoutubePathId(url.pathname);
    }

    if (host === "youtu.be") {
      return parseYoutubePathId(url.pathname);
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * YouTube path에서 embed/shorts/raw id 형태의 video id를 읽는다.
 * - 인수 : pathname : URL pathname
 * - 반환값 : 추출한 video id. 실패하면 null
 */
function parseYoutubePathId(pathname: string): string | null {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  const candidate = parts[0] === "embed" || parts[0] === "shorts"
    ? parts[1]
    : parts[0];

  return isYoutubeVideoId(candidate) ? candidate : null;
}

/**
 * 문자열이 YouTube video id로 저장 가능한 형태인지 확인한다.
 * - 인수 : value : 확인할 문자열 또는 null
 * - 반환값 : 저장 가능한 video id 여부
 */
function isYoutubeVideoId(value: string | null | undefined): value is string {
  return typeof value === "string" && YOUTUBE_ID_PATTERN.test(value);
}
