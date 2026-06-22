/**
 * YouTube sync UI와 player wrapper에서 공유하는 타입을 정의한다.
 */

/** YouTube iframe mode의 현재 상태. */
export type YoutubeModeState =
  | { kind: "off" }
  | { kind: "loading"; videoId: string; offsetMs: number }
  | { kind: "ready"; videoId: string; offsetMs: number }
  | { kind: "error"; message: string };

/** YouTube reload 입력을 정규화한 값. */
export type YoutubeSyncInput = {
  videoId: string;
  offsetMs: number;
};

/** YouTube player가 app binding에 제공하는 최소 제어 계약. */
export type YoutubePlayerHandle = {
  loadVideo(videoId: string, startSeconds: number): Promise<void>;
  seekTo(seconds: number): void;
  play(): void;
  pause(): void;
  getCurrentTime(): number;
  dispose(): void;
};

