/**
 * score time과 YouTube player time 사이의 변환과 drift 판단을 담당한다.
 */

export const YOUTUBE_DRIFT_THRESHOLD_SECONDS = 0.25;

/**
 * 곡과 브라우저 보정을 합산한다. 합계에는 ScoreFile 범위를 다시 적용하지 않는다.
 * - 인수 : scoreOffsetMs : 저장된 곡 offset
 * - 인수 : localOffsetMs : 정규화된 브라우저 offset
 * - 반환값 : YouTube 시간 계산에 사용할 합산 ms
 */
export function getEffectiveYoutubeOffsetMs(scoreOffsetMs: number, localOffsetMs: number): number {
  return scoreOffsetMs + localOffsetMs;
}

/**
 * 일시정지 재개 시 영상 위치가 이미 맞아 불필요한 seek를 생략할 수 있는지 확인한다.
 * - 인수 : resumeFromPause : 기존 일시정지 위치에서 재개하는지 여부
 * - 인수 : scoreSeconds : 보정되지 않은 controller 재생 시간
 * - 인수 : youtubeSeconds : 영상이 보고한 현재 시간
 * - 인수 : offsetMs : 곡 offset과 Local offset을 합산한 ms
 * - 반환값 : 영상 시작 이후이며 위치 차이가 50ms 이내인 일시정지 재개이면 true
 */
export function canResumeYoutubeWithoutSeek(
  resumeFromPause: boolean,
  scoreSeconds: number,
  youtubeSeconds: number,
  offsetMs: number,
): boolean {
  // Display offset은 이 경계에 전달하지 않는다. 영상 시작 전 구간은 기존 예약 시작 경로를 따른다.
  return resumeFromPause && Number.isFinite(scoreSeconds) && Number.isFinite(youtubeSeconds) &&
    Number.isFinite(offsetMs) && !isYoutubeBeforeVideoStart(scoreSeconds, offsetMs) &&
    Math.abs(scoreSecondsToYoutubeSeconds(scoreSeconds, offsetMs) - youtubeSeconds) <= 0.05;
}

/**
 * score seconds와 offset ms에서 clamp 전 YouTube seconds를 계산한다.
 * - 인수 : scoreSeconds : playback controller 기준 score seconds
 * - 인수 : offsetMs : 곡 offset과 Local offset을 합산한 ms
 * - 반환값 : offset이 반영된 원본 YouTube seconds
 */
export function scoreSecondsToRawYoutubeSeconds(
  scoreSeconds: number,
  offsetMs: number,
): number {
  const rawSeconds = scoreSeconds - offsetMs / 1000;

  return Number.isFinite(rawSeconds) ? rawSeconds : 0;
}

/**
 * score seconds와 offset ms에서 YouTube seconds를 계산한다.
 * - 인수 : scoreSeconds : playback controller 기준 score seconds
 * - 인수 : offsetMs : 곡 offset과 Local offset을 합산한 ms
 * - 반환값 : 0 이상으로 제한된 YouTube seconds
 */
export function scoreSecondsToYoutubeSeconds(
  scoreSeconds: number,
  offsetMs: number,
): number {
  const rawSeconds = scoreSecondsToRawYoutubeSeconds(scoreSeconds, offsetMs);

  return Math.max(0, rawSeconds);
}

/**
 * 현재 score time이 YouTube 영상 시작 전 구간인지 확인한다.
 * - 인수 : scoreSeconds : playback controller 기준 score seconds
 * - 인수 : offsetMs : 곡 offset과 Local offset을 합산한 ms
 * - 반환값 : YouTube seconds가 0보다 작은지 여부
 */
export function isYoutubeBeforeVideoStart(
  scoreSeconds: number,
  offsetMs: number,
): boolean {
  return scoreSecondsToRawYoutubeSeconds(scoreSeconds, offsetMs) < 0;
}

/**
 * score time 기준으로 YouTube 영상 시작까지 남은 시간을 계산한다.
 * - 인수 : scoreSeconds : playback controller 기준 score seconds
 * - 인수 : offsetMs : 곡 offset과 Local offset을 합산한 ms
 * - 반환값 : 영상 0초를 재생하기 전까지 기다릴 seconds
 */
export function secondsUntilYoutubeStart(
  scoreSeconds: number,
  offsetMs: number,
): number {
  const rawSeconds = scoreSecondsToRawYoutubeSeconds(scoreSeconds, offsetMs);

  return Math.max(0, -rawSeconds);
}

/**
 * score와 YouTube player 사이의 drift가 재동기화 기준을 넘는지 확인한다.
 * - 인수 : scoreSeconds : playback controller 기준 score seconds
 * - 인수 : youtubeSeconds : YouTube player가 보고한 current time
 * - 인수 : offsetMs : 곡 offset과 Local offset을 합산한 ms
 * - 반환값 : 재동기화가 필요한지 여부
 */
export function shouldResyncYoutubeDrift(
  scoreSeconds: number,
  youtubeSeconds: number,
  offsetMs: number,
): boolean {
  if (isYoutubeBeforeVideoStart(scoreSeconds, offsetMs)) {
    return false;
  }

  const expectedSeconds = scoreSecondsToYoutubeSeconds(scoreSeconds, offsetMs);

  return Math.abs(expectedSeconds - youtubeSeconds) > YOUTUBE_DRIFT_THRESHOLD_SECONDS;
}
