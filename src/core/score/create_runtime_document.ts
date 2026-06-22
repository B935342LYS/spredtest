/**
 * src\core\score\create_runtime_document.ts
 * 검증된 ScoreFile과 런타임 조회용 ScoreIndexes를 RuntimeDocument로 묶는다.
 * 이 파일은 JSON 로드 이후 parser/analyzer가 사용할 score 모듈의 최종 로드 진입점을 제공한다.
 */

import { buildScoreIndexes } from "./build_score_indexes";
import {
  loadScoreFile,
  type JsonLoadError,
} from "./json_load";
import type {
  RuntimeDocument,
  ScoreFile,
} from "./types";
import type { ScoreValidationError } from "./score_validate";

/**
 * JSON 문자열에서 RuntimeDocument까지 생성한 결과.
 * - 정상 로드 시 : RuntimeDocument
 * - 비정상 로드 시 : JsonLoadError 또는 ScoreValidationError
 */
export type LoadRuntimeDocumentResult =
  | {
      ok: true;
      document: RuntimeDocument;
    }
  | {
      ok: false;
      error: JsonLoadError | ScoreValidationError;
    };

/**
 * 검증된 ScoreFile에서 RuntimeDocument를 생성한다.
 * - 인수 : score : score_validate.ts 검증을 통과한 ScoreFile
 * - 반환값 : RuntimeDocument : ScoreFile과 ScoreIndexes를 묶은 런타임 문서
 */
export function createRuntimeDocument(score: ScoreFile): RuntimeDocument {
  return {
    score,
    // indexes는 score에서 파생되는 런타임 조회 구조이므로 같은 컨테이너에서 함께 보관한다.
    indexes: buildScoreIndexes(score),
  };
}

/**
 * JSON 문자열을 파싱, 검증, 인덱스 생성까지 수행해 RuntimeDocument로 로드한다.
 * - 인수 : jsonText : 입력된 JSON 원본 문자열
 * - 반환값 : LoadRuntimeDocumentResult : 런타임 문서 로드 성공 또는 실패 결과
 */
export function loadRuntimeDocument(
  jsonText: string,
): LoadRuntimeDocumentResult {
  // RuntimeDocument 생성 전에는 JSON 파싱과 ScoreFile 검증이 먼저 끝나야 한다.
  const loadResult = loadScoreFile(jsonText);

  // JSON 파싱 또는 ScoreFile 검증 실패는 인덱스 생성 전 단계의 오류이므로 그대로 전달한다.
  if (!loadResult.ok) {
    return loadResult;
  }

  return {
    ok: true,
    // 검증된 ScoreFile에 대해서만 인덱스를 생성해 score/index 불일치를 막는다.
    document: createRuntimeDocument(loadResult.score),
  };
}
