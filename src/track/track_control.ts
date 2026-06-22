/**
 * track layer 기능에서 renderer/audio/app이 공유하는 순수 정책 값을 제공한다.
 */

import type { AnalysisResult, AnalyzedTrackResult } from "../core/analyze/types";
import type { TrackId } from "../core/score/types";

/** score JSON과 UI가 지원하는 고정 track 목록. */
export const TRACK_IDS: TrackId[] = ["basic", "optional", "extra"];

/** track UI에 표시할 고정 순서. */
export const TRACK_UI_ORDER: TrackId[] = ["basic", "optional", "extra"];

/** canvas에서 먼저 그릴 track부터 나열한 draw order. */
export const TRACK_DRAW_ORDER: TrackId[] = ["extra", "optional", "basic"];

/** 기본 active track 상태. */
export const DEFAULT_ACTIVE_TRACK_IDS: TrackId[] = ["basic"];

/** inactive track에 적용하는 첫 구현 alpha 값. */
export const INACTIVE_TRACK_ALPHA = 0.10;

/**
 * track id가 현재 active 목록에 포함되는지 확인한다.
 * - 인수 : activeTrackIds : 현재 active track id 목록
 * - 인수 : trackId : 확인할 track id
 * - 반환값 : active 여부
 */
export function isTrackActive(
  activeTrackIds: readonly TrackId[],
  trackId: TrackId | string | undefined,
): boolean {
  if (trackId === undefined || !isTrackId(trackId)) {
    return false;
  }

  return activeTrackIds.includes(trackId);
}

/**
 * track id에 적용할 renderer alpha를 반환한다.
 * - 인수 : activeTrackIds : 현재 active track id 목록
 * - 인수 : trackId : 표시할 item의 track id
 * - 반환값 : 정상 opacity 또는 inactive alpha
 */
export function getTrackRenderAlpha(
  activeTrackIds: readonly TrackId[],
  trackId: TrackId | string | undefined,
): number {
  return isTrackActive(activeTrackIds, trackId) ? 1 : INACTIVE_TRACK_ALPHA;
}

/**
 * track id에 적용할 audio gain을 반환한다.
 * - 인수 : trackId : 재생할 track id
 * - 반환값 : 첫 구현의 track별 gain
 */
export function getTrackGain(trackId: TrackId): number {
  if (!TRACK_IDS.includes(trackId)) {
    return 1;
  }

  return 1;
}

/**
 * 분석 결과에서 active track result만 반환한다.
 * - 인수 : analysis : analyzer 결과
 * - 인수 : activeTrackIds : 현재 active track id 목록
 * - 반환값 : active track에 해당하는 분석 결과 목록
 */
export function filterActiveTrackResults(
  analysis: AnalysisResult,
  activeTrackIds: readonly TrackId[],
): AnalyzedTrackResult[] {
  const activeSet = new Set(activeTrackIds);

  return analysis.trackResults.filter((trackResult) => activeSet.has(trackResult.trackId));
}

/**
 * canvas draw order에서 track의 우선순위를 반환한다.
 * - 인수 : trackId : 정렬할 track id
 * - 반환값 : 낮을수록 먼저 그릴 순서
 */
export function getTrackDrawOrder(trackId: TrackId | string | undefined): number {
  if (trackId === undefined || !isTrackId(trackId)) {
    return TRACK_DRAW_ORDER.length;
  }

  const index = TRACK_DRAW_ORDER.indexOf(trackId);

  return index === -1 ? TRACK_DRAW_ORDER.length : index;
}

/**
 * 문자열이 지원하는 track id인지 확인한다.
 * - 인수 : value : 검사할 문자열
 * - 반환값 : TrackId 여부
 */
export function isTrackId(value: string): value is TrackId {
  return TRACK_IDS.includes(value as TrackId);
}
