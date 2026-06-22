/**
 * playback 버튼, seek input, audio option event를 app playback runtime에 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import { syncLeftStatus } from "../app_ui_sync";
import type { AppPlaybackRuntime } from "./app_playback";
import type { YoutubePlaybackControl } from "../youtube/youtube_binding";
import {
  scrollLeftToScoreSeconds,
  scrollToScoreSeconds,
  syncPlaybackStatus,
  syncPlaybackUi,
  syncSeekUi,
} from "./app_playback_ui";

/** playback binding이 app 상태와 runtime을 조회하기 위한 session 입력. */
export type PlaybackBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  getPlaybackRuntime(): AppPlaybackRuntime;
  youtubeControl?: YoutubePlaybackControl;
  resetPlaybackForCurrentState(): void;
  resetNotePreviewForCurrentDom(): void;
};

/** playback binding이 외부 reset 흐름에 제공하는 control 객체. */
export type PlaybackBindingControl = {
  stopPlaybackAnimation(): void;
};

/**
 * playback 관련 DOM event를 app playback runtime에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 playback runtime callback 묶음
 * - 반환값 : 외부 reset에서 사용할 animation control
 */
export function bindPlaybackControls(
  dom: AppDom,
  session: PlaybackBindingSession,
): PlaybackBindingControl {
  let playbackRafId: number | null = null;
  let scrollSeekRafId: number | null = null;
  let suppressScrollSeek = false;

  const stopPlaybackAnimation = (): void => {
    if (playbackRafId !== null) {
      cancelAnimationFrame(playbackRafId);
      playbackRafId = null;
    }
  };

  const scrollScoreAreaToSeconds = (
    state: AppState,
    playbackRuntime: AppPlaybackRuntime,
    scoreSeconds: number,
  ): void => {
    suppressScrollSeek = true;
    scrollToScoreSeconds(dom, state, playbackRuntime, scoreSeconds);
    requestAnimationFrame(() => {
      suppressScrollSeek = false;
    });
  };

  const pausePlaybackForManualSeek = (
    playbackRuntime: AppPlaybackRuntime,
  ): void => {
    if (!playbackRuntime.controller.isPlaying()) {
      return;
    }

    suppressScrollSeek = false;
    playbackRuntime.controller.pause();
    session.youtubeControl?.pause();
    stopPlaybackAnimation();
  };

  const pausePlaybackForScoreAreaInteraction = (): void => {
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();

    if (state.busy.kind !== "idle") {
      return;
    }

    pausePlaybackForManualSeek(playbackRuntime);
    syncPlaybackUi(dom, state, playbackRuntime);
  };

  const syncSeekFromUserScroll = (): void => {
    const state = session.getState();

    if (
      suppressScrollSeek ||
      state.busy.kind !== "idle" ||
      state.layout === null
    ) {
      return;
    }

    if (scrollSeekRafId !== null) {
      return;
    }

    scrollSeekRafId = requestAnimationFrame(() => {
      scrollSeekRafId = null;

      const nextState = session.getState();
      const nextPlaybackRuntime = session.getPlaybackRuntime();

      if (
        suppressScrollSeek ||
        nextState.busy.kind !== "idle" ||
        nextState.layout === null
      ) {
        return;
      }

      pausePlaybackForManualSeek(nextPlaybackRuntime);

      const scoreSeconds = scrollLeftToScoreSeconds(dom, nextState, nextPlaybackRuntime);

      syncSeekUi(dom, nextState, nextPlaybackRuntime, scoreSeconds);
      nextPlaybackRuntime.controller.seekToSeconds(scoreSeconds)
        .then(() => {
          session.youtubeControl?.seekToCurrentScoreTime();
        })
        .catch((error: unknown) => {
          const currentState = session.getState();
          const message = error instanceof Error ? error.message : "Unknown scroll seek error.";

          session.setState({
            ...currentState,
            statusMessage: {
              level: "error",
              text: message,
            },
          });
          syncPlaybackStatus(dom, "error");
          syncLeftStatus(dom, session.getState());
        });
    });
  };

  const updatePlaybackScroll = (): void => {
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();

    if (!playbackRuntime.controller.isPlaying() || state.layout === null) {
      playbackRafId = null;
      syncPlaybackUi(dom, state, playbackRuntime);
      return;
    }

    const currentScoreSeconds = playbackRuntime.controller.getCurrentScoreSeconds();

    // score canvas의 왼쪽 edge를 재생 기준선으로 두고 현재 tick이 그 위치에 오도록 스크롤한다.
    scrollScoreAreaToSeconds(state, playbackRuntime, currentScoreSeconds);
    syncSeekUi(dom, state, playbackRuntime, currentScoreSeconds);
    playbackRafId = requestAnimationFrame(updatePlaybackScroll);
  };

  dom.scoreArea.addEventListener("scroll", syncSeekFromUserScroll);
  dom.scoreArea.addEventListener("pointerdown", pausePlaybackForScoreAreaInteraction, {
    capture: true,
  });
  dom.scoreArea.addEventListener("wheel", pausePlaybackForScoreAreaInteraction, {
    capture: true,
    passive: true,
  });
  dom.scoreArea.addEventListener("touchstart", pausePlaybackForScoreAreaInteraction, {
    capture: true,
    passive: true,
  });

  dom.playButton.addEventListener("click", () => {
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();

    if (state.busy.kind !== "idle") {
      return;
    }

    const playbackState = playbackRuntime.controller.getState();

    if (playbackState.kind === "playing") {
      playbackRuntime.controller.pause();
      session.youtubeControl?.pause();
      stopPlaybackAnimation();
      syncPlaybackUi(dom, state, playbackRuntime);
      scrollScoreAreaToSeconds(
        state,
        playbackRuntime,
        playbackRuntime.controller.getCurrentScoreSeconds(),
      );
      return;
    }

    const playRequest = playbackState.kind === "paused"
      ? playbackRuntime.controller.resume()
      : playbackRuntime.controller.playFromSeconds(Number(dom.seekInput.value));

    playRequest
      .then(() => {
        const nextState = session.getState();
        const nextPlaybackRuntime = session.getPlaybackRuntime();

        syncPlaybackUi(dom, nextState, nextPlaybackRuntime);
        scrollScoreAreaToSeconds(
          nextState,
          nextPlaybackRuntime,
          nextPlaybackRuntime.controller.getCurrentScoreSeconds(),
        );
        session.youtubeControl?.playAtCurrentScoreTime();
        stopPlaybackAnimation();
        playbackRafId = requestAnimationFrame(updatePlaybackScroll);
      })
      .catch((error: unknown) => {
        const currentState = session.getState();
        const message = error instanceof Error ? error.message : "Unknown playback error.";

        session.setState({
          ...currentState,
          statusMessage: {
            level: "error",
            text: message,
          },
        });
        syncPlaybackStatus(dom, "error");
        syncLeftStatus(dom, session.getState());
      });
  });

  dom.stopButton.addEventListener("click", () => {
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();

    stopPlaybackAnimation();
    playbackRuntime.controller.stop();
    session.youtubeControl?.stop();
    syncPlaybackUi(dom, state, playbackRuntime);
    scrollScoreAreaToSeconds(state, playbackRuntime, 0);
  });

  dom.seekInput.addEventListener("input", () => {
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();
    const scoreSeconds = Number(dom.seekInput.value);

    pausePlaybackForManualSeek(playbackRuntime);
    session.youtubeControl?.pause();
    syncSeekUi(dom, state, playbackRuntime, scoreSeconds);
    scrollScoreAreaToSeconds(state, playbackRuntime, scoreSeconds);
  });

  dom.seekInput.addEventListener("change", () => {
    const scoreSeconds = Number(dom.seekInput.value);
    const playbackRuntime = session.getPlaybackRuntime();

    playbackRuntime.controller.seekToSeconds(scoreSeconds)
      .then(() => {
        const state = session.getState();
        const nextPlaybackRuntime = session.getPlaybackRuntime();

        syncPlaybackUi(dom, state, nextPlaybackRuntime);
        scrollScoreAreaToSeconds(
          state,
          nextPlaybackRuntime,
          nextPlaybackRuntime.controller.getCurrentScoreSeconds(),
        );
        session.youtubeControl?.seekToCurrentScoreTime();
        if (nextPlaybackRuntime.controller.isPlaying()) {
          stopPlaybackAnimation();
          playbackRafId = requestAnimationFrame(updatePlaybackScroll);
        }
      })
      .catch((error: unknown) => {
        const currentState = session.getState();
        const message = error instanceof Error ? error.message : "Unknown seek error.";

        session.setState({
          ...currentState,
          statusMessage: {
            level: "error",
            text: message,
          },
        });
        syncPlaybackStatus(dom, "error");
        syncLeftStatus(dom, session.getState());
      });
  });

  dom.volumeInput.addEventListener("change", () => {
    session.resetPlaybackForCurrentState();
    session.resetNotePreviewForCurrentDom();
  });

  dom.waveSelect.addEventListener("change", () => {
    session.resetPlaybackForCurrentState();
    session.resetNotePreviewForCurrentDom();
  });

  return {
    stopPlaybackAnimation,
  };
}
