/**
 * YouTube 패널 DOM과 playback runtime을 연결한다.
 */

import type { AppPlaybackRuntime } from "../playback/app_playback";
import type {
  AppDom,
  AppState,
} from "../app_types";
import { syncLeftStatus } from "../app_ui_sync";
import { applyYoutubeSyncEditToState } from "../app_runtime";
import { readIntegerInput } from "../app_view_actions";
import { createYoutubePlayer } from "./youtube_player";
import {
  scoreSecondsToYoutubeSeconds,
  shouldResyncYoutubeDrift,
} from "./youtube_sync";
import type {
  YoutubeModeState,
  YoutubePlayerHandle,
  YoutubeSyncInput,
} from "./youtube_types";
import { parseYoutubeVideoId } from "./youtube_url";

const DRIFT_CHECK_INTERVAL_MS = 1000;

/** YouTube binding이 app 상태와 playback runtime을 조회하기 위한 session 입력. */
export type YoutubeBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  render(): void;
  getPlaybackRuntime(): AppPlaybackRuntime;
};

/** playback binding이 호출할 YouTube 동기화 control 객체. */
export type YoutubePlaybackControl = {
  syncInputsFromScore(): void;
  playAtCurrentScoreTime(): void;
  pause(): void;
  stop(): void;
  seekToCurrentScoreTime(): void;
  dispose(): void;
};

/**
 * YouTube 패널 입력과 playback follower 동작을 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 playback runtime callback 묶음
 * - 반환값 : playback binding에서 호출할 YouTube 동기화 control
 */
