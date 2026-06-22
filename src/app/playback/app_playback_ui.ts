/**
 * playback 상태를 DOM seek/control 표시와 score scroll 위치에 반영하는 UI helper이다.
 */

import type { AppDom, AppState } from "../app_types";
import { syncLayoutScroll, syncTrackToggleButtons } from "../app_ui_sync";
import { columnToX, xToColumn } from "../../renderer/canvas_coordinate";
import { numberToTimeFraction } from "../../audio/tick_time_mapper";
import type { AppPlaybackRuntime } from "./app_playback";

/**
 * playback 상태 문자열을 status DOM에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : text : 표시할 playback 상태 문자열
 * - 반환값 : 없음
 */
export function syncPlaybackStatus(dom: AppDom, text: string): void {
  dom.playbackStatus.textContent = text;
  dom.playbackStatus.title = text;
}

/**
 * seek input에 넣을 초 값을 정수 문자열로 정규화한다.
 * - 인수 : seconds : score seconds 값
 * - 반환값 : input value로 사용할 정수 문자열
 */
export function formatSeekInputSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return "0";
  }

  return String(Math.round(seconds));
}

/**
 * score seconds를 mm:ss 표시 문자열로 만든다.
 * - 인수 : seconds : score seconds 값
 * - 반환값 : 사용자에게 표시할 재생 시간 문자열
 */
export function formatPlaybackClock(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

/**
 * 현재 tick 위치에서 timing timeline의 BPM 값을 계산한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : tick : number로 변환된 score tick
 * - 반환값 : 현재 tick의 BPM 또는 timing segment가 없을 때 null
 */
export function resolveBpmAtTick(state: AppState, tick: number): number | null {
  const segments = state.analysis.timingTimeline;
  const fallbackSegment = segments[segments.length - 1];
  const segment = segments.find((candidate) => {
    const startTick = candidate.time.startTick.numerator / candidate.time.startTick.denominator;
    const endTick = candidate.time.endTick.numerator / candidate.time.endTick.denominator;

    return tick >= startTick && tick < endTick;
  }) ?? fallbackSegment;

  if (segment === undefined) {
    return null;
  }

  const startTick = segment.time.startTick.numerator / segment.time.startTick.denominator;
  const endTick = segment.time.endTick.numerator / segment.time.endTick.denominator;

  if (
    segment.bpmCurve !== "linear" ||
    endTick <= startTick ||
    segment.startBpm === segment.endBpm
  ) {
    return segment.startBpm;
  }

  const progress = Math.min(Math.max((tick - startTick) / (endTick - startTick), 0), 1);

  return segment.startBpm + (segment.endBpm - segment.startBpm) * progress;
}

/**
 * 현재 score seconds에 해당하는 BPM 상태 표시를 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : playbackRuntime : seconds/tick 변환기를 포함한 playback runtime
 * - 인수 : scoreSeconds : 표시할 score seconds
 * - 반환값 : 없음
 */
export function syncTempoStatus(
  dom: AppDom,
  state: AppState,
  playbackRuntime: AppPlaybackRuntime,
  scoreSeconds: number,
): void {
  const tick = playbackRuntime.timeMapper.secondsToTick(scoreSeconds);
  const tickNumber = tick.numerator / tick.denominator;
  const bpm = resolveBpmAtTick(state, tickNumber);
  const bpmText = bpm === null
    ? "--"
    : bpm.toFixed(Number.isInteger(bpm) ? 0 : 1);

  dom.tempoStatus.textContent = `BPM: ${bpmText}`;
  dom.tempoStatus.title = `BPM: ${bpmText}`;
}

/**
 * seek range, 현재/전체 시간, BPM 표시를 playback runtime 기준으로 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : playbackRuntime : controller와 time mapper 묶음
 * - 인수 : scoreSeconds : 표시할 score seconds
 * - 반환값 : 없음
 */
export function syncSeekUi(
  dom: AppDom,
  state: AppState,
  playbackRuntime: AppPlaybackRuntime,
  scoreSeconds: number,
): void {
  const durationSeconds = playbackRuntime.timeMapper.getDurationSeconds();
  const clampedSeconds = Math.min(Math.max(scoreSeconds, 0), Math.max(0, durationSeconds));

  dom.seekInput.max = formatSeekInputSeconds(durationSeconds);
  dom.seekInput.value = formatSeekInputSeconds(clampedSeconds);
  dom.seekCurrentLabel.textContent = formatPlaybackClock(clampedSeconds);
  dom.seekDurationLabel.textContent = formatPlaybackClock(durationSeconds);
  syncTempoStatus(dom, state, playbackRuntime, clampedSeconds);
}

/**
 * playback controller 상태를 play button, seek, status DOM에 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : playbackRuntime : controller와 time mapper 묶음
 * - 반환값 : 없음
 */
export function syncPlaybackUi(
  dom: AppDom,
  state: AppState,
  playbackRuntime: AppPlaybackRuntime,
): void {
  const playbackState = playbackRuntime.controller.getState();
  const currentScoreSeconds = playbackRuntime.controller.getCurrentScoreSeconds();

  syncSeekUi(dom, state, playbackRuntime, currentScoreSeconds);
  syncPlaybackStatus(dom, playbackState.kind);
  dom.playButton.textContent = playbackState.kind === "playing" ? "❚❚" : "▶";
  dom.playButton.disabled = state.busy.kind !== "idle" || state.activeTrackIds.length === 0;
  syncTrackToggleButtons(dom, state, playbackState.kind === "playing");
}

/**
 * score seconds가 score area 왼쪽 재생 기준선에 오도록 scroll 위치를 맞춘다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : playbackRuntime : seconds/tick 변환기를 포함한 playback runtime
 * - 인수 : scoreSeconds : 이동할 score seconds
 * - 반환값 : 없음
 */
export function scrollToScoreSeconds(
  dom: AppDom,
  state: AppState,
  playbackRuntime: AppPlaybackRuntime,
  scoreSeconds: number,
): void {
  if (state.layout === null) {
    return;
  }

  const currentTick = playbackRuntime.timeMapper.secondsToTick(scoreSeconds);
  const currentTickNumber = currentTick.numerator / currentTick.denominator;

  dom.scoreArea.scrollLeft = columnToX(currentTickNumber, state.layout);
  syncLayoutScroll(dom.scoreArea, dom.layoutStage);
}

/**
 * score area의 horizontal scroll 위치를 score seconds로 변환한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : playbackRuntime : seconds/tick 변환기를 포함한 playback runtime
 * - 반환값 : scroll 위치에 해당하는 score seconds
 */
export function scrollLeftToScoreSeconds(
  dom: AppDom,
  state: AppState,
  playbackRuntime: AppPlaybackRuntime,
): number {
  if (state.layout === null) {
    return playbackRuntime.controller.getCurrentScoreSeconds();
  }

  const durationSeconds = playbackRuntime.timeMapper.getDurationSeconds();
  const tick = xToColumn(dom.scoreArea.scrollLeft, state.layout);
  const seconds = playbackRuntime.timeMapper.tickToSeconds(numberToTimeFraction(tick));

  return Math.min(Math.max(seconds, 0), Math.max(0, durationSeconds));
}
