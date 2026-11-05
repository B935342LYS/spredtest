/** 터치 상태 전이와 경계 반전·중복 종료를 실제 reducer로 검사한다. */
import assert from "node:assert/strict";
import { createTouchEditGesture, reduceTouchEditGesture, type TouchGestureInput } from "../src/app/edit/touch_edit_gesture";

let state = createTouchEditGesture();
/**
 * 다음 입력을 적용하고 검사용 결과를 반환한다.
 * - 인수 : input : 접촉 또는 복원 결과
 * - 반환값 : reducer 결과
 */
function step(input: TouchGestureInput) {
  const result = reduceTouchEditGesture(state, input);
  state = result.state;
  return result;
}
assert.equal(step({ kind: "move", pointerId: 1, clientX: 0, clientY: 0 }).action, "none");
assert.equal(step({ kind: "down", pointerId: 1, clientX: 10, clientY: 10 }).action, "begin");
const original = state;
assert.equal(step({ kind: "move", pointerId: 1, clientX: 20, clientY: 30 }).action, "edit");
assert.equal(original.points.get(1)?.clientX, 10);
assert.equal(step({ kind: "down", pointerId: 2, clientX: 40, clientY: 50 }).action, "rollback");
assert.equal(state.phase, "restoring");
assert.equal(step({ kind: "move", pointerId: 2, clientX: 42, clientY: 52 }).action, "none");
step({ kind: "restored", success: true });
assert.equal(state.phase, "pan");
const pan = step({ kind: "move", pointerId: 1, clientX: 40, clientY: 50 });
assert.equal(pan.scrollX, -10);
assert.equal(pan.scrollY, -10);
assert.equal(step({ kind: "move", pointerId: 1, clientX: 38, clientY: 48 }).scrollX, 1);
step({ kind: "up", pointerId: 1 });
assert.equal(state.phase, "blocked");
step({ kind: "down", pointerId: 3, clientX: 40, clientY: 50 });
assert.equal(step({ kind: "move", pointerId: 2, clientX: 0, clientY: 0 }).action, "none");
step({ kind: "up", pointerId: 2 });
step({ kind: "up", pointerId: 3 });
assert.equal(state.phase, "idle");
assert.equal(step({ kind: "up", pointerId: 3 }).action, "none");

for (const success of [true, false]) {
  step({ kind: "down", pointerId: 4, clientX: 0, clientY: 0 });
  step({ kind: "down", pointerId: 5, clientX: 0, clientY: 0 });
  step({ kind: "restored", success });
  assert.equal(state.phase, success ? "pan" : "blocked");
  step({ kind: "down", pointerId: 6, clientX: 0, clientY: 0 });
  assert.equal(state.phase, "blocked");
  for (const pointerId of [6, 4, 5]) step({ kind: "cancel", pointerId });
  assert.equal(state.phase, "idle");
}
step({ kind: "down", pointerId: 1, clientX: 0, clientY: 0 });
assert.equal(step({ kind: "cancel", pointerId: 1 }).action, "rollback");
step({ kind: "down", pointerId: 1, clientX: 0, clientY: 0 });
assert.equal(step({ kind: "reset" }).action, "rollback");
assert.equal(step({ kind: "up", pointerId: 1 }).action, "none");
step({ kind: "down", pointerId: 1, clientX: 0, clientY: 0 });
assert.equal(step({ kind: "up", pointerId: 1 }).action, "finish");
console.log("touch gesture: transitions, rollback gate, boundary reversal and stale events passed");
