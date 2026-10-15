import assert from "node:assert/strict";
import { createGameInputHistory } from "../src/app/game/game_input_history";
import type { GamePitchFrame } from "../src/app/game/game_types";

/**
 * 경계 검사에 사용할 음정 프레임을 만든다.
 * - 인수 : id : 프레임 시각
 * - 인수 : midi : 음정 또는 무음
 * - 인수 : centOffset : cent 오프셋
 * - 반환값 : 검사 프레임
 */
function frame(id: number, midi: number | null = 60, centOffset = 0): GamePitchFrame {
  return { capturedAtMs: id, midi, centOffset, rawFrequencyHz: 261.63, frequencyHz: 261.63,
    clarity: 1, rms: 0.1, isVoiced: midi !== null, rejectReason: null };
}

// 동일 timestamp와 null 입력은 정리를 포함한 모든 기록 변경을 생략한다.
const history = createGameInputHistory();
history.recordFrame(frame(1), 0);
const onsets = history.getOnsets();
const effects = history.getEffectFrames();
history.recordFrame(frame(1, 62), 10);
history.recordFrame(null, 10);
assert.equal(history.getOnsets(), onsets);
assert.equal(history.getEffectFrames(), effects);

// pitch class가 같으면 옥타브 변경으로 새 발음 시작을 만들지 않는다.
history.recordFrame(frame(2, 72), 0.03);
assert.equal(history.getOnsets().length, 1);
history.recordFrame(frame(3, 72, 79), 0.04);
assert.equal(history.getOnsets().length, 1);
history.recordFrame(frame(4, 72, -1), 0.06);
assert.deepEqual(history.getOnsets().map(x => x.id), [1, 2]);

// 최소 간격 미만에서는 후보를 억제하고 무음 전환 이후 새 후보를 받는다.
history.reset();
history.recordFrame(frame(1), 0);
history.recordFrame(frame(2, 62), 0.059);
assert.equal(history.getOnsets().length, 1);
history.recordFrame(frame(3, null), 0.06);
history.recordFrame(frame(4), 0.061);
assert.equal(history.getOnsets().length, 2);

// 보관 창의 경계값은 포함하고 초과 값은 제거한다.
history.reset();
history.recordFrame(frame(1), 0);
history.recordFrame(frame(2), 0.75);
assert.equal(history.getOnsets().length, 1);
history.recordFrame(frame(3), 0.750001);
assert.equal(history.getOnsets().length, 0);
history.recordFrame(frame(4), 1.2);
assert.equal(history.getEffectFrames()[0].frame.capturedAtMs, 1);
history.recordFrame(frame(5), 1.200001);
assert.equal(history.getEffectFrames()[0].frame.capturedAtMs, 2);

// reset은 timestamp와 ID도 비우며 별도 인스턴스에 영향을 주지 않는다.
const independent = createGameInputHistory();
independent.recordFrame(frame(5), 0);
history.reset();
assert.equal(history.getOnsets().length, 0);
assert.equal(history.getEffectFrames().length, 0);
history.recordFrame(frame(5), 0);
assert.equal(history.getOnsets()[0].id, 1);
assert.equal(independent.getOnsets().length, 1);
console.log("Game input history boundary tests passed.");
