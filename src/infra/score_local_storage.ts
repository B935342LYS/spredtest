/**
 * ScoreFile JSON을 브라우저 localStorage에 저장하고 불러온다.
 */

import type { ScoreFile } from "../core/score/types";
import {
  serializeScoreFile,
} from "./score_file_io";
import {
  MAX_LOCAL_SCORE_JSON_BYTES,
  formatByteSize,
  getUtf8ByteLength,
} from "../core/score/score_limits";

const LOCAL_SCORE_STORAGE_KEY = "regression-code:score-json";

/**
 * 현재 ScoreFile을 localStorage에 저장한다.
 * - 인수 : score : 저장할 score JSON 객체
 * - 반환값 : 없음
 */
export function saveScoreToLocalStorage(score: ScoreFile): void {
  const jsonText = serializeScoreFile(score);

  if (getUtf8ByteLength(jsonText) > MAX_LOCAL_SCORE_JSON_BYTES) {
    throw new Error(`Local score JSON must be ${formatByteSize(MAX_LOCAL_SCORE_JSON_BYTES)} or smaller.`);
  }

  localStorage.setItem(LOCAL_SCORE_STORAGE_KEY, jsonText);
}

/**
 * localStorage에 저장된 ScoreFile JSON 문자열을 읽는다.
 * - 인수 : 없음
 * - 반환값 : 저장된 JSON 문자열, 없으면 null
 */
export function loadScoreFromLocalStorage(): string | null {
  return localStorage.getItem(LOCAL_SCORE_STORAGE_KEY);
}
