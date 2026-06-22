/**
 * YouTube IFrame Player API 로드와 player 제어를 감싼다.
 */

import type { YoutubePlayerHandle } from "./youtube_types";

const YOUTUBE_IFRAME_API_URL = "https://www.youtube.com/iframe_api";
const PLAYER_READY_TIMEOUT_MS = 10000;
const EMBED_BLOCKED_ERROR_CODES = new Set([101, 150]);

type YoutubePlayerStateCode = -1 | 0 | 1 | 2 | 3 | 5;

type YoutubePlayerEvent = {
  target: YoutubeIframePlayer;
};

type YoutubePlayerErrorEvent = {
  data: number;
  target: YoutubeIframePlayer;
};

type YoutubeIframePlayer = {
  cueVideoById(input: { videoId: string; startSeconds: number }): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  getCurrentTime(): number;
  destroy(): void;
};

type YoutubePlayerOptions = {
  width: string;
  height: string;
  videoId?: string;
  playerVars: Record<string, number | string>;
  events: {
    onReady(event: YoutubePlayerEvent): void;
    onError(event: YoutubePlayerErrorEvent): void;
    onStateChange(event: { data: YoutubePlayerStateCode }): void;
  };
};

type YoutubeNamespace = {
  Player: new (element: HTMLElement, options: YoutubePlayerOptions) => YoutubeIframePlayer;
};

declare global {
  interface Window {
    YT?: YoutubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiReadyPromise: Promise<YoutubeNamespace> | null = null;

/**
 * YouTube IFrame API script를 한 번만 로드한다.
 * - 인수 : 없음
 * - 반환값 : 사용 가능한 YT namespace
 */
export function loadYoutubeIframeApi(): Promise<YoutubeNamespace> {
  if (window.YT !== undefined) {
    return Promise.resolve(window.YT);
  }

  if (apiReadyPromise !== null) {
    return apiReadyPromise;
  }

  apiReadyPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    const script = document.createElement("script");

    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();

      if (window.YT === undefined) {
        reject(new Error("YouTube API loaded without YT namespace."));
        return;
      }

      resolve(window.YT);
    };
    script.src = YOUTUBE_IFRAME_API_URL;
    script.async = true;
    script.onerror = () => {
      reject(new Error("YouTube IFrame API load failed."));
    };
    document.head.append(script);
  });

  return apiReadyPromise;
}

/**
 * 지정한 container 안에 YouTube player를 만들고 제어 handle을 반환한다.
 * - 인수 : container : iframe player가 생성될 DOM 요소
 * - 인수 : onBlocked : 영상 embedding 차단이 감지되었을 때 호출할 handler
 * - 반환값 : YouTube player 제어 handle
 */
export async function createYoutubePlayer(
  container: HTMLElement,
  onBlocked: (message: string) => void,
): Promise<YoutubePlayerHandle> {
  const youtube = await loadYoutubeIframeApi();
  let player: YoutubeIframePlayer | null = null;
  let lastError: Error | null = null;

  const readyPromise = new Promise<YoutubeIframePlayer>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("YouTube player ready timeout."));
    }, PLAYER_READY_TIMEOUT_MS);

    // YouTube API는 전달된 element를 iframe으로 교체하므로 매 생성마다 비어 있는 container를 사용한다.
    container.replaceChildren();
    const playerElement = document.createElement("div");

    container.append(playerElement);
    player = new youtube.Player(playerElement, {
      width: "100%",
      height: "100%",
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
      },
      events: {
        onReady(event) {
          window.clearTimeout(timeoutId);
          resolve(event.target);
        },
        onError(event) {
          const message = EMBED_BLOCKED_ERROR_CODES.has(event.data)
            ? "Embedding is disabled for this video."
            : `YouTube player error: ${event.data}`;

          lastError = new Error(message);

          if (EMBED_BLOCKED_ERROR_CODES.has(event.data)) {
            onBlocked(message);
          }
        },
        onStateChange() {
          // 첫 구현에서는 state code를 별도 UI 상태로 표시하지 않는다.
        },
      },
    });
  });

  const readyPlayer = await readyPromise;

  return {
    loadVideo(videoId: string, startSeconds: number): Promise<void> {
      lastError = null;
      readyPlayer.cueVideoById({
        videoId,
        startSeconds: Math.max(0, startSeconds),
      });
      readyPlayer.seekTo(Math.max(0, startSeconds), true);

      if (lastError !== null) {
        return Promise.reject(lastError);
      }

      return Promise.resolve();
    },
    seekTo(seconds: number): void {
      readyPlayer.seekTo(Math.max(0, seconds), true);
    },
    play(): void {
      readyPlayer.playVideo();
    },
    pause(): void {
      readyPlayer.pauseVideo();
    },
    getCurrentTime(): number {
      const seconds = readyPlayer.getCurrentTime();

      return Number.isFinite(seconds) ? seconds : 0;
    },
    dispose(): void {
      player?.destroy();
      player = null;
      container.replaceChildren();
    },
  };
}

