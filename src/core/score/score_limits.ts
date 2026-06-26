/**
 * ScoreFile 저장과 로드에 공통으로 적용하는 크기/문자열 제한값을 정의한다.
 */

/** 셀 rawText 최대 글자 수. */
export const MAX_CELL_RAW_TEXT_LENGTH = 100;

/** ScoreFile 전체 columnCount 최대값. */
export const MAX_SCORE_COLUMN_COUNT = 10000;

/** ScoreFile layout.rowDefinitions 최대 행 수. */
export const MAX_ROW_DEFINITIONS = 4096;

/** layout row height 최대 px 값. */
export const MAX_ROW_HEIGHT = 500;

/** Score JSON 파일 로드 최대 UTF-8 byte 수. */
export const MAX_SCORE_JSON_BYTES = 8 * 1024 * 1024;

/** localStorage에 저장할 Score JSON 최대 UTF-8 byte 수. */
export const MAX_LOCAL_SCORE_JSON_BYTES = 3 * 1024 * 1024;

/** YouTube offset 최소 ms 값. */
export const MIN_YOUTUBE_OFFSET_MS = -60000;

/** YouTube offset 최대 ms 값. */
export const MAX_YOUTUBE_OFFSET_MS = 60000;

/** YouTube offset UI step ms 값. */
export const YOUTUBE_OFFSET_STEP_MS = 100;

/**
 * YouTube offset 값을 저장 가능한 ms 범위 안으로 제한한다.
 * - 인수 : offsetMs : 사용자가 입력했거나 JSON에서 읽은 offset ms
 * - 반환값 : 허용 범위 안으로 제한된 정수 offset ms
 */
export function clampYoutubeOffsetMs(offsetMs: number): number {
  if (!Number.isFinite(offsetMs)) {
    return 0;
  }

  return Math.min(
    Math.max(Math.trunc(offsetMs), MIN_YOUTUBE_OFFSET_MS),
    MAX_YOUTUBE_OFFSET_MS,
  );
}

/**
 * UTF-8 기준 byte 길이를 계산한다.
 * - 인수 : text : byte 길이를 계산할 문자열
 * - 반환값 : UTF-8 byte 수
 */
export function getUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * byte 수를 사용자 메시지용 크기 문자열로 변환한다.
 * - 인수 : bytes : byte 수
 * - 반환값 : MiB 또는 KiB 단위 문자열
 */
export function formatByteSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`;
  }

  return `${Math.round(bytes / 1024)} KiB`;
}
