/** 레이아웃 음정 이동의 순수 draft 변환과 원본 행 참조 보존을 검증한다. */
import assert from "node:assert/strict";
import type { RowDefinition, ScoreFile } from "../src/core/score/types";
import { createLayoutDraftBundle, shiftLayoutDraftPitch } from "../src/app/layout/layout_draft";
import type { LayoutDraftBundle } from "../src/app/layout/layout_types";
import { formatPitchName } from "../src/app/pitch_label";

/**
 * 원본 수정 시도가 있으면 실패하도록 테스트 입력을 재귀적으로 동결한다.
 * - 인수 : value : 동결할 테스트 객체
 * - 반환값 : 없음
 */
function freezeInput(value: object): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freezeInput(child);
  }
  Object.freeze(value);
}

/**
 * 원본 악보를 기반으로 독립적인 음정 이동 사례를 검증한다.
 * - 인수 : baseScore : 유효한 기본 fixture
 * - 반환값 : 없음. 실패 시 assertion 예외
 */
export function runLayoutPitchShiftTests(baseScore: ScoreFile): void {
  // 양끝 gap과 비균일 높이, 임의 ID, 다른 string을 함께 배치한다.
  const rows: RowDefinition[] = baseScore.layout.rowDefinitions.filter((row) => row.type === "global");
  rows.push({ type: "gap", rowId: "top-gap", stringId: "s1", fromMidi: 64, toMidi: 65, height: 13 });
  for (let midi = 64; midi >= 60; midi -= 1) {
    rows.push({ type: "note", rowId: midi === 60 ? "opaque-c4" : `s1-note-${midi}`,
      stringId: "s1", midi, height: midi - 55, displayLabel: formatPitchName(midi, "sharp") });
    if (midi > 60) rows.push({ type: "gap", rowId: `s1-gap-${midi - 1}-${midi}`,
      stringId: "s1", fromMidi: midi - 1, toMidi: midi, height: midi - 48 });
  }
  rows.push({ type: "gap", rowId: "bottom-gap", stringId: "s1", fromMidi: 59, toMidi: 60, height: 17 });
  rows.push({ type: "note", rowId: "other-string", stringId: "s2", midi: 60, height: 9, displayLabel: "C4" });
  const score: ScoreFile = structuredClone({ ...baseScore,
    instData: { ...baseScore.instData, strings: [
      { stringId: "s1", stringName: "One", minMidi: 60, maxMidi: 64 },
      { stringId: "s2", stringName: "Two", minMidi: 60, maxMidi: 64 },
    ] },
    layout: { ...baseScore.layout, rowDefinitions: rows },
    tracks: baseScore.tracks.map((track) => ({ ...track, cells: [
      { rowId: "opaque-c4", col: 0, rawText: "C4" },
      { rowId: "s1-note-62", col: 1, rawText: "1" },
    ] })),
  });
  const draft = createLayoutDraftBundle(score);
  draft.selectedRowId = "s1-note-62";
  const before = JSON.stringify({ score, draft });
  freezeInput(score);
  freezeInput(draft);

  /**
   * 성공해야 하는 이동을 실행하고 결과 draft를 반환한다.
   * - 인수 : input : 이동 전 draft
   * - 인수 : delta : 정수 반음 이동량
   * - 반환값 : 이동 후 draft
   */
  function shift(input: LayoutDraftBundle, delta: number): LayoutDraftBundle {
    const result = shiftLayoutDraftPitch(input, delta, score.layout.rowDefinitions);
    assert.ok(result.ok, result.message);
    return result.draft;
  }

  const up = shift(draft, 2);
  assert.deepEqual(up.rowDefinitions.map((row) => [row.type, row.height, row.stringId]),
    draft.rowDefinitions.map((row) => [row.type, row.height, row.stringId]));
  assert.equal(up.instData, draft.instData);
  assert.equal(up.rowDefinitions.at(-1), draft.rowDefinitions.at(-1));
  assert.equal(up.selectedRowId, "s1-note-64", "Selection follows its physical row.");
  for (let index = 0; index < draft.rowDefinitions.length; index += 1) {
    const oldRow = draft.rowDefinitions[index];
    const newRow = up.rowDefinitions[index];
    if (oldRow.type === "note" && oldRow.stringId === "s1") {
      assert.ok(newRow.type === "note");
      assert.equal(newRow.midi, oldRow.midi + 2);
      assert.equal(newRow.displayLabel, formatPitchName(oldRow.midi + 2, "sharp"));
    }
  }
  assert.deepEqual(shift(up, -2), draft, "Round trip restores opaque IDs, gaps, heights and selection.");
  assert.deepEqual(shift(shift(draft, -3), 3), draft);
  assert.deepEqual(shift(shift(draft, 1), 1), up, "Repeated shifts use the same score identity baseline.");
  assert.equal(shift(draft, 0), draft);
  const gapSelected = { ...draft, selectedRowId: "top-gap" };
  assert.deepEqual(shift(shift(gapSelected, 2), -2), gapSelected);
  const otherSelected = { ...draft, selectedStringId: "s2", selectedRowId: "other-string" };
  const otherShifted = shift(otherSelected, 12);
  assert.deepEqual(otherShifted.rowDefinitions.slice(0, -1), draft.rowDefinitions.slice(0, -1));
  assert.equal(otherShifted.selectedRowId, "s2-note-72");
  assert.deepEqual(shift(otherShifted, -12), otherSelected);

  // C4가 남는 하향 이동에서는 ID를 유지하고 상향 이동에서는 삭제 후보로 ID가 사라진다.
  const down = shift(draft, -2);
  const c4 = down.rowDefinitions.find((row) => row.rowId === "opaque-c4");
  assert.ok(c4?.type === "note");
  assert.equal(c4.midi, 60);
  assert.notEqual(down.rowDefinitions.indexOf(c4), draft.rowDefinitions.findIndex((row) => row.rowId === "opaque-c4"));
  assert.equal(up.rowDefinitions.some((row) => row.rowId === "opaque-c4"), false);
  for (const track of score.tracks) {
    const retained = up.rowDefinitions.find((row) => row.rowId === track.cells[1].rowId);
    assert.ok(retained?.type === "note");
    assert.equal(retained.midi, 62, "Row-relative notes retain their pitch identity.");
  }

  // MIDI 양끝과 gap의 -1/128 경계, 악기 설정 음역 밖 경고를 확인한다.
  const low = shift(draft, -60);
  const high = shift(draft, 63);
  assert.ok(low.rowDefinitions.some((row) => row.type === "gap" && row.fromMidi === -1));
  assert.ok(high.rowDefinitions.some((row) => row.type === "gap" && row.toMidi === 128));
  const warning = shiftLayoutDraftPitch(draft, 2, score.layout.rowDefinitions);
  assert.ok(warning.ok && warning.message.includes("outside"));
  for (const delta of [-61, 64, 0.5, NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    assert.equal(shiftLayoutDraftPitch(draft, delta, score.layout.rowDefinitions).ok, false);
  }
  for (const invalid of [
    { ...draft, selectedStringId: null },
    { ...draft, selectedStringId: "missing" },
    { ...draft, rowDefinitions: [] },
    { ...draft, rowDefinitions: [...draft.rowDefinitions, draft.rowDefinitions[1]] },
    { ...draft, rowDefinitions: [draft.rowDefinitions[0], ...draft.rowDefinitions] },
    { ...draft, rowDefinitions: draft.rowDefinitions.map((row, index) => index === 1 ? { ...row, height: 0 } : row) },
  ]) assert.equal(shiftLayoutDraftPitch(invalid, 2, score.layout.rowDefinitions).ok, false);

  // 사라질 원음 ID가 새 음의 표준 ID처럼 보여도 다른 음정으로의 재사용을 거부한다.
  const collisionRows = score.layout.rowDefinitions.map((row) => row.rowId === "opaque-c4"
    ? { ...row, rowId: "s1-note-66" } : row);
  assert.equal(shiftLayoutDraftPitch(draft, 2, collisionRows).ok, false);
  const globalCollision = score.layout.rowDefinitions.map((row, index) => index === 0
    ? { ...row, rowId: "s1-note-66" } : row);
  assert.equal(shiftLayoutDraftPitch(draft, 2, globalCollision).ok, false);
  const edited = { ...draft, rowDefinitions: draft.rowDefinitions.map((row, index) => index === 2 ? { ...row, height: 31 } : row) };
  assert.equal(shift(edited, 2).rowDefinitions[2].height, 31);
  assert.equal(JSON.stringify({ score, draft }), before, "Success and failure never mutate input or score cells.");
  console.log("Layout pitch shift tests passed.");
}
