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
