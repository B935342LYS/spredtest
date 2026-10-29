/** 악보를 거부하지 않는 메타데이터 문제를 원본 변경 없이 수집한다. */
import type { ScoreFile } from "./types";

/**
 * 시간대가 명시된 ISO 날짜·시각을 검사한다.
 * - 인수 : value : 원본 메타데이터
 * - 반환값 : 실제 달력 날짜와 시각이 유효한지 여부
 */
export function isValidScoreTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  // Date.parse가 2월 30일 등을 다음 달로 보정하는 것을 허용하지 않는다.
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return calendar.getUTCFullYear() === Number(year)
    && calendar.getUTCMonth() + 1 === Number(month) && calendar.getUTCDate() === Number(day)
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (zone === "Z" || (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60));
}

/**
 * 허용된 메타데이터 불일치와 악기 음역 밖 행을 설명한다.
 * - 인수 : score : 구조 검증을 통과한 악보
 * - 반환값 : 원본을 변경하지 않는 경고 문구 목록
 */
export function collectScoreWarnings(score: ScoreFile): string[] {
  const warnings: string[] = [];
  const { createdAt, updatedAt } = score.musicData;
  if (!isValidScoreTimestamp(createdAt)) warnings.push("createdAt is missing or invalid; the first save will replace it with the save time.");
  if (!isValidScoreTimestamp(updatedAt)) warnings.push("updatedAt is missing or invalid; saving will update it.");
  if (isValidScoreTimestamp(createdAt) && isValidScoreTimestamp(updatedAt) && Date.parse(updatedAt) < Date.parse(createdAt)) {
    warnings.push("updatedAt precedes createdAt; saving will correct it.");
  }
  const strings = new Map(score.instData.strings.map((entry) => [entry.stringId, entry]));
  for (const entry of strings.values()) {
    if (score.instData.supportsOpen !== (entry.openMidi !== undefined)) {
      warnings.push(`${entry.stringId}: supportsOpen and openMidi disagree; original values are preserved.`);
    }
  }
  const outside = score.layout.rowDefinitions.filter((row) => {
    if (row.type !== "note") return false;
    const entry = strings.get(row.stringId)!;
    return row.midi < entry.minMidi || row.midi > entry.maxMidi;
  });
  if (outside.length > 0) warnings.push(`${outside.length} note row(s) are outside the range configured in instrument information (${outside.slice(0, 5).map((row) => row.rowId).join(", ")}${outside.length > 5 ? ", …" : ""}); pitches are preserved.`);
  return warnings;
}
