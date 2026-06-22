/**
 * score time과 YouTube player time 사이의 변환과 drift 판단을 담당한다.
 */

export const YOUTUBE_DRIFT_THRESHOLD_SECONDS = 0.25;

/**
 * score seconds와 offset ms에서 YouTube seconds를 계산한다.
 * - 인수 : scoreSeconds : playback controller 기준 score seconds
 * - 인수 : offsetMs : score metadata에 저장된 YouTube offset ms
 * - 반환값 : 0 이상으로 제한된 YouTube seconds
 */
export function scoreSecondsToYoutubeSeconds(
  scoreSeconds: number,
  offsetMs: number,
): number {
  const rawSeconds = scoreSeconds + offsetMs / 1000;

  if (!Number.isFinite(rawSeconds)) {
    return 0;
  }

  return Math.max(0, rawSeconds);
}

/**
 * score와 YouTube player 사이의 drift가 재동기화 기준을 넘는지 확인한다.
 * - 인수 : scoreSeconds : playback controller 기준 score seconds
 * - 인수 : youtubeSeconds : YouTube player가 보고한 current time
 * - 인수 : offsetMs : score metadata에 저장된 YouTube offset ms
 * - 반환값 : 재동기화가 필요한지 여부
 */
export function shouldResyncYoutubeDrift(
  scoreSeconds: number,
  youtubeSeconds: number,
  offsetMs: number,
): boolean {
  const expectedSeconds = scoreSecondsToYoutubeSeconds(scoreSeconds, offsetMs);

  return Math.abs(expectedSeconds - youtubeSeconds) > YOUTUBE_DRIFT_THRESHOLD_SECONDS;
}

