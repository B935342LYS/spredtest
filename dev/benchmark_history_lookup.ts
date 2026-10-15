/** E6 비교 검사. 기준의 선형 탐색과 현재 제품 인덱스 조회의 비용·결과를 비교한다. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { buildCellHistoryPatches as indexed } from "../src/app/edit/edit_history";
import { applyScoreCellRawTextBatch } from "../src/app/edit/edit_apply";
import { type ScoreTextEdit, type ScoreEditSelection } from "../src/core/score/score_text_edit";
import { createRuntimeDocument } from "../src/core/score/create_runtime_document";
import type { ScoreFile, ScoreIndexes } from "../src/core/score/types";
import type { CellHistoryPatch } from "../src/app/app_types";

type Lookup = Pick<ScoreIndexes, "cellMapByTrackId" | "globalCellMapByCoord">;

// 7d758f8의 이력 조회를 그대로 보존한 비교 전용 기준이다.
/**
 * score edit batch의 적용 전후 rawText 차이를 history patch로 만든다.
 * - 인수 : beforeScore : edit 적용 전 score JSON
 * - 인수 : afterScore : edit 적용 후 score JSON
 * - 인수 : edits : 적용을 시도한 score cell edit 목록
 * - 반환값 : 실제 rawText가 바뀐 cell patch 목록
 */
function buildCellHistoryPatches(
  beforeScore: ScoreFile,
  afterScore: ScoreFile,
  edits: readonly ScoreTextEdit[],
): CellHistoryPatch[] {
  const targets = new Map<string, ScoreEditSelection>();

  // 같은 batch 안에서 같은 cell이 여러 번 나오면 최종 좌표 1개만 history 대상으로 남긴다.
  for (const edit of edits) {
    targets.set(createHistorySelectionKey(edit.selection), edit.selection);
  }

  const patches: CellHistoryPatch[] = [];

  for (const selection of targets.values()) {
    const beforeRawText = readCellRawText(beforeScore, selection);
    const afterRawText = readCellRawText(afterScore, selection);

    if (beforeRawText === afterRawText) {
      continue;
    }

    patches.push({
      selection,
      beforeRawText,
      afterRawText,
    });
  }

  return patches;
}

/**
 * score에서 edit selection에 해당하는 cell rawText를 찾는다.
 * - 인수 : score : 조회할 score JSON
 * - 인수 : selection : 조회할 score cell 좌표
 * - 반환값 : 존재하는 rawText 또는 cell 없음
 */
function readCellRawText(
  score: ScoreFile,
  selection: ScoreEditSelection,
): string | null {
  if (selection.rowKind === "global") {
    return score.globalLines.cells.find((cell) =>
      cell.rowId === selection.rowId && cell.col === selection.col
    )?.rawText ?? null;
  }

  if (selection.rowKind !== "note") {
    return null;
  }

  return score.tracks
    .find((track) => track.trackId === selection.trackId)
    ?.cells.find((cell) =>
      cell.rowId === selection.rowId && cell.col === selection.col
    )?.rawText ?? null;
}

/**
 * history patch 병합에 사용할 score cell 좌표 key를 만든다.
 * - 인수 : selection : score edit 좌표
 * - 반환값 : row kind, track, row, column을 포함한 key
 */
function createHistorySelectionKey(selection: ScoreEditSelection): string {
  const trackKey = selection.rowKind === "global" ? "global" : selection.trackId;

  return `${selection.rowKind}|${trackKey}|${selection.rowId}|${selection.col}`;
}

/**
 * 비교용 임시 조회표를 만든다. 전체 runtime 재생성은 수행하지 않는다.
 * - 인수 : score : 인덱싱할 악보
 * - 반환값 : 셀 조회에 필요한 두 Map
 */
function lookup(score: ScoreFile): Lookup {
  return {
    cellMapByTrackId: new Map(score.tracks.map(track => [track.trackId,
      new Map(track.cells.map(cell => [`${cell.rowId}|${cell.col}` as const, cell]))])),
    globalCellMapByCoord: new Map(score.globalLines.cells.map(cell => [`${cell.rowId}|${cell.col}` as const, cell])),
  };
}

/**
 * 같은 입력을 반복 호출하여 호출당 비용을 측정한다.
 * - 인수 : work : 조사 대상 함수
 * - 반환값 : 21표본 중앙값과 p10/p90(ms)
 */
