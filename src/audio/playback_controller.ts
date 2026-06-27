/**
 * src/audio/playback_controller.ts
 * audio schedule, scheduler, backend를 묶어 play from start와 stop을 제어한다.
 */

import type {
  AudioBackend,
  AudioLookaheadScheduler,
  AudioSchedule,
  PlaybackLoopState,
  PlaybackState,
} from "./audio_types";
import {
  beginPerfSession,
  endPerfSession,
  hasActivePerfSession,
  measurePerf,
  measurePerfAsync,
} from "../infra/perf_profiler";

/** playback controller 생성 입력. */
export type PlaybackControllerInput = {
  schedule: AudioSchedule;
  scheduler: AudioLookaheadScheduler;
  backend: AudioBackend;
  schedulerIntervalMs: number;
};

/** UI/app 계층이 사용할 playback controller 계약. */
export type PlaybackController = {
  playFromStart(loop?: PlaybackLoopState): Promise<void>;
  playFromSeconds(scoreSeconds: number, loop?: PlaybackLoopState): Promise<void>;
  pause(): void;
  pauseAtSeconds(scoreSeconds: number, loop?: PlaybackLoopState): void;
  resume(): Promise<void>;
  seekToSeconds(scoreSeconds: number, loop?: PlaybackLoopState): Promise<void>;
  stop(): void;
  getState(): PlaybackState;
  getCurrentScoreSeconds(): number;
  isPlaying(): boolean;
  dispose(): void;
};

const LOOP_OFF = { enabled: false } as const;

/**
 * play from start와 stop을 지원하는 첫 playback controller를 만든다.
 * - 인수 : input : schedule, scheduler, backend, interval 설정
 * - 반환값 : PlaybackController : app에서 호출할 재생 제어 객체
 */
