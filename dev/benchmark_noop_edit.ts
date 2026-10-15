/** 무변경 최적화 전후의 셀 적용과 산출물 계산을 같은 입력으로 비교한다. */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { createRuntimeDocument } from "../src/core/score/create_runtime_document";
import { createInitialState, applyRawTextBatchEditToState } from "../src/app/app_runtime";
import { applyScoreCellRawTextBatch } from "../src/app/edit/edit_apply";
import { type ScoreTextEdit } from "../src/core/score/score_text_edit";
import type { ScoreFile } from "../src/core/score/types";

/**
 * 독립된 고정 입력을 반복 측정한다. 준비 및 워밍업은 측정에서 제외한다.
 * - 인수 : work : 한 번의 편집 계산
 * - 인수 : repetitions : 표본당 반복 수
 * - 반환값 : 호출당 중앙값과 10/90 백분위 시간(ms)
 */
function measure(work: () => unknown, repetitions: number) {
  for (let i = 0; i < 10; i++) work();
  const samples: number[] = [];
  for (let i = 0; i < 31; i++) {
    const start = performance.now();
    for (let j = 0; j < repetitions; j++) work();
    samples.push((performance.now() - start) / repetitions);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[15], p10Ms: samples[3], p90Ms: samples[27] };
}

const results = [];
for (const size of [128, 9000]) {
  const score = JSON.parse(readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8")) as ScoreFile;
  score.globalLines.columnCount = size;
  score.tracks[0].cells = Array.from({ length: size }, (_, col) => ({ rowId: "s1-note-52", col, rawText: "E3" }));
  const state = createInitialState(createRuntimeDocument(score));
  for (const count of [1, Math.min(size, 1000)]) {
    for (const mode of ["changed", "half", "unchanged"] as const) {
      const edits: ScoreTextEdit[] = Array.from({ length: count }, (_, col) => ({
        selection: { trackId: "basic", rowId: "s1-note-52", col, rowKind: "note" },
        rawText: mode === "unchanged" || (mode === "half" && col % 2 === 0) ? "E3" : "F3",
      }));
      results.push({ size, count, mode,
        apply: measure(() => applyScoreCellRawTextBatch(score, edits), size === 128 ? 100 : 10),
        runtime: measure(() => applyRawTextBatchEditToState(state, edits), 1),
      });
    }
  }
}
const output = { node: process.version, cpu: cpus()[0].model, samples: 31, warmup: 10,
  scope: "fixed-input cell apply and runtime artifacts; excludes DOM, history, audio runtime and UI", results };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(output, null, 2));
console.log(JSON.stringify(output, null, 2));
