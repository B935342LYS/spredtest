/**
 * Examples 원격 provider 설정값을 관리한다.
 */

const DEFAULT_EXAMPLE_MANIFEST_FUNCTION_URL =
  "https://nflcoszlsiddxjvydjwu.supabase.co/functions/v1/get-example-manifest";

/** 베타 목록 제공 중단 정책. 공개 예제와 DB 구조는 유지한다. */
export const BETA_EXAMPLES_ENABLED: boolean = false;
/** 잠긴 베타 목록 입력 또는 요청에 표시할 안내. */
export const BETA_EXAMPLES_DISABLED_MESSAGE = "Beta test list access is disabled.";

type ViteImportMeta = ImportMeta & {
  env?: Record<string, string | undefined>;
};

/** Examples Supabase provider 호출에 필요한 공개 설정. */
export type ExampleProviderConfig = {
  manifestFunctionUrl: string;
  publishableKey: string;
};

/**
 * Vite 환경 변수와 기본 공개 URL에서 Examples provider 설정을 읽는다.
 * - 인수 : 없음
 * - 반환값 : Edge Function URL과 선택 publishable key
 */
export function readExampleProviderConfig(): ExampleProviderConfig {
  const env = (import.meta as ViteImportMeta).env ?? {};
  const manifestFunctionUrl = env.VITE_EXAMPLE_MANIFEST_FUNCTION_URL?.trim() ||
    DEFAULT_EXAMPLE_MANIFEST_FUNCTION_URL;
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

  return {
    manifestFunctionUrl,
    publishableKey,
  };
}
