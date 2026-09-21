/** YouTube IFrame API 준비·취소·오류 전달과 player별 자원 수명을 관리한다. */
import type { YoutubePlayerHandle } from "./youtube_types";

const YOUTUBE_IFRAME_API_URL = "https://www.youtube.com/iframe_api";
const PLAYER_READY_TIMEOUT_MS = 10000;
const EMBED_BLOCKED_ERROR_CODES = new Set([101, 150]);

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
  videoId: string;
  playerVars: Record<string, number | string>;
  events: {
    onReady(event: { target: YoutubeIframePlayer }): void;
    onError(event: { data: number; target: YoutubeIframePlayer }): void;
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
 * API 준비를 공유하고 실패 캐시를 비워 다음 Reload를 허용한다.
 * - 인수 : 없음
 * - 반환값 : 사용 가능한 YT namespace
 */
export function loadYoutubeIframeApi(): Promise<YoutubeNamespace> {
  if (typeof window.YT?.Player === "function") return Promise.resolve(window.YT);
  if (apiReadyPromise !== null) return apiReadyPromise;
  const attempt = new Promise<YoutubeNamespace>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    const script = document.createElement("script");
    let settled = false;
    const timeoutId = window.setTimeout(() => finish(new Error("YouTube API ready timeout.")), PLAYER_READY_TIMEOUT_MS);
    /**
     * 이번 script의 예약·콜백을 정리하고 결과를 한 번만 반환한다.
     * - 인수 : error : 로드 실패 원인, 성공이면 생략
     * - 반환값 : 없음
     */
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      script.onerror = null;
      if (window.onYouTubeIframeAPIReady === onReady) window.onYouTubeIframeAPIReady = previousReady;
      if (error) { script.remove(); reject(error); }
      else resolve(window.YT!);
    }
    /** API 준비를 확인한다. - 인수 : 없음 - 반환값 : 없음 */
    function onReady(): void {
      if (settled) return;
      try { previousReady?.(); }
      finally { finish(typeof window.YT?.Player === "function" ? undefined : new Error("YouTube API loaded without Player.")); }
    }
    window.onYouTubeIframeAPIReady = onReady;
    script.src = YOUTUBE_IFRAME_API_URL;
    script.async = true;
    script.onerror = () => finish(new Error("YouTube IFrame API load failed."));
    document.head.append(script);
  });
  const cached = attempt.catch((error: unknown) => {
    if (apiReadyPromise === cached) apiReadyPromise = null;
    throw error;
  });
  apiReadyPromise = cached;
  return cached;
}

/**
 * 공유 API 로드는 유지하되 개별 player 요청의 대기는 즉시 취소한다.
 * - 인수 : promise : 공유 API 준비 결과
 * - 인수 : signal : 개별 요청 취소 신호
 * - 반환값 : 준비 결과 또는 취소 오류
 */
function waitForApi(promise: Promise<YoutubeNamespace>, signal?: AbortSignal): Promise<YoutubeNamespace> {
  return new Promise((resolve, reject) => {
    /** 취소된 호출자의 대기를 해제한다. - 인수 : 없음 - 반환값 : 없음 */
    const abort = (): void => reject(new DOMException("YouTube request cancelled.", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    // 취소 후에도 공유 Promise의 실패를 소비하고 listener를 제거한다.
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}

/**
 * 독립 mount를 가진 player를 생성한다. 준비 전후 모두 취소 가능하다.
 * - 인수 : container : mount를 넣을 고정 컨테이너
 * - 인수 : videoId : 생성 시부터 설정할 확정된 영상 ID
 * - 인수 : onError : 현재 player의 비동기 영상 오류 수신 함수
 * - 인수 : signal : 생성부터 재생까지 유효한 취소 신호
 * - 반환값 : 준비된 player handle. 실제 영상 재생 시작을 기다리지는 않는다
 */
export async function createYoutubePlayer(
  container: HTMLElement,
  videoId: string,
  onError: (message: string) => void,
  signal?: AbortSignal,
): Promise<YoutubePlayerHandle> {
  signal?.throwIfAborted();
  const youtube = await waitForApi(loadYoutubeIframeApi(), signal);
  signal?.throwIfAborted();
  const mount = document.createElement("div");
  mount.style.height = "100%";
  const element = document.createElement("div");
  mount.append(element);
  container.append(mount);
  let player: YoutubeIframePlayer | null = null;
  let disposed = false;
  let ready = false;
  let lastError: Error | null = null;
  let timeoutId: number | undefined;
  let rejectReady: (reason: unknown) => void = () => {};
  /**
   * 소유한 player와 mount만 제거하여 새 요청의 DOM을 보존한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abort);
    rejectReady(new DOMException("YouTube request cancelled.", "AbortError"));
    try { player?.destroy(); } finally { mount.remove(); }
    player = null;
  }
  /** 요청 취소 시 대기와 자원을 정리한다. - 인수 : 없음 - 반환값 : 없음 */
  function abort(): void { dispose(); }
  const readyPromise = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    timeoutId = window.setTimeout(() => reject(new Error("YouTube player ready timeout.")), PLAYER_READY_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    // 영상마다 별도 player를 사용하여 이전 영상의 오류 callback을 격리한다.
    player = new youtube.Player(element, {
      width: "100%", height: "100%",
      // 빈 /embed/ 생성의 error:2가 뒤늦게 정상 cue 요청을 실패시키지 않게 한다.
      videoId,
      playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady() {
          if (disposed) return;
          ready = true;
          window.clearTimeout(timeoutId);
          resolve();
        },
        onError(event) {
          if (disposed) return;
          const message = EMBED_BLOCKED_ERROR_CODES.has(event.data)
            ? "Embedding is disabled for this video." : `YouTube player error: ${event.data}`;
          lastError = new Error(message);
          if (!ready) reject(lastError);
          else onError(message);
        },
      },
    });
  });
  try { await readyPromise; } catch (error) { dispose(); throw error; }
  signal?.throwIfAborted();
  return {
    /** 영상을 cue한다. - 인수 : videoId, startSeconds : 영상과 시작 초 - 반환값 : 명령 전달 결과 */
    async loadVideo(videoId, startSeconds): Promise<void> {
      if (disposed || player === null) throw new DOMException("YouTube request cancelled.", "AbortError");
      lastError = null;
      player.cueVideoById({ videoId, startSeconds: Math.max(0, startSeconds) });
      if (lastError !== null) throw lastError;
      // 이 Promise는 CUED/PLAYING 확인이 아니다. 이후 오류는 callback으로 전달한다.
    },
    /** 위치를 이동한다. - 인수 : seconds : 영상 초 - 반환값 : 없음 */
    seekTo(seconds): void { if (!disposed) player?.seekTo(Math.max(0, seconds), true); },
    /** 영상을 재생한다. - 인수 : 없음 - 반환값 : 없음 */
    play(): void { if (!disposed) player?.playVideo(); },
    /** 영상을 멈춘다. - 인수 : 없음 - 반환값 : 없음 */
    pause(): void { if (!disposed) player?.pauseVideo(); },
    /** 영상 위치를 조회한다. - 인수 : 없음 - 반환값 : 유한한 영상 초 */
    getCurrentTime(): number {
      const seconds = disposed ? 0 : player?.getCurrentTime();
      return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0;
    },
    dispose,
  };
}
