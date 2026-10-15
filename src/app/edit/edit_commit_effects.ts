/** 확정된 편집의 화면·재생 반영과 제한된 복구 순서를 조율한다. */

/** 외부 효과의 성공 또는 복구되지 않은 실패. 악보의 확정 여부와는 별개다. */
export type EditEffectsResult =
  | { kind: "ready"; recovered: boolean }
  | { kind: "failed"; stage: "render" | "playback" | "stop"; message: string };

/** 편집 조율에 필요한 외부 효과만 전달하는 입력 계약. */
export type EditEffects = {
  render(): void;
  refresh(): void;
  updatePlayback(): void;
  stopPlayback(): void;
};

/**
 * 화면 오류는 전체 표시를 한 번 복구하고, 성공한 화면에만 새 재생을 연결한다.
 * - 인수 : effects : 화면·재생 갱신과 중단 동작
 * - 반환값 : 준비 완료 또는 실패 단계와 원인. 편집 명령은 다시 실행하지 않는다.
 */
export function applyEditEffects(effects: EditEffects): EditEffectsResult {
  let recovered = false;
  try {
    effects.render();
  } catch (error: unknown) {
    // 화면이 불완전한 동안 기존 재생을 중단한 뒤 표시만 한 번 다시 만든다.
    const stopped = tryStopPlayback(effects);
    if (stopped !== null) return { kind: "failed", stage: "stop", message: `${errorText(error)}; ${stopped}` };
    try {
      effects.refresh();
      recovered = true;
    } catch (refreshError: unknown) {
      return { kind: "failed", stage: "render", message: `${errorText(error)}; refresh: ${errorText(refreshError)}` };
    }
  }
  try {
    effects.updatePlayback();
    return { kind: "ready", recovered };
  } catch (error: unknown) {
    // 오디오 교체는 자동 반복하지 않고, 생성 도중/직후 남은 재생을 중단한다.
    const stopped = tryStopPlayback(effects);
    return { kind: "failed", stage: "playback", message: errorText(error) + (stopped === null ? "" : `; ${stopped}`) };
  }
}

/**
 * 재생 중단 자체의 오류를 결과로 보존한다.
 * - 인수 : effects : 재생 중단 동작
 * - 반환값 : 성공 시 null, 실패 시 원인
 */
function tryStopPlayback(effects: EditEffects): string | null {
  try {
    effects.stopPlayback();
    return null;
  } catch (error: unknown) {
    return `stop: ${errorText(error)}`;
  }
}

/**
 * 예외 값을 사용자 오류 설명으로 변환한다.
 * - 인수 : error : 포착한 예외
 * - 반환값 : 원인 문자열
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
