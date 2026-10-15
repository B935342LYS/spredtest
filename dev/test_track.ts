import { readFileSync } from "node:fs";

import { buildAudioSchedule } from "../src/audio/audio_schedule_builder";
import { createRuntimeDocument } from "../src/core/score/create_runtime_document";
import type { ScoreFile } from "../src/core/score/types";
import {
  applyActiveTrackIdsToState,
  buildRuntimeArtifacts,
  createInitialState,
} from "../src/app/app_runtime";
import { applyScoreCellRawTextBatch } from "../src/app/edit/edit_apply";
import { toggleActiveTrackId } from "../src/app/app_track_binding";
import { INACTIVE_TRACK_ALPHA } from "../src/track/track_control";

/**
 * 테스트 조건이 거짓이면 프로세스를 실패 상태로 만든다.
 * - 인수 : condition : 통과 여부
 * - 인수 : message : 실패 시 출력할 설명
 * - 반환값 : 없음
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const fixtureUrl = new URL("./test_cases/minimal-valid-score.json", import.meta.url);
const jsonText = readFileSync(fixtureUrl, "utf8");
const baseDocument = createRuntimeDocument(JSON.parse(jsonText) as ScoreFile);
const applyResult = applyScoreCellRawTextBatch(baseDocument.score, [
  {
    selection: {
      trackId: "optional",
      rowId: "s1-note-60",
      rowKind: "note",
      col: 0,
    },
    rawText: "C4",
  },
  {
    selection: {
      trackId: "extra",
      rowId: "s1-note-64",
      rowKind: "note",
      col: 0,
    },
    rawText: "E4",
  },
]);

assert(applyResult.ok, "Track fixture edits should apply.");

if (!applyResult.ok) {
  throw new Error("Track fixture setup failed.");
}

const document = createRuntimeDocument(applyResult.score);
const basicOnlyArtifacts = buildRuntimeArtifacts(document, ["basic"]);
const allTrackArtifacts = buildRuntimeArtifacts(document, ["basic", "optional", "extra"]);
const emptyTrackArtifacts = buildRuntimeArtifacts(document, []);
const basicOnlySchedule = buildAudioSchedule({
  analysis: basicOnlyArtifacts.analysis,
  activeTrackIds: ["basic"],
});
const optionalExtraSchedule = buildAudioSchedule({
  analysis: basicOnlyArtifacts.analysis,
  activeTrackIds: ["optional", "extra"],
});
const emptySchedule = buildAudioSchedule({
  analysis: basicOnlyArtifacts.analysis,
  activeTrackIds: [],
});
const initialState = createInitialState(document);
const emptyTrackState = applyActiveTrackIdsToState(initialState, []);

assert(
  toggleActiveTrackId(["basic"], "basic").length === 0,
  "Track toggle should allow empty activeTrackIds.",
);
assert(
  toggleActiveTrackId(["extra"], "basic").join(",") === "basic,extra",
  "Track toggle should normalize active track order to UI order.",
);
assert(
  basicOnlyArtifacts.renderInput.noteItems.some((item) =>
    item.trackId === "basic" && item.renderAlpha === 1
  ),
  "Basic active renderer items should use full alpha.",
);
assert(
  basicOnlyArtifacts.renderInput.noteItems.some((item) =>
    item.trackId === "optional" && item.renderAlpha === INACTIVE_TRACK_ALPHA
  ),
  "Optional inactive renderer items should use inactive alpha.",
);
assert(
  allTrackArtifacts.renderInput.noteItems.every((item) => item.renderAlpha === 1),
  "All active renderer items should use full alpha.",
);
assert(
  emptyTrackArtifacts.renderInput.noteItems.every((item) =>
    item.renderAlpha === INACTIVE_TRACK_ALPHA
  ),
  "Empty activeTrackIds should render all note items with inactive alpha.",
);
assert(
  basicOnlySchedule.events.every((event) => event.trackId === "basic"),
  "Basic-only schedule should include only basic events.",
);
assert(
  optionalExtraSchedule.events.length === 2 &&
    optionalExtraSchedule.events.every((event) => event.trackId !== "basic"),
  "Optional+extra schedule should include only optional and extra events.",
);
assert(emptySchedule.events.length === 0, "Empty activeTrackIds should create an empty schedule.");
assert(
  emptyTrackState.activeTrackIds.length === 0 &&
    emptyTrackState.renderInput.noteItems.every((item) => item.renderAlpha === INACTIVE_TRACK_ALPHA),
  "App state track update should rebuild renderer input without parse/analyze changes.",
);

console.log("Track layer test completed.");
