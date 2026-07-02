/**
 * Examples 기능에서 사용하는 manifest, provider, 오류 타입을 정의한다.
 */

/** Examples manifest에서 허용하는 track id. */
export type ExampleTrackId = "basic" | "optional" | "extra";

/** Examples catalog에 표시할 track별 난이도 값. */
export type ExampleDifficulty = {
  basic?: number;
  optional?: number;
  extra?: number;
};

/** Edge Function이 반환하고 앱이 검증한 단일 예제 악보 항목. */
export type ExampleScoreManifestItem = {
  id: string;
  title: string;
  artist: string;
  genre?: string;
  difficulty?: ExampleDifficulty;
  supportedTracks: ExampleTrackId[];
  durationSeconds?: number;
  sizeBytes?: number;
  scoreUrl: string;
  createdAt?: string;
  updatedAt?: string;
};

/** Edge Function이 반환하고 앱이 검증한 예제 악보 manifest. */
export type ExampleScoreManifest = {
  version: 1;
  generatedAt?: string;
  examples: ExampleScoreManifestItem[];
};

/** Examples manifest/score text를 공급하는 provider 경계. */
export type ExampleProvider = {
  providerId: "supabase";
  displayName: string;
  loadManifest(accessWord: string): Promise<ExampleScoreManifest>;
  loadScoreText(item: ExampleScoreManifestItem): Promise<string>;
};

/** Examples 처리 중 사용자에게 표시할 수 있는 오류. */
export type ExampleError = {
  code:
    | "CONFIG_MISSING"
    | "INVALID_ACCESS_WORD"
    | "INVALID_REQUEST"
    | "INVALID_RESPONSE"
    | "MANIFEST_UNAVAILABLE"
    | "METHOD_NOT_ALLOWED"
    | "RATE_LIMITED"
    | "SCORE_FETCH_FAILED"
    | "INTERNAL_ERROR";
  message: string;
};

/** Edge Function 표준 오류 응답 구조. */
export type ExampleErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};
