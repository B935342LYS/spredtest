/** 음정 이동 이후 Apply·삭제 확인·프리셋 왕복과 분석/재생 계약을 검증한다. */
import assert from "node:assert/strict";
import type { ScoreFile } from "../src/core/score/types";
import { createInitialState, applyLayoutDraftEditToState } from "../src/app/app_runtime";
import { createLayoutDraftBundle, deleteLayoutDraftRow, shiftLayoutDraftPitch } from "../src/app/layout/layout_draft";
import { applyLayoutDraftToScore, calculateLayoutCellDeletionSummary } from "../src/app/layout/layout_apply";
import { confirmLayoutCellDeletion } from "../src/app/layout/layout_confirmation";
import { createLayoutDraftFromPreset, createUserLayoutPresetData } from "../src/app/layout/layout_preset";
import { parseUserLayoutPresetJson, serializeUserLayoutPresetData } from "../src/core/score/layout_preset";
import { loadLayoutPresetSlotFromLocalStorage, saveLayoutPresetSlotToLocalStorage } from "../src/infra/layout_preset_storage";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";
import { serializeScoreFile } from "../src/infra/score_file_io";
import { buildAudioSchedule } from "../src/audio/audio_schedule_builder";

/**
 * 충분한 주변 음역과 임의 ID를 가진 악보로 실제 적용 경로를 검사한다.
 * - 인수 : baseScore : 유효한 기본 악보 fixture
 * - 반환값 : 없음. 검증 실패 시 assertion 예외
 */
