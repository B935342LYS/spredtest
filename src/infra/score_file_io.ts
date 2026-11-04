/**
 * ScoreFile JSON을 브라우저 파일 입출력 API와 연결한다.
 */

import type { ScoreFile } from "../core/score/types";
import { MAX_SCORE_JSON_BYTES, formatByteSize, getUtf8ByteLength } from "../core/score/score_limits";

/** 다운로드할 JSON 본문 준비 결과. 용량 초과 시 악보 내용은 수정하지 않는다. */
export type ScoreJsonExportResult =
  | { ok: true; jsonText: string }
  | { ok: false; message: string };

/**
 * ScoreFile을 사람이 읽기 쉬운 JSON 문자열로 직렬화한다.
 * - 인수 : score : 저장할 score JSON 객체
 * - 반환값 : pretty-print된 JSON 문자열
 */
export function serializeScoreFile(score: ScoreFile): string {
  return `${JSON.stringify(score, null, 2)}\n`;
}

/**
 * 파일 로드 상한 안에서 악보를 다시 읽을 수 있는 JSON 본문을 준비한다.
 * - 인수 : score : 저장 시각까지 반영된 최종 악보
 * - 반환값 : 들여쓰기 JSON, 필요 시 공백 없는 JSON, 둘 다 초과하면 실패
 */
export function prepareScoreJsonExport(score: ScoreFile): ScoreJsonExportResult {
  const pretty = serializeScoreFile(score);
  if (getUtf8ByteLength(pretty) <= MAX_SCORE_JSON_BYTES) {
    return { ok: true, jsonText: pretty };
  }

  // JSON 구조의 들여쓰기만 생략한다. rawText 등 문자열 내부 공백은 보존한다.
  const compact = JSON.stringify(score);
  if (getUtf8ByteLength(compact) <= MAX_SCORE_JSON_BYTES) {
    return { ok: true, jsonText: compact };
  }
  return {
    ok: false,
    message: `Cannot download: score JSON exceeds ${formatByteSize(MAX_SCORE_JSON_BYTES)} even without indentation. Reduce the score size and try again.`,
  };
}

/**
 * 파일명에 부적합한 문자를 제거하고 JSON 파일명을 만든다.
 * - 인수 : score : 파일명 후보 metadata를 가진 score JSON
 * - 반환값 : 다운로드에 사용할 JSON 파일명
 */
export function createScoreJsonFileName(score: ScoreFile): string {
  const title = score.musicData.musicTitle.trim() || "regression-code-score";
  const safeTitle = title
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);

  return `${safeTitle || "regression-code-score"}.json`;
}

/**
 * ScoreFile JSON 문자열을 브라우저 다운로드로 내보낸다.
 * - 인수 : score : 저장할 score JSON 객체
 * - 반환값 : JSON 준비 결과. 용량 초과 시 다운로드를 시작하지 않는다.
 */
export function downloadScoreJson(score: ScoreFile): ScoreJsonExportResult {
  const result = prepareScoreJsonExport(score);
  if (!result.ok) return result;
  downloadTextFile(
    createScoreJsonFileName(score),
    result.jsonText,
    "application/json;charset=utf-8",
  );
  return result;
}

/**
 * 텍스트 문자열을 브라우저 다운로드로 내보낸다.
 * - 인수 : fileName : 다운로드 파일명
 * - 인수 : text : 저장할 텍스트
 * - 인수 : mimeType : Blob MIME type
 * - 반환값 : 없음
 */
export function downloadTextFile(
  fileName: string,
  text: string,
  mimeType: string,
): void {
  const blob = new Blob([text], {
    type: mimeType,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * 사용자가 선택한 File 객체를 UTF-8 텍스트로 읽는다.
 * - 인수 : file : JSON Load input에서 받은 파일 객체
 * - 반환값 : 파일 본문 문자열 Promise
 */
export function readTextFile(file: File): Promise<string> {
  return file.text();
}
