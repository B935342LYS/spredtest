import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { createRuntimeDocument } from "../src/core/score/create_runtime_document";
import type { ScoreFile } from "../src/core/score/types";
import { createInitialState, applyRawTextBatchEditToState, buildRuntimeArtifacts, applyReverseRowsToState } from "../src/app/app_runtime";
import { buildCellHistoryPatches, createScoreTextEditsFromHistoryPatches } from "../src/app/edit/edit_history";
import { getScoreTextEditInvalidationKind, type ScoreTextEdit } from "../src/core/score/score_text_edit";
import { filterVisibleMarkerItems, filterVisibleMuteItems, filterVisibleNoteItems } from "../src/renderer/canvas_visible_range";
import { buildCanvasMarkerItems, buildCanvasGlobalMarkerItems, buildCanvasNoteMarkerItems } from "../src/renderer/canvas_item_builder";
import { sortCanvasMarkerItems } from "../src/renderer/canvas_item_order";
import { applyMusicDataEditToState, buildAnalyzedCanvasRenderInput } from "../src/app/app_runtime";

/**
 * 실제 편집과 이력 복원 산출물을 독립 전체 재생성과 비교한다.
 * - 인수 : 없음
 * - 반환값 : 없음 (불일치 시 예외)
 */
function testArtifactEdits(): void {
  const fixtureScore = JSON.parse(readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8")) as ScoreFile;
  fixtureScore.globalLines.columnCount = 100;
  fixtureScore.globalLines.cells = [
    { rowId: "global-bpm", col: 0, rawText: "120" }, { rowId: "global-bpb", col: 0, rawText: "4" },
    { rowId: "global-spb", col: 0, rawText: "4" }, { rowId: "global-dyn", col: 0, rawText: "100" },
  ];
  for (const track of fixtureScore.tracks) track.cells = [
    { rowId: "s1-note-60", col: 8, rawText: "C@g(a,S)" },
    { rowId: "s1-note-64", col: 12, rawText: "E@g(a,E)" },
    { rowId: "s1-note-60", col: 17, rawText: "/3(C@n(60)|D@n(62)|E@n(64))" },
    { rowId: "s1-note-60", col: 21, rawText: "//memo" },
    { rowId: "s1-note-60", col: 25, rawText: "C" },
    { rowId: "s1-note-60", col: 26, rawText: "-" },
  ];
  /**
   * 검증용 편집 명령을 만든다.
   * - 인수 : rowId : 대상 행
   * - 인수 : col : 대상 열
   * - 인수 : rawText : 새 문자열
   * - 인수 : trackId : 대상 track
   * - 반환값 : 편집 API 입력
   */
  const edit = (rowId: string, col: number, rawText: string, trackId: "basic" | "extra" = "extra"): ScoreTextEdit => ({
    selection: { rowId, col, trackId, rowKind: rowId.startsWith("global-") ? "global" : "note" }, rawText,
  });
  const batches = [
    [edit("s1-note-60", 8, "D@g(a,S)@t(3)")],
    [edit("s1-note-64", 12, "")],
    [edit("s1-note-64", 12, "E@g(a,E)")],
    [edit("s1-note-60", 17, "/3(C@g(b,S)@n(60)|D@g(b,M)@n(62)|E@g(b,E)@n(64))"), edit("s1-note-60", 18, "/&")],
    [edit("s1-note-60", 21, "//변경된 긴 메모 0123456789")],
    [edit("s1-note-60", 26, "~"), edit("s1-note-60", 27, "-")],
    [edit("s1-note-60", 25, "C@p(64)@m(-50)@t(3)")],
    [edit("global-bpm", 10, "180<")],
    [edit("global-bpb", 16, "3"), edit("global-spb", 16, "2")],
    [edit("global-dyn", 8, "50<"), edit("global-dyn", 20, "120")],
    [edit("s1-note-67", 3, "G"), edit("s1-note-64", 32, "E", "basic")],
    [edit("global-bpm", 0, "140"), edit("s1-note-60", 8, "E")],
  ];
  // 정방향/역방향 행에서 겹친 track과 복합 이벤트를 편집하고 이력을 되돌린다.
  for (const reverse of [false, true]) {
    let state = createInitialState(createRuntimeDocument(structuredClone(fixtureScore)));
    if (reverse) state = applyReverseRowsToState(state, true);
    // 활성 track 조합별로 이전 통합 builder와 값·순서가 같고 그룹 객체만 공유하는지 검사한다.
    for (const active of [[], ["basic"], ["basic", "optional", "extra"]] as const) {
      const input = buildAnalyzedCanvasRenderInput(state.document, state.analysis, active, reverse);
      assert.deepEqual(input.markerItems, buildCanvasMarkerItems(state.analysis, active));
      assert.deepEqual(input.globalMarkerItems, buildCanvasGlobalMarkerItems(state.analysis));
      assert.deepEqual(input.noteMarkerItems, buildCanvasNoteMarkerItems(state.analysis, active));
      const groups = new Set([...input.globalMarkerItems, ...input.noteMarkerItems]);
      assert(input.markerItems.every(item => groups.has(item)), "Merged markers must reuse group objects.");
      const snapshot = JSON.stringify(input);
      input.globalMarkerItems.forEach(Object.freeze);
      input.noteMarkerItems.forEach(Object.freeze);
      assert.deepEqual(sortCanvasMarkerItems([...input.globalMarkerItems, ...input.noteMarkerItems]), input.markerItems);
      filterVisibleMarkerItems(input.markerItems, { startTick: 0, endTick: 100, startX: 0, endX: 2100 });
      assert.equal(JSON.stringify(input), snapshot, "Merge/filter must not mutate group order or objects.");
    }
    // metadata만 교체한 문서의 인덱스는 새로 생성한 인덱스와 같아야 한다.
    const beforeMetadata = state;
    const oldScore = JSON.stringify(state.document.score);
    state = applyMusicDataEditToState(state, {
      ...state.document.score.musicData,
      musicTitle: "Metadata reuse", musicArtist: "Artist", musicGenre: "Test",
      scoreWriter: "Writer", comment: "Changed details",
      scoreDifficulty: { basic: 2, optional: 3, extra: 4 },
    });
    assert.notEqual(state.document, beforeMetadata.document);
    assert.notEqual(state.document.score, beforeMetadata.document.score);
    assert.equal(state.document.score.musicData.musicTitle, "Metadata reuse");
    assert.equal(JSON.stringify(beforeMetadata.document.score), oldScore);
    assert.equal(state.document.indexes, beforeMetadata.document.indexes);
    assert.deepEqual(state.document.indexes, createRuntimeDocument(state.document.score).indexes);
    for (const key of ["parsed", "analysis", "renderInput", "history"] as const) {
      assert.equal(state[key], beforeMetadata[key]);
    }
    // 아래 72단계 편집/이력 복원 검사를 metadata 교체 직후 문서에서 계속 수행한다.
    for (const batch of batches) {
      const trialResult = applyRawTextBatchEditToState(state, batch);
      assert.equal(trialResult.kind, "applied");
      const trial = trialResult.state;
      const history = buildCellHistoryPatches(state.document.indexes, trial.document.indexes, batch);
      for (const commands of [batch, createScoreTextEditsFromHistoryPatches(history, "before"), createScoreTextEditsFromHistoryPatches(history, "after")]) {
        const previous = state;
        const snapshot = JSON.stringify(previous.renderInput);
        const result = applyRawTextBatchEditToState(previous, commands);
        assert.equal(result.kind, "applied");
        state = result.state;
        const fresh = buildRuntimeArtifacts(state.document, state.activeTrackIds, state.reverseRows);
        assert.deepEqual(fresh.renderInput.markerItems, buildCanvasMarkerItems(fresh.analysis, state.activeTrackIds));
        assert.deepEqual(state.renderInput, fresh.renderInput, "Direct artifact must match full rebuild, including draw order.");
        assert.equal(JSON.stringify(previous.renderInput), snapshot, "Previous input must not be mutated.");
        const events = state.analysis.trackResults.flatMap(track => track.events);
        assert.equal(new Set(events.map(event => event.eventId)).size, events.length, "Analyzer event IDs must remain unique.");
        const kind = getScoreTextEditInvalidationKind(commands);
        if (kind === "noteCell") {
          assert.equal(state.parsed.globalCellsByKindAndCol, previous.parsed.globalCellsByKindAndCol);
          assert.equal(state.analysis.timingTimeline, previous.analysis.timingTimeline);
          assert.equal(state.renderInput.globalMarkerItems, previous.renderInput.globalMarkerItems);
          const edited = new Set(commands.map(command => command.selection.trackId));
          for (const track of previous.analysis.trackResults) {
            if (!edited.has(track.trackId)) {
              assert.equal(state.analysis.trackResults.find(next => next.trackId === track.trackId), track);
              assert.equal(state.parsed.noteCellsByTrackAndCol.get(track.trackId), previous.parsed.noteCellsByTrackAndCol.get(track.trackId));
              for (const item of previous.renderInput.noteItems.filter(item => item.trackId === track.trackId)) {
                assert(state.renderInput.noteItems.includes(item), "Unedited track items must retain identity.");
              }
            }
          }
        } else if (kind === "globalCell") {
          assert.equal(state.analysis.trackResults, previous.analysis.trackResults);
          assert.equal(state.renderInput.noteItems, previous.renderInput.noteItems);
          assert.equal(state.renderInput.muteItems, previous.renderInput.muteItems);
          assert.equal(state.renderInput.noteMarkerItems, previous.renderInput.noteMarkerItems);
        }
      }
    }
    const unchanged = applyRawTextBatchEditToState(state, []);
    assert.equal(unchanged.kind, "unchanged");
    assert.equal(unchanged.state.document, state.document);
    const invalid = applyRawTextBatchEditToState(state, [edit("global-bpm", 0, "")]);
    assert.equal(invalid.kind, "rejected");
    assert.equal(invalid.message.level, "warning");
  }
}

testArtifactEdits();
const visibleRange = {
  startTick: 10,
  endTick: 20,
  startX: 210,
  endX: 420,
};
const visibleNoteItems = filterVisibleNoteItems([
  {
    sourceEventId: "before",
    rowId: "s1-note-60",
    displayCentOffset: 0,
    startTick: 0,
    endTick: 4,
    midi: 60,
    text: "A",
    displayShape: "rect",
    displayTextAnchors: [],
    effects: [],
  },
  {
    sourceEventId: "long-overlap",
    rowId: "s1-note-60",
    displayCentOffset: 0,
    startTick: 2,
    endTick: 12,
    midi: 60,
    text: "B",
    displayShape: "rect",
    displayTextAnchors: [],
    effects: [],
  },
  {
    sourceEventId: "inside",
    rowId: "s1-note-60",
    displayCentOffset: 0,
    startTick: 14,
    endTick: 15,
    midi: 60,
    text: "C",
    displayShape: "rect",
    displayTextAnchors: [],
    effects: [],
  },
  {
    sourceEventId: "after",
    rowId: "s1-note-60",
    displayCentOffset: 0,
    startTick: 24,
    endTick: 25,
    midi: 60,
    text: "D",
    displayShape: "rect",
    displayTextAnchors: [],
    effects: [],
  },
], visibleRange);

assert(
  visibleNoteItems.map((item) => item.sourceEventId).join(",") === "long-overlap,inside",
  "Visible note filter should keep overlapping items in original draw order.",
);

const visibleMuteItems = filterVisibleMuteItems([
  {
    sourceEventId: "mute-before",
    rowId: "s1-note-60",
    startTick: 0,
    endTick: 3,
    text: "before",
  },
  {
    sourceEventId: "mute-overlap",
    rowId: "s1-note-60",
    startTick: 9,
    endTick: 11,
    text: "overlap",
  },
  {
    sourceEventId: "mute-after",
    rowId: "s1-note-60",
    startTick: 22,
    endTick: 23,
    text: "after",
  },
], visibleRange);

assert(
  visibleMuteItems.map((item) => item.sourceEventId).join(",") === "mute-overlap",
  "Visible mute filter should use the same indexed overlap rule.",
);

const visibleMarkerItems = filterVisibleMarkerItems([
  { kind: "loopBoundary", tick: 10, role: "start" },
  { kind: "loopBoundary", tick: 20, role: "end" },
  { kind: "loopBoundary", tick: 24, role: "end" },
], visibleRange);

assert(
  visibleMarkerItems.length === 2 &&
    visibleMarkerItems[0]?.kind === "loopBoundary" &&
    visibleMarkerItems[0].role === "start" &&
    visibleMarkerItems[1]?.kind === "loopBoundary" &&
    visibleMarkerItems[1].role === "end",
  "Visible marker filter should include loop boundaries inside the viewport range.",
);


console.log("Partial artifact and viewport filter tests completed.");
