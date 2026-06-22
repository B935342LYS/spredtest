/**
 * ScoreFile JSON을 브라우저 파일 입출력 API와 연결한다.
 */

import type { ScoreFile } from "../core/score/types";

/**
 * ScoreFile을 사람이 읽기 쉬운 JSON 문자열로 직렬화한다.
 * - 인수 : score : 저장할 score JSON 객체
 * - 반환값 : pretty-print된 JSON 문자열
 */
export function serializeScoreFile(score: ScoreFile): string {
  return `${JSON.stringify(score, null, 2)}\n`;
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
 * - 반환값 : 없음
 */
export function downloadScoreJson(score: ScoreFile): void {
  downloadTextFile(
    createScoreJsonFileName(score),
    serializeScoreFile(score),
    "application/json;charset=utf-8",
  );
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
