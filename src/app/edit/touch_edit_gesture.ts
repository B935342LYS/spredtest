/** 터치 접촉 수명과 중심 이동을 DOM·악보 편집에서 분리한다. */

/** 화면 좌표이며 스크롤 위치나 악보 좌표를 포함하지 않는다. */
export type TouchPoint = { clientX: number; clientY: number };

/** rollback 확인 전에는 pan을 허용하지 않는 제스처 상태. */
export type TouchEditGesture = {
  phase: "idle" | "single" | "restoring" | "pan" | "blocked";
  points: ReadonlyMap<number, TouchPoint>;
  center: TouchPoint | null;
};

/** 추적된 터치만 전달한다. reset은 blur·hidden·외부 명령에서 사용한다. */
export type TouchGestureInput =
  | ({ kind: "down" | "move"; pointerId: number } & TouchPoint)
  | { kind: "up" | "cancel"; pointerId: number }
  | { kind: "reset" }
  | { kind: "restored"; success: boolean };

/** 편집은 기존 도구로 전달하고 rollback은 호출자가 성공 여부를 다시 전달한다. */
export type TouchGestureResult = {
  state: TouchEditGesture;
  action: "none" | "begin" | "edit" | "finish" | "rollback" | "pan";
  scrollX: number;
  scrollY: number;
};

/**
 * 접촉이 없는 초기 상태를 만든다.
 * - 인수 : 없음
 * - 반환값 : 독립된 빈 접촉 Map을 가진 상태
 */
export function createTouchEditGesture(): TouchEditGesture {
  return { phase: "idle", points: new Map(), center: null };
}

/**
 * 두 접촉의 현재 화면 중심을 계산한다.
 * - 인수 : points : 정확히 두 접촉의 좌표
 * - 반환값 : 두 손가락의 중심
 */
function getCenter(points: ReadonlyMap<number, TouchPoint>): TouchPoint {
  const [first, second] = [...points.values()];
  return { clientX: (first.clientX + second.clientX) / 2, clientY: (first.clientY + second.clientY) / 2 };
}

/**
 * 터치 이벤트 하나를 해석하며 이전 상태를 변경하지 않는다.
 * - 인수 : previous : 이전 접촉과 단계
 * - 인수 : input : 터치 수명 또는 복원 결과
 * - 반환값 : 다음 상태와 호출자가 수행할 편집·복원·스크롤 동작
 */
export function reduceTouchEditGesture(previous: TouchEditGesture, input: TouchGestureInput): TouchGestureResult {
  const result: TouchGestureResult = { state: previous, action: "none", scrollX: 0, scrollY: 0 };
  if (input.kind === "reset") {
    result.state = createTouchEditGesture();
    if (previous.phase === "single" || previous.phase === "restoring") result.action = "rollback";
    return result;
  }
  if (input.kind === "restored") {
    if (previous.phase !== "restoring") return result;
    result.state = {
      ...previous,
      phase: input.success && previous.points.size === 2 ? "pan" : "blocked",
      center: input.success && previous.points.size === 2 ? getCenter(previous.points) : null,
    };
    return result;
  }

  // 중복 down과 추적하지 않은 move/up은 새로운 제스처를 만들지 않는다.
  if (input.kind === "down" ? previous.points.has(input.pointerId) : !previous.points.has(input.pointerId)) return result;
  const points = new Map(previous.points);
  if (input.kind === "down" || input.kind === "move") points.set(input.pointerId, { clientX: input.clientX, clientY: input.clientY });
  else points.delete(input.pointerId);
  result.state = { ...previous, points };

  if (input.kind === "cancel") {
    result.action = previous.phase === "single" || previous.phase === "restoring" ? "rollback" : "none";
    result.state = { phase: points.size === 0 ? "idle" : "blocked", points, center: null };
  } else if (previous.phase === "blocked") {
    if (points.size === 0) result.state = createTouchEditGesture();
  } else if (input.kind === "down") {
    if (previous.phase === "idle") {
      result.state.phase = "single";
      result.action = "begin";
    } else if (previous.phase === "single" && points.size === 2) {
      result.state.phase = "restoring";
      result.action = "rollback";
    } else {
      result.state.phase = "blocked";
      result.state.center = null;
      if (previous.phase === "single" || previous.phase === "restoring") result.action = "rollback";
    }
  } else if (input.kind === "up") {
    if (previous.phase === "single") result.action = "finish";
    result.state = { phase: points.size === 0 ? "idle" : "blocked", points, center: null };
  } else if (previous.phase === "single") {
    result.action = "edit";
  } else if (previous.phase === "pan" && points.size === 2 && previous.center !== null) {
    const center = getCenter(points);
    result.action = "pan";
    result.scrollX = previous.center.clientX - center.clientX;
    result.scrollY = previous.center.clientY - center.clientY;
    // clamp은 DOM에서 수행한다. 중심은 항상 갱신하여 경계의 초과 이동을 누적하지 않는다.
    result.state.center = center;
  }
  return result;
}
