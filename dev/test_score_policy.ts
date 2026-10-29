/** 확정된 ScoreFile 허용/거절 정책과 저장 시 정상화 회귀 검사. */
import { createUserLayoutPresetData } from "../src/app/layout/layout_preset";
import { createLayoutDraftBundle } from "../src/app/layout/layout_draft";
import { parseUserLayoutPresetJson } from "../src/core/score/layout_preset";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateScoreFile } from "../src/core/score/score_validate";
import { collectScoreWarnings, isValidScoreTimestamp } from "../src/core/score/score_warnings";
import { loadScoreTextAsInitialState } from "../src/app/app_runtime";
import { touchScoreTimestampsForSave } from "../src/app/score_timestamp";

const original = JSON.parse(readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8"));
const invalidCases: [string, (score: typeof original) => void][] = [
  ["foreign format", (s) => { s.format.formatName = "other"; }],
  ["future version", (s) => { s.format.version = "0.0.2"; }],
  ["missing version", (s) => { delete s.format.version; }],
  ["null string", (s) => { s.instData.strings = [null]; }],
  ["empty strings", (s) => { s.instData.strings = []; }],
  ["blank string id", (s) => { s.instData.strings[0].stringId = " "; }],
  ["string name type", (s) => { s.instData.strings[0].stringName = 1; }],
  ["instrument name type", (s) => { s.instData.instName = null; }],
  ["supportsOpen type", (s) => { s.instData.supportsOpen = "false"; }],
  ["fractional MIDI", (s) => { s.instData.strings[0].minMidi = 1.5; }],
  ["reversed range", (s) => { s.instData.strings[0].minMidi = 100; }],
  ["invalid open MIDI", (s) => { s.instData.strings[0].openMidi = 128; }],
  ["null row", (s) => { s.layout.rowDefinitions.push(null); }],
  ["unknown row type", (s) => { s.layout.rowDefinitions[0].type = "other"; }],
  ["blank row id", (s) => { s.layout.rowDefinitions[0].rowId = " "; }],
  ["unknown global kind", (s) => { s.layout.rowDefinitions[0].kind = "other"; }],
  ["duplicate global kind", (s) => { s.layout.rowDefinitions.push({ ...s.layout.rowDefinitions[0], rowId: "duplicate-bpm" }); }],
  ["label type", (s) => { s.layout.rowDefinitions.find((r: {type: string}) => r.type === "note").displayLabel = {}; }],
  ["zero width", (s) => { s.layout.baseColumnWidthPx = 0; }],
  ["fractional width", (s) => { s.layout.baseColumnWidthPx = 1.5; }],
  ["null track", (s) => { s.tracks[0] = null; }],
  ["track name type", (s) => { s.tracks[0].trackName = null; }],
  ["missing cell array", (s) => { delete s.tracks[0].cells; }],
  ["null track cell", (s) => { s.tracks[0].cells = [null]; }],
  ["null global cell", (s) => { s.globalLines.cells[0] = null; }],
  ["track targets global", (s) => { s.tracks[0].cells = [{ rowId: s.globalLines.cells[0].rowId, col: 0, rawText: "1" }]; }],
];
for (const [label, mutate] of invalidCases) {
  const score = structuredClone(original);
  mutate(score);
  assert.equal(validateScoreFile(score).ok, false, label);
}

// 경고 대상 원본은 로드 단계에서 그대로 유지한다.
const permissive = structuredClone(original);
delete permissive.musicData.createdAt;
permissive.musicData.updatedAt = { malformed: true };
delete permissive.musicData.scoreDifficulty;
delete permissive.instData.presetId;
permissive.instData.instName = "";
permissive.instData.family = "";
permissive.instData.strings[0].stringName = "";
permissive.instData.strings[0].minMidi = 60;
permissive.instData.strings[0].openMidi = 70;
permissive.tracks[0].trackName = "";
permissive.layout.rowDefinitions.find((r: {type: string}) => r.type === "note").displayLabel = "";
permissive.globalLines.cells[0].rawText = "not-a-number";
const before = JSON.stringify(permissive);
const validation = validateScoreFile(permissive);
assert(validation.ok);
assert(collectScoreWarnings(validation.score).some((warning) => warning.includes("outside")));
assert(collectScoreWarnings(validation.score).some((warning) => warning.includes("disagree")));
const loaded = loadScoreTextAsInitialState(before, "policy fixture");
assert(loaded.ok);
assert.equal(loaded.state.statusMessage.level, "warning");
assert.match(loaded.state.statusMessage.text, /Start default: 120/);
assert.equal(JSON.stringify(loaded.state.document.score), before);
const timestamp = "2026-10-26T00:00:00.000Z";
const saved = touchScoreTimestampsForSave(validation.score, "loaded", timestamp);
assert.equal(saved.musicData.createdAt, timestamp);
assert.equal(saved.musicData.updatedAt, timestamp);
assert.equal(JSON.stringify(permissive), before);
assert.equal(saved.instData.strings[0].openMidi, 70);
assert.equal(saved.instData.presetId, undefined);
assert.equal(saved.musicData.scoreDifficulty, undefined);
assert(validateScoreFile(JSON.parse(JSON.stringify(saved))).ok);

for (const invalid of [null, 123, {}, "", "2026-02-30T00:00:00Z", "2026-10-26", "2026-10-26T24:00:00Z"]) {
  assert.equal(isValidScoreTimestamp(invalid), false);
}
assert(isValidScoreTimestamp("2024-02-29T01:02:03+09:00"));
const validDate = "2026-10-26T09:00:00+09:00";
const dates = { ...validation.score, musicData: { ...validation.score.musicData, createdAt: validDate, updatedAt: "2000-01-01T00:00:00Z" } };
assert(collectScoreWarnings(dates).some((warning) => warning.includes("precedes")));
const savedDates = touchScoreTimestampsForSave(dates, "loaded", "2026-10-25T00:00:00.000Z");
assert.equal(savedDates.musicData.createdAt, validDate);
assert.equal(savedDates.musicData.updatedAt, timestamp);
console.log("Score policy checks passed.");

// 허용된 음역/빈 라벨이 레이아웃 프리셋 저장·재로드에서도 유지되어야 한다.
const draft = createLayoutDraftBundle(validation.score);
draft.layoutPresetDisplayName = "Policy preset";
const preset = createUserLayoutPresetData(draft, "custom");
assert(preset.ok);
const reloadedPreset = parseUserLayoutPresetJson(JSON.stringify(preset.value));
assert(reloadedPreset.ok);
assert.equal(reloadedPreset.value.instData.strings[0].stringName, "");
assert.equal(reloadedPreset.value.instData.strings[0].openMidi, 70);