export function runLayoutPitchApplyTests(baseScore: ScoreFile): void {
  const score = structuredClone(baseScore);
  const c4 = score.layout.rowDefinitions.find((row) => row.type === "note" && row.midi === 60)!;
  c4.rowId = "opaque-c4";
  // 모든 트랙에 같은 열의 셀을 두어 트랙 간 병합·누락도 탐지한다.
  for (const track of score.tracks) {
    track.cells = [
      { rowId: "opaque-c4", col: 0, rawText: "C4" },
      { rowId: "opaque-c4", col: 1, rawText: "-" },
      { rowId: "s1-note-62", col: 4, rawText: "P" },
      { rowId: "s1-note-62", col: 5, rawText: "~" },
      { rowId: "opaque-c4", col: 8, rawText: "C4@g(a,S)" },
      { rowId: "s1-note-64", col: 10, rawText: "E4@g(a,E)" },
      { rowId: "opaque-c4", col: 14, rawText: "/3(C@n(60)||E@t(3)@n(64))" },
      { rowId: "opaque-c4", col: 15, rawText: "/&" },
    ];
  }
  const loaded = loadRuntimeDocument(serializeScoreFile(score));
  assert.ok(loaded.ok);
  const state = createInitialState(loaded.document);
  state.activeTrackIds = ["basic"];
  const draft = createLayoutDraftBundle(score);
  const shift = shiftLayoutDraftPitch(draft, 2, score.layout.rowDefinitions);
  assert.ok(shift.ok);
  assert.equal(calculateLayoutCellDeletionSummary(score, shift.draft).totalCount, 0);
  assert.equal(confirmLayoutCellDeletion(score, shift.draft, () => assert.fail("No deletion prompt expected")), true);

  // 삭제 없는 이동은 실제 full rebuild와 초 단위 audio schedule까지 동일해야 한다.
  const applied = applyLayoutDraftEditToState(state, shift.draft, false);
  assert.equal(applied.statusMessage.level, "info");
  assert.deepEqual(applied.document.score.tracks, score.tracks);
  assert.deepEqual(applied.analysis, state.analysis);
  const eventKinds = new Set(state.analysis.trackResults.flatMap((track) => track.events.map((event) => event.eventKind)));
  for (const kind of ["note", "gliss", "tupletGroup"] as const) assert.ok(eventKinds.has(kind), `Missing fixture coverage: ${kind}`);
  assert.deepEqual(buildAudioSchedule({ analysis: applied.analysis, activeTrackIds: state.activeTrackIds }),
    buildAudioSchedule({ analysis: state.analysis, activeTrackIds: state.activeTrackIds }));
  assert.deepEqual(applied.activeTrackIds, state.activeTrackIds);
  assert.deepEqual(applied.document.score.musicData, score.musicData);
  assert.deepEqual(applied.document.score.globalLines, score.globalLines);
  assert.notEqual(applied.history, state.history, "Successful layout apply resets edit history.");
  assert.notEqual(applied.document.score.layout.rowDefinitions.findIndex((row) => row.rowId === "opaque-c4"),
    score.layout.rowDefinitions.findIndex((row) => row.rowId === "opaque-c4"));
  const reloadedScore = loadRuntimeDocument(serializeScoreFile(applied.document.score));
  assert.ok(reloadedScore.ok);
  assert.deepEqual(reloadedScore.document.score, applied.document.score);
  const down = shiftLayoutDraftPitch(draft, -3, score.layout.rowDefinitions);
  assert.ok(down.ok);
  assert.deepEqual(applyLayoutDraftEditToState(state, down.draft, false).analysis, state.analysis);

  // 이동 후 수동 행 삭제도 최종 draft를 기준으로 함께 집계한다.
  const manualScore = structuredClone(score);
  for (const track of manualScore.tracks) track.cells.push({ rowId: "s1-note-54", col: 24, rawText: "P" });
  const withoutGap = deleteLayoutDraftRow(shift.draft, "s1-gap-53-54");
  assert.ok(withoutGap.ok);
  const manual = deleteLayoutDraftRow(withoutGap.draft, "s1-note-54");
  assert.ok(manual.ok);
  assert.equal(calculateLayoutCellDeletionSummary(manualScore, manual.draft).totalCount, 3);
  const manualApplied = applyLayoutDraftToScore(manualScore, manual.draft, { allowCellDeletion: true });
  assert.ok(manualApplied.ok);
  assert.deepEqual(manualApplied.score.tracks, score.tracks);

  // 외부 프리셋의 다른 ID를 같은 MIDI로 자동 연결하는 범용 보정은 추가하지 않는다.
  const foreignDraft = { ...shift.draft, rowDefinitions: shift.draft.rowDefinitions.map((row) =>
    row.rowId === "opaque-c4" ? { ...row, rowId: "foreign-c4" } : row) };
  assert.equal(calculateLayoutCellDeletionSummary(score, foreignDraft).totalCount, 15);
  assert.equal(applyLayoutDraftToScore(score, foreignDraft).ok, false);

  // 비활성 트랙을 포함하여 이동으로 사라질 하단 음정에 셀을 둔다.
  const deletionScore = structuredClone(score);
  for (const track of deletionScore.tracks) {
    track.cells.push({ rowId: "s1-note-52", col: 20, rawText: "P" });
  }
  const deletionLoad = loadRuntimeDocument(serializeScoreFile(deletionScore));
  assert.ok(deletionLoad.ok, JSON.stringify(deletionLoad));
  const deletionState = createInitialState(deletionLoad.document);
  deletionState.activeTrackIds = ["basic"];
  const summary = calculateLayoutCellDeletionSummary(deletionScore, shift.draft);
  assert.equal(summary.totalCount, 3);
  assert.equal(summary.countByRowId["s1-note-52"], 3);
  // 빈 rawText는 정상 import에서 거부되지만 집계 함수가 임의로 제외해서는 안 된다.
  const malformed = structuredClone(deletionScore);
  malformed.tracks[2].cells.at(-1)!.rawText = "";
  assert.equal(calculateLayoutCellDeletionSummary(malformed, shift.draft).totalCount, 3);
  const preset = createUserLayoutPresetData(shift.draft, score.instData.presetId ?? "custom");
  assert.ok(preset.ok);
  const serialized = serializeUserLayoutPresetData(preset.value);
  assert.ok(serialized.ok);
  const filePreset = parseUserLayoutPresetJson(serialized.value);
  assert.ok(filePreset.ok);
  saveLayoutPresetSlotToLocalStorage(preset.value, 3);
  const slotPreset = loadLayoutPresetSlotFromLocalStorage(preset.value.instrumentPresetId, 3);
  assert.ok(slotPreset);
  const slotKey = `layout-slot:${preset.value.instrumentPresetId}:3`;
  const savedSlot = globalThis.localStorage.getItem(slotKey);

  // dialog draft와 File/Local 재로드에 toolbar도 공유하는 확인·적용 경계를 실행한다.
  for (const candidate of [shift.draft, createLayoutDraftFromPreset(filePreset.value, draft),
    createLayoutDraftFromPreset(slotPreset, draft)]) {
    const before = JSON.stringify({ deletionState, candidate });
    let prompts = 0;
    const cancelled = confirmLayoutCellDeletion(deletionScore, candidate, (message) => {
      prompts += 1;
      assert.match(message, /3 track cell\(s\)/);
      assert.match(message, /s1-note-52 \(s1, E3, MIDI 52\): 3 cell\(s\)/);
      return false;
    });
    assert.equal(cancelled, false);
    assert.equal(prompts, 1);
    const refused = applyLayoutDraftEditToState(deletionState, candidate, false);
    assert.equal(refused.document, deletionState.document);
    assert.equal(refused.history, deletionState.history);
    assert.equal(refused.analysis, deletionState.analysis);
    assert.equal(globalThis.localStorage.getItem(slotKey), savedSlot);
    assert.equal(JSON.stringify({ deletionState, candidate }), before);

    assert.equal(confirmLayoutCellDeletion(deletionScore, candidate, () => true, "Saved layout"), true);
    const accepted = applyLayoutDraftEditToState(deletionState, candidate, true);
    assert.equal(accepted.statusMessage.level, "info");
    assert.deepEqual(accepted.document.score.tracks, score.tracks, "Only summarized cells may be removed.");
    assert.deepEqual(accepted.analysis, state.analysis);
    assert.deepEqual(accepted.activeTrackIds, ["basic"]);
  }

  // 삭제 동의로 MIDI 범위 위반이나 ID 중복을 우회할 수 없다.
  for (const invalid of [
    { ...shift.draft, rowDefinitions: [...shift.draft.rowDefinitions, shift.draft.rowDefinitions[0]] },
    { ...shift.draft, rowDefinitions: shift.draft.rowDefinitions.map((row) => row.type === "note" ? { ...row, midi: 128 } : row) },
  ]) assert.equal(applyLayoutDraftToScore(deletionScore, invalid, { allowCellDeletion: true }).ok, false);
  globalThis.localStorage.removeItem(slotKey);
  console.log("Layout pitch apply tests passed.");
}
