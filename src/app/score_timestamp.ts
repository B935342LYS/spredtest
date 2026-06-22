/**
 * ScoreFile의 수정 시각 metadata를 갱신하는 helper이다.
 */

import type { ScoreFile } from "../core/score/types";
import type { ScoreOrigin } from "./app_types";

/**
 * 현재 시각을 ScoreFile updatedAt에 저장할 ISO 문자열로 만든다.
 * - 인수 : 없음
 * - 반환값 : ISO 8601 형식 timestamp
 */
export function createCurrentUpdatedAtTimestamp(): string {
  return new Date().toISOString();
}

/**
 * ScoreFile의 musicData.updatedAt을 갱신한 새 ScoreFile 객체를 만든다.
 * - 인수 : score : 갱신할 score JSON
 * - 인수 : timestamp : 저장할 수정 시각. 생략하면 현재 시각을 사용한다.
 * - 반환값 : updatedAt이 갱신된 ScoreFile
 */
export function touchScoreUpdatedAt(
  score: ScoreFile,
  timestamp = createCurrentUpdatedAtTimestamp(),
): ScoreFile {
  const updatedAt = normalizeUpdatedAt(score.musicData.createdAt, timestamp);

  return {
    ...score,
    musicData: {
      ...score.musicData,
      updatedAt,
    },
  };
}

/**
 * 명시 저장 시점의 origin 정책에 맞춰 ScoreFile timestamp를 갱신한다.
 * - 인수 : score : 저장할 score JSON
 * - 인수 : scoreOrigin : 현재 score가 앱에 들어온 출처
 * - 인수 : timestamp : 저장할 기준 시각. 생략하면 현재 시각을 사용한다.
 * - 반환값 : 저장 정책에 맞춰 timestamp가 갱신된 ScoreFile
 */
export function touchScoreTimestampsForSave(
  score: ScoreFile,
  scoreOrigin: ScoreOrigin,
  timestamp = createCurrentUpdatedAtTimestamp(),
): ScoreFile {
  if (scoreOrigin === "template") {
    return {
      ...score,
      musicData: {
        ...score.musicData,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    };
  }

  return touchScoreUpdatedAt(score, timestamp);
}

/**
 * createdAt보다 과거가 되지 않도록 updatedAt 후보를 보정한다.
 * - 인수 : createdAt : score 생성 시각
 * - 인수 : updatedAt : 수정 시각 후보
 * - 반환값 : 저장할 updatedAt 문자열
 */
function normalizeUpdatedAt(createdAt: string, updatedAt: string): string {
  const createdTime = Date.parse(createdAt);
  const updatedTime = Date.parse(updatedAt);

  // 날짜 파싱이 실패하면 호출자가 만든 ISO timestamp를 그대로 사용한다.
  if (!Number.isFinite(createdTime) || !Number.isFinite(updatedTime)) {
    return updatedAt;
  }

  return updatedTime < createdTime ? createdAt : updatedAt;
}
