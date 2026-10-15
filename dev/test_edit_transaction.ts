/**
 * 편집 상태 확정 회귀 검사. main.ts의 실제 closure 본문을 추출하고 DOM/재생만 대역 처리한다.
 * 정상 경로와 실패 시 문서·산출물·이력 보존을 검사한다.
 */
import { applyEditEffects } from "../src/app/edit/edit_commit_effects";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createInitialState, applyRawTextBatchEditToState } from "../src/app/app_runtime";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";
import * as history from "../src/app/edit/edit_history";
import { isGameModeLocked } from "../src/app/game/game_types";
import type { AppState } from "../src/app/app_types";
import type { ScoreTextEdit } from "../src/core/score/score_text_edit";

const source = readFileSync(new URL("../src/app/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const boot = ast.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "boot");
assert(boot?.body);
const names = ["applyScoreTextEdits", "beginScoreEditHistoryTransaction", "endScoreEditHistoryTransaction", "cancelScoreEditHistoryTransaction", "applyUndo", "applyRedo"];
const declarations = names.map((name) => {
  const node = boot.body!.statements.find((statement) => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === name));
  assert(node, `Missing source declaration: ${name}`);
  return node.getText(ast);
});
const program = ts.transpileModule(`(function () {
  let state = initialState;
  let activeHistoryTransaction = null;
  ${declarations.join("\n")}
  return { ${names.join(", ")}, getState: () => state, getTransaction: () => activeHistoryTransaction };
})()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const fixture = readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8");
const loaded = loadRuntimeDocument(fixture);
assert(loaded.ok);
const base = createInitialState(loaded.document);
const noteRow = base.document.score.layout.rowDefinitions.find((row) => row.type === "note");
assert(noteRow);
const edit: ScoreTextEdit = {
  selection: { trackId: "basic", rowId: noteRow.rowId, rowKind: "note", col: 8 },
  rawText: "probe",
};

/**
 * 실제 코드의 제어 흐름에 장애 주입점과 부수효과 카운터를 제공한다.
 * - 인수 : initialState : 독립 검사에 사용할 시작 상태
 * - 반환값 : 추출한 앱 명령과 장애 주입 설정, 호출 횟수
 */
function harness(initialState: AppState = base) {
  const control = { reject: false, historyThrows: false, refreshThrows: false, refreshes: 0, stops: 0, syncThrows: false, renderThrows: false, renders: 0, resets: 0 };
  const api = runInNewContext(program, {
    initialState, ...history, isGameModeLocked, applyEditEffects, dom: {},
    syncEditOutcomeUi: () => {}, syncPlaybackUi: () => {}, playbackRuntime: {},
    stopPlaybackAfterEditFailure: () => { control.stops += 1; },
    render: () => { control.refreshes += 1; if (control.refreshThrows) throw new Error("refresh failed"); },
    buildCellHistoryPatches: (...args: Parameters<typeof history.buildCellHistoryPatches>) => {
      if (control.historyThrows) throw new Error("injected history failure");
      return history.buildCellHistoryPatches(...args);
    },
    beginPerfSession: () => null, endPerfSession: () => {},
    measurePerf: (_name: string, work: () => unknown) => work(),
    createDefaultHistoryLabel: () => "Probe edit",
    syncLeftStatus: () => {},
    syncUiControls: () => { if (control.syncThrows) throw new Error("injected UI sync failure"); },
    applyRawTextBatchEditToState: (state: AppState, edits: ScoreTextEdit[]) => control.reject
      ? { kind: "rejected", message: { level: "error", text: "injected rebuild failure" } }
      : applyRawTextBatchEditToState(state, edits),
    renderAfterScoreTextEdit: () => {
      control.renders += 1;
      if (control.renderThrows) throw new Error("injected render failure");
    },
    resetPlaybackForCurrentStatePreservingPosition: () => { control.resets += 1; },
  }) as {
    applyScoreTextEdits(edits: ScoreTextEdit[], options?: { uiAfter?: Pick<AppState, "rangeSelection" | "rangeClipboard" | "pastePreview"> }): void;
    applyUndo(): void;
    applyRedo(): void;
    beginScoreEditHistoryTransaction(label: string): void;
    endScoreEditHistoryTransaction(): void;
    getState(): AppState;
    cancelScoreEditHistoryTransaction(): void;
    getTransaction(): { beforeLookup: history.HistoryCellLookup } | null;
  };
  return { api, control };
}

/**
 * 정상 편집과 실패 시 상태 보존, 후속으로 남긴 경계의 동작을 검사한다.
 * - 인수 : 없음
 * - 반환값 : 없음. 계약과 다르면 assertion으로 종료한다.
 */
function run(): void {
  let cases = 0;
  const normal = harness();
  normal.api.applyScoreTextEdits([edit]);
  assert.equal(normal.api.getState().history.undoStack.length, 1);
  const editedScore = JSON.stringify(normal.api.getState().document.score);
  normal.api.applyUndo();
  assert.equal(JSON.stringify(normal.api.getState().document.score), JSON.stringify(base.document.score));
  assert.equal(normal.api.getState().history.redoStack.length, 1);
  // Undo 성공 시 최종 상태의 선택도 명세대로 해제한다.
  assert.equal(normal.api.getState().selection, null);
  normal.api.applyRedo();
  assert.equal(JSON.stringify(normal.api.getState().document.score), editedScore);
  console.log(++cases, "normal edit/undo/redo succeeds and clears selection");

  const failedUndo = harness();
  failedUndo.api.applyScoreTextEdits([edit]);
  const beforeUndo = failedUndo.api.getState();
  failedUndo.control.reject = true;
  failedUndo.api.applyUndo();
  assert.equal(failedUndo.api.getState().document, beforeUndo.document);
  assert.equal(failedUndo.api.getState().history, beforeUndo.history);
  assert.equal(failedUndo.api.getState().selection, beforeUndo.selection);
  assert.equal(failedUndo.api.getState().statusMessage.level, "error");
  assert.equal(failedUndo.api.getState().statusMessage.text, "injected rebuild failure");
  assert.equal(failedUndo.control.resets, 1);
  assert.equal(failedUndo.control.renders, 1);
  console.log(++cases, "failed undo preserves score/history/selection, shows error, skips render/playback");

  const failedRedo = harness();
  failedRedo.api.applyScoreTextEdits([edit]);
  failedRedo.api.applyUndo();
  const beforeRedo = failedRedo.api.getState();
  failedRedo.control.reject = true;
  failedRedo.api.applyRedo();
  assert.equal(failedRedo.api.getState().document, beforeRedo.document);
  assert.equal(failedRedo.api.getState().history, beforeRedo.history);
  assert.equal(failedRedo.control.resets, 2);
  assert.equal(failedRedo.api.getState().statusMessage.level, "error");
  console.log(++cases, "failed redo preserves score/history and shows error");

  const rejected = harness();
  rejected.api.applyScoreTextEdits([{ ...edit, rawText: "x".repeat(201) }]);
  assert.equal(rejected.api.getState().document, base.document);
  assert.equal(rejected.api.getState().history.undoStack.length, 0);
  assert.equal(rejected.api.getState().statusMessage.level, "warning");
  assert.equal(rejected.control.renders, 0);
  assert.equal(rejected.control.resets, 0);
  console.log(++cases, "actual 201-character rejection preserves state and skips render/playback");

  const noOp = harness();
  noOp.api.applyScoreTextEdits([edit]);
  const first = noOp.api.getState();
  noOp.api.applyScoreTextEdits([edit]);
  assert.equal(noOp.api.getState().history.undoStack.length, 1);
  assert.equal(noOp.api.getState().document, first.document);
  assert.equal(noOp.api.getState().parsed, first.parsed);
  assert.equal(noOp.api.getState().analysis, first.analysis);
  assert.equal(noOp.api.getState().renderInput, first.renderInput);
  assert.equal(noOp.control.resets, 1);
  assert.equal(noOp.control.renders, 1);
  console.log(++cases, "same-value edit preserves artifacts/history and skips score draw/playback reset");

  const noOpUi = harness(first);
  const uiAfter = { rangeSelection: null, rangeClipboard: null, pastePreview: { anchorCol: null } };
  noOpUi.api.applyScoreTextEdits([edit], { uiAfter });
  assert.equal(noOpUi.api.getState().pastePreview, uiAfter.pastePreview);
  assert.equal(noOpUi.api.getState().document, first.document);
  assert.equal(noOpUi.control.resets, 0);
  console.log(++cases, "unchanged range command still commits UI candidates");

  const retry = harness({ ...first, outputSyncError: "render: previous failure" });
  retry.api.applyScoreTextEdits([edit]);
  assert.equal(retry.api.getState().document, first.document);
  assert.equal(retry.api.getState().history, first.history);
  assert.equal(retry.api.getState().outputSyncError, undefined);
  assert.equal(retry.control.refreshes, 1);
  assert.equal(retry.control.resets, 1);
  console.log(++cases, "unchanged edit retries existing output failure without rebuilding artifacts");

  const redoNoOp = harness();
  redoNoOp.api.applyScoreTextEdits([edit]);
  redoNoOp.api.applyUndo();
  const beforeNoOp = redoNoOp.api.getState();
  redoNoOp.api.applyScoreTextEdits([{ ...edit, rawText: "" }]);
  assert.equal(redoNoOp.api.getState().history, beforeNoOp.history);
  assert.equal(redoNoOp.control.resets, 2);
  redoNoOp.api.applyRedo();
  assert.equal(redoNoOp.api.getState().history.undoStack.length, 1);
  console.log(++cases, "absent-cell delete preserves redo and redo remains usable");

  const unchangedDrag = harness();
  unchangedDrag.api.beginScoreEditHistoryTransaction("No change");
  unchangedDrag.api.applyScoreTextEdits([edit, { ...edit, rawText: "" }]);
  unchangedDrag.api.endScoreEditHistoryTransaction();
  assert.equal(unchangedDrag.api.getState().history, base.history);
  assert.equal(unchangedDrag.control.resets, 0);
  unchangedDrag.api.beginScoreEditHistoryTransaction("Net zero across frames");
  unchangedDrag.api.applyScoreTextEdits([edit]);
  unchangedDrag.api.applyScoreTextEdits([{ ...edit, rawText: "" }]);
  unchangedDrag.api.endScoreEditHistoryTransaction();
  assert.equal(unchangedDrag.api.getState().history, base.history);
  assert.equal(unchangedDrag.control.resets, 2);
  console.log(++cases, "net-zero batch skips effects; separate drag changes still draw without final history");

  const drag = harness();
  drag.api.beginScoreEditHistoryTransaction("Probe drag");
  drag.api.applyScoreTextEdits([edit]);
  drag.control.reject = true;
  drag.api.applyScoreTextEdits([{ ...edit, selection: { ...edit.selection, col: 9 } }]);
  drag.api.endScoreEditHistoryTransaction();
  assert.equal(drag.api.getState().history.undoStack.length, 1);
  assert.equal(drag.api.getState().history.undoStack[0].patches.length, 1);
  console.log(++cases, "drag groups successful net changes; rejected target creates no patch");

  const snapshot = harness();
  snapshot.api.beginScoreEditHistoryTransaction("Snapshot lifetime");
  const captured = snapshot.api.getTransaction()!.beforeLookup;
  assert.deepEqual(Object.keys(captured).sort(), ["cellMapByTrackId", "globalCellMapByCoord"]);
  assert.equal(captured.cellMapByTrackId, base.document.indexes.cellMapByTrackId);
  snapshot.api.applyScoreTextEdits([edit]);
  assert.equal(captured.cellMapByTrackId.get("basic")?.get(`${edit.selection.rowId}|8`), undefined);
  snapshot.api.applyScoreTextEdits([{ ...edit, rawText: "final" }]);
  snapshot.api.endScoreEditHistoryTransaction();
  assert.equal(snapshot.api.getTransaction(), null);
  const entry = snapshot.api.getState().history.undoStack[0];
  assert.equal(entry.patches.length, 1);
  assert.equal(entry.patches[0].beforeRawText, null);
  assert.equal(entry.patches[0].afterRawText, "final");
  snapshot.api.applyUndo();
  assert.equal(JSON.stringify(snapshot.api.getState().document.score), JSON.stringify(base.document.score));
  snapshot.api.applyRedo();
  assert.equal(snapshot.api.getState().document.indexes.cellMapByTrackId.get("basic")?.get(`${edit.selection.rowId}|8`)?.rawText, "final");
  console.log(++cases, "drag keeps original lookup through multiple batches, releases it, and supports undo/redo");

  snapshot.api.beginScoreEditHistoryTransaction("Cancelled snapshot");
  snapshot.api.cancelScoreEditHistoryTransaction();
  assert.equal(snapshot.api.getTransaction(), null);
  snapshot.api.beginScoreEditHistoryTransaction("Empty snapshot");
  snapshot.api.endScoreEditHistoryTransaction();
  assert.equal(snapshot.api.getTransaction(), null);
  console.log(++cases, "cancelled and empty transactions release snapshot references");

  const sync = harness();
  sync.control.syncThrows = true;
  sync.api.applyScoreTextEdits([edit]);
  assert.equal(sync.api.getState().busy.kind, "idle");
  assert.equal(sync.api.getState().document, base.document);
  console.log(++cases, "persistent pre-edit UI exception still leaves model busy idle");

  const render = harness();
  render.control.renderThrows = true;
  render.api.applyScoreTextEdits([edit]);
  assert.equal(render.api.getState().history.undoStack.length, 1);
  assert.notEqual(render.api.getState().document, base.document);
  assert.equal(render.control.resets, 1);
  assert.equal(render.control.refreshes, 1);
  assert.equal(render.control.stops, 1);
  console.log(++cases, "post-commit render exception refreshes once and rebuilds stopped playback");
  const historyFailure = harness();
  historyFailure.control.historyThrows = true;
  historyFailure.api.applyScoreTextEdits([edit]);
  assert.equal(historyFailure.api.getState().document, base.document);
  assert.equal(historyFailure.api.getState().history, base.history);
  assert.equal(historyFailure.control.resets, 0);
  assert.equal(historyFailure.api.getState().busy.kind, "idle");
  console.log(++cases, "history computation failure does not commit the prepared score");
  console.log(`Passed ${cases} transaction cases. This is not a browser or audio-device test.`);
}

run();
