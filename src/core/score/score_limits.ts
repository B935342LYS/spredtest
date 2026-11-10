/**
 * ScoreFile 저장과 로드에 공통으로 적용하는 크기/문자열 제한값을 정의한다.
 */

/** 셀 rawText 최대 글자 수. */
export const MAX_CELL_RAW_TEXT_LENGTH = 200;

/** ScoreFile musicData.comment 최대 글자 수. */
export const MAX_SCORE_COMMENT_LENGTH = 500;

/** ScoreFile 전체 columnCount 대용량 경고 기준. */
export const SCORE_COLUMN_WARNING_THRESHOLD = 10000;

/** ScoreFile layout.rowDefinitions 최대 행 수. */
export const MAX_ROW_DEFINITIONS = 4096;

/** layout row height 최대 px 값. */
export const MAX_ROW_HEIGHT = 500;

/** Score JSON 파일 로드·다운로드 대용량 경고 기준 UTF-8 byte 수. */
export const SCORE_JSON_WARNING_BYTES = 8 * 1024 * 1024;

/** 대용량 작업 경고를 표시하고 이번 작업에 대한 사용자 동의를 반환한다. */
export type ConfirmLargeScore = (message: string) => boolean;

/**
 * 크기 기준을 초과한 작업에만 동의를 요청한다. 확인 수단이 없으면 거부한다.
 * - 인수 : bytes : JSON UTF-8 크기. 아직 모르면 0
 * - 인수 : columns : 악보 열 수. 아직 모르면 0
 * - 인수 : confirm : UI가 제공하는 이번 작업의 확인 함수
 * - 반환값 : 기준 이하이거나 명시적으로 동의하면 true
 */
export function allowLargeScoreOperation(bytes: number, columns: number, confirm?: ConfirmLargeScore): boolean {
  if (bytes <= SCORE_JSON_WARNING_BYTES && columns <= SCORE_COLUMN_WARNING_THRESHOLD) return true;
  return confirm?.(
    `Large score: ${[bytes > 0 ? formatByteSize(bytes) : "", columns > 0 ? `${columns.toLocaleString("en-US")} columns` : ""].filter(Boolean).join(", ")}.\n` +
    "Scores over 8 MiB or 10,000 columns may make the browser unresponsive or run out of memory. " +
    "Unsaved changes may be lost. Continue with this operation?",
  ) === true;
}

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
