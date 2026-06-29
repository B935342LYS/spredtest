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
import {
  clampYoutubeOffsetMs,
  MAX_YOUTUBE_OFFSET_MS,
  MIN_YOUTUBE_OFFSET_MS,
  YOUTUBE_OFFSET_STEP_MS,
} from "../../core/score/score_limits";
import { createYoutubePlayer } from "./youtube_player";
import {
  isYoutubeBeforeVideoStart,
  scoreSecondsToYoutubeSeconds,
  secondsUntilYoutubeStart,
  shouldResyncYoutubeDrift,
} from "./youtube_sync";
import type {
  YoutubeModeState,
  YoutubePlayerHandle,
  YoutubeSyncInput,
} from "./youtube_types";
import { parseYoutubeVideoId } from "./youtube_url";

const DRIFT_CHECK_INTERVAL_MS = 1000;
const SEEK_COOLDOWN_MS = 500;

type YoutubeSeekOptions = {
  forceSeek?: boolean;
};

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
  let videoStartTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let isBeforeVideoStart = false;
  let lastSeekAtMs = 0;

  syncYoutubeOffsetInputBounds();

  const fillInputsFromScore = (): void => {
    const youtube = session.getState().document.score.musicData.youtube;

    dom.youtubeVideoInput.value = youtube.videoId;
    dom.youtubeOffsetInput.value = String(youtube.offsetMs);
  };

  const syncInputsFromScore = (): void => {
    stopDriftCheck();
    clearVideoStartTimer();
    player?.dispose();
    player = null;
    isBeforeVideoStart = false;
    lastSeekAtMs = 0;
    dom.youtubeToggle.checked = false;
    fillInputsFromScore();
    syncYoutubeStatus("No video", "off");
    modeState = { kind: "off" };
  };

  const setYoutubeModeOff = (message: string, level: "off" | "error" = "off"): void => {
    stopDriftCheck();
    clearVideoStartTimer();
    player?.pause();
    isBeforeVideoStart = false;
    dom.youtubeToggle.checked = false;
    modeState = level === "error" ? { kind: "error", message } : { kind: "off" };
    syncYoutubeStatus(message, level);
  };

  const loadSavedVideo = async (): Promise<boolean> => {
    const youtube = session.getState().document.score.musicData.youtube;
    const safeVideoId = parseYoutubeVideoId(youtube.videoId);

    if (youtube.videoId.trim().length === 0 || safeVideoId === null) {
      setYoutubeModeOff("No video", "error");
      return false;
    }

    modeState = {
      kind: "loading",
      videoId: safeVideoId,
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

      await player.loadVideo(safeVideoId, youtubeSeconds);
      modeState = {
        kind: "ready",
        videoId: safeVideoId,
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
      const canPlayVideo = syncPlayerToCurrentScoreTime({ forceSeek: true });

      if (canPlayVideo) {
        player?.play();
      }

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
          const canPlayVideo = syncPlayerToCurrentScoreTime({ forceSeek: true });

          if (canPlayVideo) {
            player?.play();
          }

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

      const canPlayVideo = syncPlayerToCurrentScoreTime({ forceSeek: true });

      if (canPlayVideo) {
        player.play();
      }

      startDriftCheck();
    },
    pause(): void {
      stopDriftCheck();
      clearVideoStartTimer();
      player?.pause();
    },
    stop(): void {
      stopDriftCheck();
      clearVideoStartTimer();
      syncPlayerToScoreSeconds(0, { forceSeek: true });
      player?.pause();
    },
    seekToCurrentScoreTime(): void {
      if (!dom.youtubeToggle.checked || player === null || modeState.kind !== "ready") {
        return;
      }

      syncPlayerToCurrentScoreTime({ forceSeek: true });
    },
    dispose(): void {
      stopDriftCheck();
      clearVideoStartTimer();
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
  function syncPlayerToCurrentScoreTime(options: YoutubeSeekOptions = {}): boolean {
    const scoreSeconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();

    return syncPlayerToScoreSeconds(scoreSeconds, options);
  }

  /**
   * 지정한 score time 기준으로 YouTube player를 seek한다.
   * - 인수 : scoreSeconds : 기준 score seconds
   * - 인수 : options : 명시적 사용자 seek인지 여부
   * - 반환값 : YouTube 영상을 지금 재생할 수 있는지 여부
   */
  function syncPlayerToScoreSeconds(
    scoreSeconds: number,
    options: YoutubeSeekOptions = {},
  ): boolean {
    const youtube = session.getState().document.score.musicData.youtube;
    const shouldForceSeek = options.forceSeek === true;

    if (player === null) {
      return false;
    }

    // 음수 offset으로 영상 시작 전이면 0초에 한 번만 정렬하고 score playback만 진행한다.
    if (isYoutubeBeforeVideoStart(scoreSeconds, youtube.offsetMs)) {
      if (!isBeforeVideoStart || shouldForceSeek) {
        player.seekTo(0);
        lastSeekAtMs = Date.now();
      }

      player.pause();
      scheduleVideoStartAtBoundary(scoreSeconds, youtube.offsetMs);
      isBeforeVideoStart = true;
      return false;
    }

    const youtubeSeconds = scoreSecondsToYoutubeSeconds(scoreSeconds, youtube.offsetMs);
    const isCrossingStartBoundary = isBeforeVideoStart;

    clearVideoStartTimer();
    isBeforeVideoStart = false;

    if (shouldForceSeek || isCrossingStartBoundary || canSeekNow()) {
      player.seekTo(youtubeSeconds);
      lastSeekAtMs = Date.now();
    }

    return true;
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

      if (isYoutubeBeforeVideoStart(scoreSeconds, youtube.offsetMs)) {
        syncPlayerToScoreSeconds(scoreSeconds);
        return;
      }

      if (isBeforeVideoStart) {
        const canPlayVideo = syncPlayerToScoreSeconds(scoreSeconds);

        if (canPlayVideo) {
          player.play();
        }

        return;
      }

      if (!canSeekNow()) {
        return;
      }

      if (shouldResyncYoutubeDrift(scoreSeconds, player.getCurrentTime(), youtube.offsetMs)) {
        syncPlayerToScoreSeconds(scoreSeconds);
      }
    }, DRIFT_CHECK_INTERVAL_MS);
  }

  /**
   * 최근 seek 직후 YouTube iframe 반영 지연 중인지 확인한다.
   * - 인수 : 없음
   * - 반환값 : 새 seek를 보내도 되는지 여부
   */
  function canSeekNow(): boolean {
    return Date.now() - lastSeekAtMs >= SEEK_COOLDOWN_MS;
  }

  /**
   * YouTube offset input의 HTML 범위 속성을 저장 정책 상수와 동기화한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function syncYoutubeOffsetInputBounds(): void {
    dom.youtubeOffsetInput.min = String(MIN_YOUTUBE_OFFSET_MS);
    dom.youtubeOffsetInput.max = String(MAX_YOUTUBE_OFFSET_MS);
    dom.youtubeOffsetInput.step = String(YOUTUBE_OFFSET_STEP_MS);
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
   * 음수 offset으로 영상 시작 전 구간을 재생 중일 때 영상 0초 재생을 예약한다.
   * - 인수 : scoreSeconds : 예약 기준 score seconds
   * - 인수 : offsetMs : score metadata에 저장된 YouTube offset ms
   * - 반환값 : 없음
   */
  function scheduleVideoStartAtBoundary(scoreSeconds: number, offsetMs: number): void {
    clearVideoStartTimer();

    if (
      player === null ||
      !dom.youtubeToggle.checked ||
      modeState.kind !== "ready" ||
      !session.getPlaybackRuntime().controller.isPlaying()
    ) {
      return;
    }

    const delayMs = Math.max(0, Math.ceil(secondsUntilYoutubeStart(scoreSeconds, offsetMs) * 1000));

    videoStartTimeoutId = setTimeout(() => {
      videoStartTimeoutId = null;

      if (
        player === null ||
        !dom.youtubeToggle.checked ||
        modeState.kind !== "ready" ||
        !session.getPlaybackRuntime().controller.isPlaying()
      ) {
        return;
      }

      const youtube = session.getState().document.score.musicData.youtube;
      const currentScoreSeconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();

      if (isYoutubeBeforeVideoStart(currentScoreSeconds, youtube.offsetMs)) {
        scheduleVideoStartAtBoundary(currentScoreSeconds, youtube.offsetMs);
        return;
      }

      // 음수 offset 경계에서는 drift interval에 맡기지 않고 영상 0초부터 직접 시작한다.
      player.seekTo(0);
      lastSeekAtMs = Date.now();
      isBeforeVideoStart = false;
      player.play();
    }, delayMs);
  }

  /**
   * 예약된 YouTube 시작 timer를 취소한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function clearVideoStartTimer(): void {
    if (videoStartTimeoutId !== null) {
      clearTimeout(videoStartTimeoutId);
      videoStartTimeoutId = null;
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
  const boundedOffsetMs = clampYoutubeOffsetMs(offsetMs);

  dom.youtubeOffsetInput.value = String(boundedOffsetMs);

  if (rawVideoInput.length === 0) {
    return {
      videoId: "",
      offsetMs: boundedOffsetMs,
    };
  }

  const videoId = parseYoutubeVideoId(rawVideoInput);

  if (videoId === null) {
    return null;
  }

  return {
    videoId,
    offsetMs: boundedOffsetMs,
  };
}
