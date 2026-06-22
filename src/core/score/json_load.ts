/**
 * src\core\score\json_load.ts
 * 입력되는 악보 JSON 문자열을 JavaScript 값으로 파싱한다.
 * JSON 문법 오류와 최상위 값의 object 여부만 이 단계에서 처리한다.
 * ScoreFile 구조 검증은 score_validate.ts가 담당한다.
 * 이 파일은 JSON 로드와 검증 위임을 연결하는 편의 함수도 함께 제공한다.
 */

import type { ScoreFile } from "./types";
import {
  validateScoreFile,
  type ScoreValidationError,
} from "./score_validate";
import {
  MAX_SCORE_JSON_BYTES,
  formatByteSize,
  getUtf8ByteLength,
} from "./score_limits";

/**
 * JSON 문자열 파싱 결과.
 * - 정상 로드 시 : ScoreFile 후보 값
 * - 비정상 로드 시 : JsonLoadError
 */
export type LoadScoreJsonResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      error: JsonLoadError;
    };

/**
 * json 파싱 단계에서 두 종류의 오류가 있을 수 있다.
 * - json_too_large : JSON 문자열이 허용 용량을 초과함
 * - parse_error : JSON 작성 형식을 지키지 않아 발생하는 오류
 * - not_object : 파싱 결과가 올바른 객체가 아님
 */
export type JsonLoadError = {
  code: "json_too_large" | "parse_error" | "not_object";
  message: string;
};

/**
 * JSON 파싱과 ScoreFile 구조 검증까지 끝낸 통합 로드 결과.
 * - 정상 로드 시 : ScoreFile
 * - 비정상 로드 시 : JsonLoadError 또는 ScoreValidationError
 */
export type LoadScoreFileResult =
  | {
      ok: true;
      score: ScoreFile;
    }
  | {
      ok: false;
      error: JsonLoadError | ScoreValidationError;
    };

/**
 * JSON 문자열을 ScoreFile 후보 값으로 파싱한다. 이 함수는 JSON 문법과 최상위 object 여부만 확인한다.
 * - 인수 : jsonText : 입력된 json 원본 문자열
 * - 반환값 : LoadScoreJsonResult : 로드 결과물
 */
export function loadScoreJson(jsonText: string): LoadScoreJsonResult {
  let parsed: unknown;

  if (getUtf8ByteLength(jsonText) > MAX_SCORE_JSON_BYTES) {
    return {
      ok: false,
      error: {
        code: "json_too_large",
        message: `Score JSON must be ${formatByteSize(MAX_SCORE_JSON_BYTES)} or smaller.`,
      },
    };
  }

  // JSON.parse는 예외를 던지는 API이므로 loader 경계에서 결과 객체로 변환한다.
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    // 파싱 error 발견시 parse_error 기반 JsonLoadError가 포함된 결과를 반환.
    return {
      ok: false,
      error: {
        code: "parse_error",
        message: error instanceof Error ? error.message : "Invalid JSON text.", // catch된 값이 Error 객체가 아닐 가능성에 대비해 기본 오류 메시지를 사용한다.
      },
    };
  }

  // 파싱 결과 최상위 구조가 객체가 아니거나, 객체로 판정되더라도 null이나 배열일 시,
  // not_object 기반 JsonLoadError가 포함된 결과를 반환.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: "not_object",
        message: "Score JSON root must be an object.",
      },
    };
  }

  // 위 검사를 모두 통과했다면 ok = true인 LoadScoreJsonResult를 반환한다.
  return {
    ok: true,
    value: parsed,
  };
}

/**
 * JSON 문자열을 파싱한 뒤 ScoreFile 최소 구조 검증까지 수행한다.
 * - 인수 : jsonText : 입력된 JSON 원본 문자열
 * - 반환값 : LoadScoreFileResult : JSON 파싱과 ScoreFile 검증 결과
 */
export function loadScoreFile(jsonText: string): LoadScoreFileResult {
  // JSON 문법과 최상위 object 여부를 먼저 확인한 뒤 ScoreFile 구조 검증으로 넘긴다.
  const loadResult = loadScoreJson(jsonText);

  // loadResult.ok === false이면 JSON 로드 실패 상황이므로 에러 정보를 그대로 반환한다.
  // 이 분기에서 loadResult는 실패 케이스로 타입이 좁혀지며, LoadScoreFileResult의 실패 반환형과 호환된다.
  if (!loadResult.ok) {
    return loadResult;
  }

  // JSON 파싱이 정상 처리되었다면 validateScoreFile()로 ScoreFile 구조를 검증한다.
  return validateScoreFile(loadResult.value);
}