export function createPlaybackController(
  input: PlaybackControllerInput,
): PlaybackController {
  validateSchedulerInterval(input.schedulerIntervalMs);

  let state: PlaybackState = {
    kind: "stopped",
    seekScoreSeconds: 0,
    loop: LOOP_OFF,
  };
  let intervalId: ReturnType<typeof setInterval> | null = null;

  return {
    async playFromStart(loop: PlaybackLoopState = LOOP_OFF): Promise<void> {
      await this.playFromSeconds(0, loop);
    },
    async playFromSeconds(
      scoreSeconds: number,
      loop: PlaybackLoopState = LOOP_OFF,
    ): Promise<void> {
      measurePerf("playbackController.play.stopInterval", () => stopInterval());
      measurePerf("playbackController.play.backendStopAll", () => input.backend.stopAll());
      measurePerf("playbackController.play.resetScheduledEvents", () =>
        input.scheduler.resetScheduledEvents()
      );
      await measurePerfAsync("playbackController.play.ensureStarted", () =>
        input.backend.ensureStarted()
      );

      const normalizedLoop = measurePerf("playbackController.play.normalizeLoop", () =>
        normalizeLoop(loop, input.schedule.durationSeconds)
      );
      state = {
        kind: "playing",
        audioStartedAt: input.backend.getCurrentTime(),
        scoreStartedAt: normalizeStartScoreSeconds(
          scoreSeconds,
          normalizedLoop,
          input.schedule.durationSeconds,
        ),
        loop: normalizedLoop,
      };
      measurePerf("playbackController.play.initialLookahead", () => scheduleCurrentLookahead());
      intervalId = measurePerf("playbackController.play.startInterval", () =>
        setInterval(
          scheduleCurrentLookahead,
          input.schedulerIntervalMs,
        )
      );
    },
    pause(): void {
      if (state.kind !== "playing") {
        return;
      }

      const pausedAtScoreSeconds = getPlayingScoreSeconds(state);

      stopInterval();
      input.backend.stopAll();
      input.scheduler.resetScheduledEvents();
      state = {
        kind: "paused",
        pausedAtScoreSeconds,
        loop: state.loop,
      };
    },
    pauseAtSeconds(
      scoreSeconds: number,
      loop: PlaybackLoopState = LOOP_OFF,
    ): void {
      measurePerf("playbackController.pauseAt.stopInterval", () => stopInterval());
      measurePerf("playbackController.pauseAt.backendStopAll", () => input.backend.stopAll());
      measurePerf("playbackController.pauseAt.resetScheduledEvents", () =>
        input.scheduler.resetScheduledEvents()
      );
      const normalizedLoop = measurePerf("playbackController.pauseAt.normalizeLoop", () =>
        normalizeLoop(loop, input.schedule.durationSeconds)
      );
      state = {
        kind: "paused",
        pausedAtScoreSeconds: normalizeStartScoreSeconds(
          scoreSeconds,
          normalizedLoop,
          input.schedule.durationSeconds,
        ),
        loop: normalizedLoop,
      };
    },
    async resume(): Promise<void> {
      if (state.kind !== "paused") {
        return;
      }

      await this.playFromSeconds(state.pausedAtScoreSeconds, state.loop);
    },
    async seekToSeconds(
      scoreSeconds: number,
      loop: PlaybackLoopState = state.loop,
    ): Promise<void> {
      const normalizedLoop = measurePerf("playbackController.seek.normalizeLoop", () =>
        normalizeLoop(loop, input.schedule.durationSeconds)
      );
      const nextScoreSeconds = normalizeStartScoreSeconds(
        scoreSeconds,
        normalizedLoop,
        input.schedule.durationSeconds,
      );

      if (state.kind === "playing") {
        await this.playFromSeconds(nextScoreSeconds, normalizedLoop);
        return;
      }

      measurePerf("playbackController.seek.stopInterval", () => stopInterval());
      measurePerf("playbackController.seek.backendStopAll", () => input.backend.stopAll());
      measurePerf("playbackController.seek.resetScheduledEvents", () =>
        input.scheduler.resetScheduledEvents()
      );
      state = state.kind === "paused"
        ? {
            kind: "paused",
            pausedAtScoreSeconds: nextScoreSeconds,
            loop: normalizedLoop,
          }
        : {
            kind: "stopped",
            seekScoreSeconds: nextScoreSeconds,
            loop: normalizedLoop,
          };
    },
    stop(): void {
      stopInterval();
      input.backend.stopAll();
      input.scheduler.resetScheduledEvents();
      state = {
        kind: "stopped",
        seekScoreSeconds: 0,
        loop: LOOP_OFF,
      };
    },
    getState(): PlaybackState {
      return state;
    },
    getCurrentScoreSeconds(): number {
      if (state.kind !== "playing") {
        return state.kind === "paused" ? state.pausedAtScoreSeconds : state.seekScoreSeconds;
      }

      return getPlayingScoreSeconds(state);
    },
    isPlaying(): boolean {
      return state.kind === "playing";
    },
    dispose(): void {
      stopInterval();
      input.backend.dispose();
      state = {
        kind: "stopped",
        seekScoreSeconds: 0,
        loop: LOOP_OFF,
      };
    },
  };

  /**
   * 현재 score time 기준 lookahead 예약을 수행한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function scheduleCurrentLookahead(): void {
    const perfSession = hasActivePerfSession()
      ? null
      : beginPerfSession("playback.interval.lookahead");

    try {
    if (state.kind !== "playing") {
      return;
    }

    const playingTime = measurePerf("playbackController.lookahead.getPlayingTime", () =>
      getPlayingTime(state as Extract<PlaybackState, { kind: "playing" }>)
    );
    const currentScoreSeconds = playingTime.scoreSeconds;

    measurePerf("playbackController.lookahead.scheduleLookahead", () =>
      input.scheduler.scheduleLookahead(
        currentScoreSeconds,
        state.kind === "playing" ? state.loop : LOOP_OFF,
        playingTime.loopCycleIndex,
      )
    );

    if (!state.loop.enabled && currentScoreSeconds >= input.schedule.durationSeconds) {
      stopInterval();
      state = {
        kind: "stopped",
        seekScoreSeconds: 0,
        loop: LOOP_OFF,
      };
    }
    } finally {
      endPerfSession(perfSession, { minTotalMs: 2 });
    }
  }

  /**
   * scheduler interval을 중지한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function stopInterval(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  /**
   * playing 상태의 현재 score time을 계산한다.
   * - 인수 : playingState : 현재 playing 상태
   * - 반환값 : 재생 범위로 제한된 현재 score seconds
   */
  function getPlayingScoreSeconds(
    playingState: Extract<PlaybackState, { kind: "playing" }>,
  ): number {
    return getPlayingTime(playingState).scoreSeconds;
  }

  /**
   * playing 상태의 raw 경과 시간에서 loop wrap이 반영된 score time과 cycle index를 계산한다.
   * - 인수 : playingState : 현재 playing 상태
   * - 반환값 : scheduler와 UI가 사용할 score time 및 loop 반복 번호
   */
  function getPlayingTime(
    playingState: Extract<PlaybackState, { kind: "playing" }>,
  ): { scoreSeconds: number; loopCycleIndex: number } {
    const rawScoreSeconds = playingState.scoreStartedAt +
      input.backend.getCurrentTime() -
      playingState.audioStartedAt;

    if (!playingState.loop.enabled) {
      return {
        scoreSeconds: clampScoreSeconds(rawScoreSeconds, input.schedule.durationSeconds),
        loopCycleIndex: 0,
      };
    }

    const loopDuration = playingState.loop.endSeconds - playingState.loop.startSeconds;
    const elapsedInLoop = Math.max(0, rawScoreSeconds - playingState.loop.startSeconds);
    const loopCycleIndex = Math.floor(elapsedInLoop / loopDuration);
    const wrappedOffset = elapsedInLoop - loopCycleIndex * loopDuration;

    return {
      scoreSeconds: playingState.loop.startSeconds + wrappedOffset,
      loopCycleIndex,
    };
  }
}