export function bindYoutubeControls(
  dom: AppDom,
  session: YoutubeBindingSession,
): YoutubePlaybackControl {
  let modeState: YoutubeModeState = { kind: "off" };
  let player: YoutubePlayerHandle | null = null;
  let driftIntervalId: ReturnType<typeof setInterval> | null = null;

  const fillInputsFromScore = (): void => {
    const youtube = session.getState().document.score.musicData.youtube;

    dom.youtubeVideoInput.value = youtube.videoId;
    dom.youtubeOffsetInput.value = String(youtube.offsetMs);
  };

  const syncInputsFromScore = (): void => {
    stopDriftCheck();
    player?.dispose();
    player = null;
    dom.youtubeToggle.checked = false;
    fillInputsFromScore();
    syncYoutubeStatus("No video", "off");
    modeState = { kind: "off" };
  };

  const setYoutubeModeOff = (message: string, level: "off" | "error" = "off"): void => {
    stopDriftCheck();
    player?.pause();
    dom.youtubeToggle.checked = false;
    modeState = level === "error" ? { kind: "error", message } : { kind: "off" };
    syncYoutubeStatus(message, level);
  };

  const loadSavedVideo = async (): Promise<boolean> => {
    const youtube = session.getState().document.score.musicData.youtube;

    if (youtube.videoId.trim().length === 0) {
      setYoutubeModeOff("No video", "error");
      return false;
    }

    modeState = {
      kind: "loading",
      videoId: youtube.videoId,
      offsetMs: youtube.offsetMs,
    };
    syncYoutubeStatus("Loading", "loading");

    try {
      if (player === null) {
        player = await createYoutubePlayer(dom.youtubePlayer, (message) => {
          setYoutubeModeOff(message, "error");
        });
      }

      const scoreSeconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();
      const youtubeSeconds = scoreSecondsToYoutubeSeconds(scoreSeconds, youtube.offsetMs);

      await player.loadVideo(youtube.videoId, youtubeSeconds);
      modeState = {
        kind: "ready",
        videoId: youtube.videoId,
        offsetMs: youtube.offsetMs,
      };
      syncYoutubeStatus("Ready", "ready");
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown YouTube load error.";

      setYoutubeModeOff(message, "error");
      return false;
    }
  };

  const reloadFromInputs = async (): Promise<void> => {
    const parsedInput = readYoutubeInputs(dom, session.getState());

    if (parsedInput === null) {
      setAppStatus("Invalid YouTube URL or ID.", "error");
      syncYoutubeStatus("Invalid video", "error");
      return;
    }

    session.setState(applyYoutubeSyncEditToState(
      session.getState(),
      parsedInput.videoId,
      parsedInput.offsetMs,
    ));
    syncLeftStatus(dom, session.getState());
    session.render();

    if (parsedInput.videoId.length === 0) {
      setYoutubeModeOff("No video");
      return;
    }

    dom.youtubeToggle.checked = true;
    const loaded = await loadSavedVideo();

    if (!loaded) {
      return;
    }

    if (session.getPlaybackRuntime().controller.isPlaying()) {
      player?.play();
      startDriftCheck();
      return;
    }

    player?.pause();
  };

  dom.youtubeToggle.addEventListener("change", () => {
    if (!dom.youtubeToggle.checked) {
      setYoutubeModeOff("Off");
      return;
    }

    fillInputsFromScore();
    loadSavedVideo()
      .then((loaded) => {
        if (!loaded) {
          return;
        }

        if (session.getPlaybackRuntime().controller.isPlaying()) {
          player?.play();
          startDriftCheck();
          return;
        }

        player?.pause();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown YouTube error.";

        setYoutubeModeOff(message, "error");
      });
  });

  dom.youtubeReloadButton.addEventListener("click", () => {
    reloadFromInputs().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown YouTube reload error.";

      setYoutubeModeOff(message, "error");
    });
  });

  syncInputsFromScore();

  return {
    syncInputsFromScore,
    playAtCurrentScoreTime(): void {
      if (!dom.youtubeToggle.checked || player === null || modeState.kind !== "ready") {
        return;
      }

      syncPlayerToCurrentScoreTime();
      player.play();
      startDriftCheck();
    },
    pause(): void {
      stopDriftCheck();
      player?.pause();
    },
    stop(): void {
      stopDriftCheck();
      syncPlayerToScoreSeconds(0);
      player?.pause();
    },
    seekToCurrentScoreTime(): void {
      if (!dom.youtubeToggle.checked || player === null || modeState.kind !== "ready") {
        return;
      }

      syncPlayerToCurrentScoreTime();
    },
    dispose(): void {
      stopDriftCheck();
      player?.dispose();
      player = null;
      dom.youtubeToggle.checked = false;
      modeState = { kind: "off" };
      syncYoutubeStatus("Off", "off");
    },
  };

  /**
   * YouTube 상태 문구와 player shell 표시를 갱신한다.
   * - 인수 : text : 사용자에게 보여줄 짧은 상태 문구
   * - 인수 : level : 상태 종류
   * - 반환값 : 없음
   */
  function syncYoutubeStatus(
    text: string,
    level: "off" | "loading" | "ready" | "error",
  ): void {
    dom.youtubeStatus.textContent = text;
    dom.youtubeStatus.title = text;
    dom.youtubeStatus.dataset.level = level;
    dom.youtubePlayerShell.dataset.state = level;
  }

  /**
   * 현재 score time 기준으로 YouTube player를 seek한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function syncPlayerToCurrentScoreTime(): void {
    const scoreSeconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();

    syncPlayerToScoreSeconds(scoreSeconds);
  }

  /**
   * 지정한 score time 기준으로 YouTube player를 seek한다.
   * - 인수 : scoreSeconds : 기준 score seconds
   * - 반환값 : 없음
   */
  function syncPlayerToScoreSeconds(scoreSeconds: number): void {
    const youtube = session.getState().document.score.musicData.youtube;

    player?.seekTo(scoreSecondsToYoutubeSeconds(scoreSeconds, youtube.offsetMs));
  }

  /**
   * 재생 중 drift를 주기적으로 확인한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function startDriftCheck(): void {
    stopDriftCheck();
    driftIntervalId = setInterval(() => {
      if (player === null || !session.getPlaybackRuntime().controller.isPlaying()) {
        stopDriftCheck();
        return;
      }

      const youtube = session.getState().document.score.musicData.youtube;
      const scoreSeconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();

      if (shouldResyncYoutubeDrift(scoreSeconds, player.getCurrentTime(), youtube.offsetMs)) {
        syncPlayerToScoreSeconds(scoreSeconds);
      }
    }, DRIFT_CHECK_INTERVAL_MS);
  }

  /**
   * drift 확인 interval을 중지한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function stopDriftCheck(): void {
    if (driftIntervalId !== null) {
      clearInterval(driftIntervalId);
      driftIntervalId = null;
    }
  }

  /**
   * 왼쪽 status line에 YouTube 조작 결과를 표시한다.
   * - 인수 : text : 표시할 메시지
   * - 인수 : level : 메시지 수준
   * - 반환값 : 없음
   */
  function setAppStatus(text: string, level: AppState["statusMessage"]["level"]): void {
    const state = session.getState();

    session.setState({
      ...state,
      statusMessage: {
        level,
        text,
      },
    });
    syncLeftStatus(dom, session.getState());
  }
}

/**
 * YouTube 패널 입력값을 저장 가능한 값으로 읽는다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : fallback을 제공할 현재 app 상태
 * - 반환값 : 저장 가능한 YouTube 입력. 잘못된 URL이면 null
 */
function readYoutubeInputs(dom: AppDom, state: AppState): YoutubeSyncInput | null {
  const rawVideoInput = dom.youtubeVideoInput.value.trim();
  const offsetMs = readIntegerInput(
    dom.youtubeOffsetInput,
    state.document.score.musicData.youtube.offsetMs,
  );

  if (rawVideoInput.length === 0) {
    return {
      videoId: "",
      offsetMs,
    };
  }

  const videoId = parseYoutubeVideoId(rawVideoInput);

  if (videoId === null) {
    return null;
  }

  return {
    videoId,
    offsetMs,
  };
}
