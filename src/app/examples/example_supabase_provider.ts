/**
 * Supabase Edge Function 기반 Examples provider를 구현한다.
 */

import {
  validateExampleManifest,
} from "./example_manifest_validate";
import type {
  ExampleError,
  ExampleErrorResponse,
  ExampleProvider,
  ExampleScoreManifest,
  ExampleScoreManifestItem,
} from "./example_types";
import type { ExampleProviderConfig } from "./example_config";

/**
 * Supabase Edge Function provider를 생성한다.
 * - 인수 : config : Edge Function URL과 선택 publishable key
 * - 반환값 : Examples manifest/score text provider
 */
export function createSupabaseExampleProvider(config: ExampleProviderConfig): ExampleProvider {
  return {
    providerId: "supabase",
    displayName: "Supabase Examples",
    loadManifest(accessWord: string): Promise<ExampleScoreManifest> {
      return loadManifestFromSupabase(config, accessWord);
    },
    loadScoreText(item: ExampleScoreManifestItem): Promise<string> {
      return loadScoreTextFromUrl(item);
    },
  };
}

/**
 * Edge Function에서 example manifest를 읽고 앱 manifest 타입으로 검증한다.
 * - 인수 : config : provider 공개 설정
 * - 인수 : accessWord : 사용자가 dialog에 입력한 임시 암호 단어
 * - 반환값 : 검증된 example manifest
 */
async function loadManifestFromSupabase(
  config: ExampleProviderConfig,
  accessWord: string,
): Promise<ExampleScoreManifest> {
  if (config.manifestFunctionUrl.length === 0) {
    throw createExampleError("CONFIG_MISSING", "Examples endpoint is not configured.");
  }

  const response = await fetch(config.manifestFunctionUrl, {
    method: "POST",
    headers: createFunctionHeaders(config),
    body: JSON.stringify({ accessWord }),
  });
  const jsonValue = await readJsonResponse(response);

  if (!response.ok) {
    throw normalizeErrorResponse(jsonValue, response.status);
  }

  const validation = validateExampleManifest(jsonValue);

  if (!validation.ok) {
    throw createExampleError(
      "INVALID_RESPONSE",
      `Invalid example manifest at ${validation.error.path || "root"}: ${validation.error.message}`,
    );
  }

  return validation.manifest;
}

/**
 * 선택한 manifest item의 Score JSON text를 fetch한다.
 * - 인수 : item : 사용자가 선택한 example manifest item
 * - 반환값 : Score JSON 문자열
 */
async function loadScoreTextFromUrl(item: ExampleScoreManifestItem): Promise<string> {
  const response = await fetch(item.scoreUrl, {
    method: "GET",
  });

  if (!response.ok) {
    throw createExampleError(
      "SCORE_FETCH_FAILED",
      `Failed to load example score: HTTP ${response.status}.`,
    );
  }

  return response.text();
}

/**
 * Edge Function 요청 header를 만든다.
 * - 인수 : config : provider 공개 설정
 * - 반환값 : fetch에 전달할 header 묶음
 */
function createFunctionHeaders(config: ExampleProviderConfig): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.publishableKey.length > 0) {
    headers.apikey = config.publishableKey;
  }

  return headers;
}

/**
 * HTTP 응답 body를 JSON 값으로 읽는다.
 * - 인수 : response : fetch response
 * - 반환값 : JSON으로 파싱된 값
 */
async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw createExampleError("INVALID_RESPONSE", "Examples response must be JSON.");
  }
}

/**
 * Edge Function 오류 응답을 앱 오류로 정규화한다.
 * - 인수 : value : 오류 응답 후보 값
 * - 인수 : status : HTTP status code
 * - 반환값 : 앱 Examples 오류
 */
function normalizeErrorResponse(value: unknown, status: number): ExampleError {
  if (isErrorResponse(value)) {
    return createExampleError(normalizeErrorCode(value.error.code, status), value.error.message);
  }

  return createExampleError("INVALID_RESPONSE", `Examples request failed: HTTP ${status}.`);
}

/**
 * Edge Function 오류 code를 앱이 아는 code로 정리한다.
 * - 인수 : code : Edge Function이 반환한 code
 * - 인수 : status : HTTP status code
 * - 반환값 : 앱 오류 code
 */
function normalizeErrorCode(code: string, status: number): ExampleError["code"] {
  if (
    code === "INVALID_ACCESS_WORD" ||
    code === "INVALID_REQUEST" ||
    code === "INVALID_RESPONSE" ||
    code === "MANIFEST_UNAVAILABLE" ||
    code === "METHOD_NOT_ALLOWED" ||
    code === "RATE_LIMITED" ||
    code === "INTERNAL_ERROR"
  ) {
    return code;
  }

  if (status === 401 || status === 403) {
    return "INVALID_ACCESS_WORD";
  }

  if (status === 429) {
    return "RATE_LIMITED";
  }

  if (status >= 500) {
    return "INTERNAL_ERROR";
  }

  return "INVALID_RESPONSE";
}

/**
 * unknown 값이 표준 Edge Function 오류 응답인지 확인한다.
 * - 인수 : value : 검사할 값
 * - 반환값 : 오류 응답이면 true
 */
function isErrorResponse(value: unknown): value is ExampleErrorResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const error = (value as { error?: unknown }).error;

  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }

  const errorRecord = error as { code?: unknown; message?: unknown };

  return typeof errorRecord.code === "string" &&
    typeof errorRecord.message === "string";
}

/**
 * Examples 오류 객체를 만든다.
 * - 인수 : code : 오류 code
 * - 인수 : message : 사용자 표시 가능 메시지
 * - 반환값 : Examples 오류
 */
function createExampleError(code: ExampleError["code"], message: string): ExampleError {
  return {
    code,
    message,
  };
}
