/**
 * playback 상태를 DOM seek/control 표시와 score scroll 위치에 반영하는 UI helper이다.
 */

import type { AppDom, AppState } from "../app_types";
import { syncLayoutScroll, syncTrackToggleButtons } from "../app_ui_sync";
import { isGameModeLocked } from "../game/game_types";
import { columnToX, xToColumn } from "../../renderer/canvas_coordinate";
import { numberToTimeFraction } from "../../audio/tick_time_mapper";
import type { AppPlaybackRuntime } from "./app_playback";
import { measurePerf } from "../../infra/perf_profiler";

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
  let left = 0;
  let right = segments.length - 1;
  let segment = fallbackSegment;

  // timing timeline은 tick 오름차순이므로 재생 중 반복 조회를 이진 탐색으로 처리한다.
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const candidate = segments[mid];

    if (candidate === undefined) {
      break;
    }

    const startTick = candidate.time.startTick.numerator / candidate.time.startTick.denominator;
    const endTick = candidate.time.endTick.numerator / candidate.time.endTick.denominator;

    if (tick < startTick) {
      right = mid - 1;
    } else if (tick >= endTick) {
      left = mid + 1;
    } else {
      segment = candidate;
      break;
    }
  }

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
  const tick = measurePerf("seekUi.tempo.secondsToTick", () =>
    playbackRuntime.timeMapper.secondsToTick(scoreSeconds)
  );
  const tickNumber = tick.numerator / tick.denominator;
  const bpm = measurePerf("seekUi.tempo.resolveBpmAtTick", () =>
    resolveBpmAtTick(state, tickNumber)
  );
  const bpmText = bpm === null
    ? "--"
    : bpm.toFixed(Number.isInteger(bpm) ? 0 : 1);
  const text = `BPM: ${bpmText}`;

  measurePerf("seekUi.tempo.writeDom", () => {
    setTextIfChanged(dom.tempoStatus, text);
    setTitleIfChanged(dom.tempoStatus, text);
  });
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
  const durationSeconds = measurePerf("seekUi.getDurationSeconds", () =>
    playbackRuntime.timeMapper.getDurationSeconds()
  );
  const clampedSeconds = Math.min(Math.max(scoreSeconds, 0), Math.max(0, durationSeconds));
  const maxText = measurePerf("seekUi.formatMax", () => formatSeekInputSeconds(durationSeconds));
  const valueText = measurePerf("seekUi.formatValue", () => formatSeekInputSeconds(clampedSeconds));
  const currentText = measurePerf("seekUi.formatCurrentClock", () =>
    formatPlaybackClock(clampedSeconds)
  );
  const durationText = measurePerf("seekUi.formatDurationClock", () =>
    formatPlaybackClock(durationSeconds)
  );

  measurePerf("seekUi.writeRangeInput", () => {
    if (dom.seekInput.max !== maxText) {
      dom.seekInput.max = maxText;
    }
    if (dom.seekInput.value !== valueText) {
      dom.seekInput.value = valueText;
    }
  });
  measurePerf("seekUi.writeClockLabels", () => {
    setTextIfChanged(dom.seekCurrentLabel, currentText);
    setTextIfChanged(dom.seekDurationLabel, durationText);
  });
  measurePerf("seekUi.syncTempoStatus", () =>
    syncTempoStatus(dom, state, playbackRuntime, clampedSeconds)
  );
}

/**
 * textContent가 바뀔 때만 DOM text를 갱신한다.
 * - 인수 : element : 갱신할 DOM 요소
 * - 인수 : text : 다음 표시 문자열
 * - 반환값 : 없음
 */
function setTextIfChanged(element: HTMLElement, text: string): void {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

/**
 * title이 바뀔 때만 DOM title을 갱신한다.
 * - 인수 : element : 갱신할 DOM 요소
 * - 인수 : text : 다음 title 문자열
 * - 반환값 : 없음
 */
function setTitleIfChanged(element: HTMLElement, text: string): void {
  if (element.title !== text) {
    element.title = text;
  }
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
  dom.seekInput.disabled = state.busy.kind !== "idle" || isGameModeLocked(state.gameMode);
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

  const currentTick = measurePerf("scrollToSeconds.secondsToTick", () =>
    playbackRuntime.timeMapper.secondsToTick(scoreSeconds)
  );
  const currentTickNumber = currentTick.numerator / currentTick.denominator;
  const nextScrollLeft = measurePerf("scrollToSeconds.columnToX", () =>
    columnToX(currentTickNumber, state.layout!)
  );

  measurePerf("scrollToSeconds.writeScoreScrollLeft", () => {
    if (Math.abs(dom.scoreArea.scrollLeft - nextScrollLeft) >= 0.5) {
      dom.scoreArea.scrollLeft = nextScrollLeft;
    }
  });
  measurePerf("scrollToSeconds.syncLayoutScroll", () =>
    syncLayoutScroll(dom.scoreArea, dom.layoutStage)
  );
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