/**
 * scheduler interval이 유효한 양수인지 확인한다.
 * - 인수 : schedulerIntervalMs : setInterval 주기
 * - 반환값 : 없음
 */
function validateSchedulerInterval(schedulerIntervalMs: number): void {
  if (!Number.isFinite(schedulerIntervalMs) || schedulerIntervalMs <= 0) {
    throw new Error("schedulerIntervalMs must be a positive finite number.");
  }
}

/**
 * score seconds를 재생 가능 범위로 제한한다.
 * - 인수 : seconds : 현재 score seconds
 * - 인수 : durationSeconds : schedule 전체 길이
 * - 반환값 : 0..durationSeconds 범위의 seconds
 */
function clampScoreSeconds(seconds: number, durationSeconds: number): number {
  if (!Number.isFinite(seconds)) {
    return 0;
  }

  return Math.min(Math.max(seconds, 0), Math.max(0, durationSeconds));
}

/**
 * loop 상태를 score 전체 길이 안으로 제한하고 유효하지 않으면 loop off로 바꾼다.
 * - 인수 : loop : 요청된 loop 상태
 * - 인수 : durationSeconds : schedule 전체 길이
 * - 반환값 : playback controller가 보관할 loop 상태
 */
function normalizeLoop(
  loop: PlaybackLoopState,
  durationSeconds: number,
): PlaybackLoopState {
  if (!loop.enabled) {
    return LOOP_OFF;
  }

  const startSeconds = clampScoreSeconds(loop.startSeconds, durationSeconds);
  const endSeconds = clampScoreSeconds(loop.endSeconds, durationSeconds);

  if (endSeconds <= startSeconds) {
    return LOOP_OFF;
  }

  return {
    enabled: true,
    startSeconds,
    endSeconds,
  };
}

/**
 * loop가 켜져 있으면 시작 위치를 loop 범위 안으로 보정한다.
 * - 인수 : scoreSeconds : 요청된 score time
 * - 인수 : loop : 정규화된 loop 상태
 * - 인수 : durationSeconds : schedule 전체 길이
 * - 반환값 : 실제 재생 시작 score time
 */
function normalizeStartScoreSeconds(
  scoreSeconds: number,
  loop: PlaybackLoopState,
  durationSeconds: number,
): number {
  const clampedSeconds = clampScoreSeconds(scoreSeconds, durationSeconds);

  if (!loop.enabled) {
    return clampedSeconds;
  }

  return clampedSeconds >= loop.startSeconds && clampedSeconds < loop.endSeconds
    ? clampedSeconds
    : loop.startSeconds;
}
