/** A4/A6의 순수 계산 구간만 기존 방식과 교대 비교한다. 브라우저 draw 측정은 아니다. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRuntimeDocument } from "../src/core/score/create_runtime_document";
import type { ScoreFile } from "../src/core/score/types";
import { createInitialState, applyMusicDataEditToState } from "../src/app/app_runtime";
import { buildCanvasGlobalMarkerItems, buildCanvasNoteMarkerItems, buildCanvasMarkerItems } from "../src/renderer/canvas_item_builder";
import { sortCanvasMarkerItems } from "../src/renderer/canvas_item_order";

/**
 * 구현 전후 계산을 워밍업 후 교대 측정한다.
 * - 인수 : before : 기존 계산
 * - 인수 : after : 재사용 계산
 * - 반환값 : 51회 실행 중앙값(ms)
 */
function compare(before: () => unknown, after: () => unknown) {
  for (let i = 0; i < 10; i++) { before(); after(); }
  const times = [[], []] as number[][];
  for (let i = 0; i < 51; i++) {
    for (const index of i % 2 === 0 ? [0, 1] : [1, 0]) {
      const start = performance.now();
      const value = index === 0 ? before() : after();
      times[index]!.push(performance.now() - start);
      assert.ok(value);
    }
  }
  return { beforeMs: times[0]!.sort((a, b) => a - b)[25], afterMs: times[1]!.sort((a, b) => a - b)[25] };
}

const results = [];
for (const columns of [100, 1000, 9000]) {
  const score = JSON.parse(readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8")) as ScoreFile;
  score.globalLines.columnCount = columns;
  // 세 track에 같은 위치의 gliss/tuplet을 배치해 종류·track 정렬을 포함한다.
  for (const track of score.tracks) {
    track.cells = [];
    for (let col = 0; col + 6 < columns; col += 8) {
      track.cells.push({ rowId: "s1-note-60", col, rawText: "C@g(a,S)" },
        { rowId: "s1-note-64", col: col + 2, rawText: "E@g(a,E)" },
        { rowId: "s1-note-60", col: col + 4, rawText: "/3(C@n(60)|D@n(62)|E@n(64))" });
    }
  }
  const state = createInitialState(createRuntimeDocument(score));
  const metadata = { ...score.musicData, musicTitle: "Measured title" };
  /**
   * 기존 전체 경로의 분리 목록과 통합 목록 중복 생성을 재현한다.
   * - 인수 : 없음
   * - 반환값 : 세 marker 목록
   */
  const beforeMarkers = () => ({
    globalMarkerItems: buildCanvasGlobalMarkerItems(state.analysis),
    noteMarkerItems: buildCanvasNoteMarkerItems(state.analysis, state.activeTrackIds),
    markerItems: buildCanvasMarkerItems(state.analysis, state.activeTrackIds),
  });
  /**
   * 같은 분석 입력에서 생성 목록을 병합하는 새 계산을 수행한다.
   * - 인수 : 없음
   * - 반환값 : 세 marker 목록
   */
  const afterMarkers = () => {
    const globalMarkerItems = buildCanvasGlobalMarkerItems(state.analysis);
    const noteMarkerItems = buildCanvasNoteMarkerItems(state.analysis, state.activeTrackIds);
    return { globalMarkerItems, noteMarkerItems, markerItems: sortCanvasMarkerItems([...globalMarkerItems, ...noteMarkerItems]) };
  };
  /**
   * metadata 편집에서 인덱스를 다시 만들던 기존 helper 결과를 재현한다.
   * - 인수 : 없음
   * - 반환값 : metadata가 바뀐 상태
   */
  const beforeMetadata = () => ({ ...state,
    document: createRuntimeDocument({ ...score, musicData: metadata }),
    statusMessage: { level: "info", text: "Score details updated." },
  });
  assert.deepEqual(beforeMarkers(), afterMarkers());
  assert.deepEqual(beforeMetadata(), applyMusicDataEditToState(state, metadata));
  results.push({ columns, cells: score.tracks.reduce((sum, track) => sum + track.cells.length, 0),
    markers: afterMarkers().markerItems.length,
    markerGroups: compare(beforeMarkers, afterMarkers),
    metadataHelper: compare(beforeMetadata, () => applyMusicDataEditToState(state, metadata)),
  });
}
const output = { runtime: process.version, platform: process.platform, warmupPairs: 10, samplesPerVariant: 51,
  scope: "Node pure computation; excludes analysis, DOM/render, audio; alternating order; synthetic scores", results };
writeFileSync(new URL("../../docs/review-support/runtime-reuse-benchmark.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
