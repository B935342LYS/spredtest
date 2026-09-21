/**
 * YouTube sync UI와 player wrapper에서 공유하는 타입을 정의한다.
 */

/** 활성 여부와 별개인 YouTube 영상 준비 상태. idle은 링크 없는 열린 패널에서도 사용한다. */
export type YoutubeModeState =
  | { kind: "idle" }
  | { kind: "loading"; videoId: string }
  | { kind: "ready"; videoId: string }
  | { kind: "error"; message: string };

/** ScoreFile에 반영할 정규화된 YouTube 메타데이터. */
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
