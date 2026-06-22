/**
 * src/audio/playback_controller.ts
 * audio schedule, scheduler, backend를 묶어 play from start와 stop을 제어한다.
 */

import type {
  AudioBackend,
  AudioLookaheadScheduler,
  AudioSchedule,
  PlaybackState,
} from "./audio_types";

/** playback controller 생성 입력. */
export type PlaybackControllerInput = {
  schedule: AudioSchedule;
  scheduler: AudioLookaheadScheduler;
  backend: AudioBackend;
  schedulerIntervalMs: number;
};

/** UI/app 계층이 사용할 playback controller 계약. */
export type PlaybackController = {
  playFromStart(): Promise<void>;
  playFromSeconds(scoreSeconds: number): Promise<void>;
  pause(): void;
  pauseAtSeconds(scoreSeconds: number): void;
  resume(): Promise<void>;
  seekToSeconds(scoreSeconds: number): Promise<void>;
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
    async playFromStart(): Promise<void> {
      await this.playFromSeconds(0);
    },
    async playFromSeconds(scoreSeconds: number): Promise<void> {
      stopInterval();
      input.backend.stopAll();
      input.scheduler.resetScheduledEvents();
      await input.backend.ensureStarted();

      state = {
        kind: "playing",
        audioStartedAt: input.backend.getCurrentTime(),
        scoreStartedAt: clampScoreSeconds(scoreSeconds, input.schedule.durationSeconds),
        loop: LOOP_OFF,
      };
      scheduleCurrentLookahead();
      intervalId = setInterval(
        scheduleCurrentLookahead,
        input.schedulerIntervalMs,
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
    pauseAtSeconds(scoreSeconds: number): void {
      stopInterval();
      input.backend.stopAll();
      input.scheduler.resetScheduledEvents();
      state = {
        kind: "paused",
        pausedAtScoreSeconds: clampScoreSeconds(scoreSeconds, input.schedule.durationSeconds),
        loop: LOOP_OFF,
      };
    },
    async resume(): Promise<void> {
      if (state.kind !== "paused") {
        return;
      }

      await this.playFromSeconds(state.pausedAtScoreSeconds);
    },
    async seekToSeconds(scoreSeconds: number): Promise<void> {
      const nextScoreSeconds = clampScoreSeconds(scoreSeconds, input.schedule.durationSeconds);

      if (state.kind === "playing") {
        await this.playFromSeconds(nextScoreSeconds);
        return;
      }

      stopInterval();
      input.backend.stopAll();
      input.scheduler.resetScheduledEvents();
      state = state.kind === "paused"
        ? {
            kind: "paused",
            pausedAtScoreSeconds: nextScoreSeconds,
            loop: state.loop,
          }
        : {
            kind: "stopped",
            seekScoreSeconds: nextScoreSeconds,
            loop: LOOP_OFF,
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
    if (state.kind !== "playing") {
      return;
    }

    const currentScoreSeconds = clampScoreSeconds(
      getPlayingScoreSeconds(state),
      input.schedule.durationSeconds,
    );

    input.scheduler.scheduleLookahead(currentScoreSeconds, state.loop);

    if (currentScoreSeconds >= input.schedule.durationSeconds) {
      stopInterval();
      state = {
        kind: "stopped",
        seekScoreSeconds: 0,
        loop: LOOP_OFF,
      };
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
    return clampScoreSeconds(
      playingState.scoreStartedAt + input.backend.getCurrentTime() - playingState.audioStartedAt,
      input.schedule.durationSeconds,
    );
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