function measure(work: () => unknown) {
  for (let i = 0; i < 5; i++) work();
  const samples: number[] = [];
  for (let i = 0; i < 21; i++) {
    const start = performance.now();
    for (let j = 0; j < 5; j++) work();
    samples.push((performance.now() - start) / 5);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[10], p10Ms: samples[2], p90Ms: samples[18] };
}

const fixture = JSON.parse(readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8")) as ScoreFile;
const results = [];
for (const size of [128, 9000]) for (const count of [1, 64, Math.min(size, 1000)]) for (const position of ["head", "tail"]) {
  const before = structuredClone(fixture);
  before.globalLines.columnCount = size;
  before.tracks[0].cells = Array.from({ length: size }, (_, col) => ({ rowId: "s1-note-52", col, rawText: "E3" }));
  const edits: ScoreTextEdit[] = Array.from({ length: count }, (_, index) => ({
    selection: { trackId: "basic", rowId: "s1-note-52", rowKind: "note", col: (position === "tail" ? size - count : 0) + index }, rawText: "F3",
  }));
  const applied = applyScoreCellRawTextBatch(before, edits);
  assert(applied.ok);
  const after = applied.score;
  // 일반 편집 전후에 이미 존재하는 인덱스의 준비는 측정에서 제외한다.
  const beforeIndex = createRuntimeDocument(before).indexes;
  const afterIndex = createRuntimeDocument(after).indexes;
  assert.deepEqual(indexed(beforeIndex, afterIndex, edits), buildCellHistoryPatches(before, after, edits));
  const work = {
    linear: () => buildCellHistoryPatches(before, after, edits),
    temporaryMap: () => indexed(lookup(before), lookup(after), edits),
    existingIndex: () => indexed(beforeIndex, afterIndex, edits),
  };
  for (let round = 0; round < 3; round++) {
    const order = round % 2 ? ["existingIndex", "temporaryMap", "linear"] as const : ["linear", "temporaryMap", "existingIndex"] as const;
    const times = {} as Record<keyof typeof work, ReturnType<typeof measure>>;
    for (const name of order) times[name] = measure(work[name]);
    results.push({ size, count, position, round, times });
  }
  console.log(`Measured ${size} cells / ${count} targets / ${position}`);
}

// 누락·중복 좌표·global의 track 무시·복원 시의 규칙도 기존 함수와 비교한다.
const original = createRuntimeDocument(fixture);
const note: ScoreTextEdit = { selection: { trackId: "basic", rowKind: "note", rowId: "s1-note-52", col: 0 }, rawText: "" };
const global: ScoreTextEdit = { selection: { trackId: "basic", rowKind: "global", rowId: "global-bpm", col: 0 }, rawText: "145" };
const checks: ScoreTextEdit[][] = [
  [], [note], [note, { ...note, rawText: "E3" }],
  [{ ...note, selection: { ...note.selection, col: 12 }, rawText: "E3" }],
  [global, { ...global, selection: { ...global.selection, trackId: "optional" }, rawText: "150" }],
  [note, global],
];
for (const edits of checks) {
  const applied = applyScoreCellRawTextBatch(fixture, edits);
  assert(applied.ok);
  const next = createRuntimeDocument(applied.score);
  for (const [a, b] of [[original, next], [next, original]]) {
    assert.deepEqual(indexed(a.indexes, b.indexes, edits), buildCellHistoryPatches(a.score, b.score, edits));
  }
}
const missing: ScoreTextEdit[] = [
  { ...note, selection: { ...note.selection, trackId: "extra", col: 100 } },
  { ...note, selection: { ...note.selection, rowKind: "gap" } },
];
assert.deepEqual(indexed(original.indexes, original.indexes, missing), buildCellHistoryPatches(fixture, fixture, missing));
writeFileSync(new URL("../../docs/review-support/history-lookup-implemented.json", import.meta.url), JSON.stringify({
  date: "2026-10-09", cpu: cpus()[0].model, node: process.version, warmup: 5, samples: 21, repeats: 5,
  scope: "history helper only; existingIndex excludes preparation because runtime indexes already exist; temporaryMap includes creation of all cell maps", equivalenceChecks: 25, results,
}, null, 2));
