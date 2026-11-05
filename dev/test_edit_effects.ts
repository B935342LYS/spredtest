/** 편집 확정 후 복구 순서와 비동기 재생 중단의 회귀 검사. */
import assert from "node:assert/strict";
import { applyEditEffects } from "../src/app/edit/edit_commit_effects";
import { createPlaybackController } from "../src/audio/playback_controller";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { AppNotePreviewRuntime } from "../src/app/playback/app_note_preview";

/**
 * 실패 단계에 따라 제한된 복구와 재생 정리가 수행되는지 검사한다.
 * - 인수 : 없음
 * - 반환값 : 없음
 */
function testEffects(): void {
  for (const scenario of ["normal", "render", "refresh", "audio", "stop"] as const) {
    const calls: string[] = [];
    const result = applyEditEffects({
      render: () => { calls.push("render"); if (["render", "refresh", "stop"].includes(scenario)) throw new Error("render failed"); },
      refresh: () => { calls.push("refresh"); if (scenario === "refresh") throw new Error("refresh failed"); },
      updatePlayback: () => { calls.push("audio"); if (scenario === "audio") throw new Error("audio failed"); },
      stopPlayback: () => { calls.push("stop"); if (scenario === "stop") throw new Error("stop failed"); },
    });
    const expected = {
      normal: ["render", "audio"], render: ["render", "stop", "refresh", "audio"],
      refresh: ["render", "stop", "refresh"], audio: ["render", "audio", "stop"], stop: ["render", "stop"],
    };
    assert.deepEqual(calls, expected[scenario]);
    assert.equal(result.kind, scenario === "normal" || scenario === "render" ? "ready" : "failed");
    if (result.kind === "failed") assert.equal(result.stage, scenario === "refresh" ? "render" : scenario === "audio" ? "playback" : "stop");
  }
}

/**
 * 대기 중인 backend 준비가 stop/pause/dispose 뒤 완료되어도 재생하지 않는지 검사한다.
 * - 인수 : 없음
 * - 반환값 : 비동기 검사 완료 Promise
 */
async function testPendingPlayback(): Promise<void> {
  for (const action of ["stop", "pause", "pauseAtSeconds", "dispose", "replace"] as const) {
    const releases: (() => void)[] = [];
    let scheduled = 0;
    const controller = createPlaybackController({
      schedule: { durationSeconds: 5, events: [] }, schedulerIntervalMs: 25,
      backend: {
        ensureStarted: () => new Promise<void>(resolve => releases.push(resolve)),
        getCurrentTime: () => 0, scheduleEvent: () => {}, setMasterVolume: () => {}, stopAll: () => {}, dispose: () => {},
      },
      scheduler: { scheduleLookahead: () => ++scheduled, resetScheduledEvents: () => {}, getScheduledEventCount: () => scheduled },
    });
    try {
      const pending = controller.playFromSeconds(0);
      if (action === "replace") {
        const newer = controller.playFromSeconds(1);
        releases[0]();
        await pending;
        assert.equal(scheduled, 0);
        releases[1]();
        await newer;
        assert.equal(controller.getState().kind, "playing");
        assert.equal(scheduled, 1);
      } else {
        if (action === "pauseAtSeconds") controller.pauseAtSeconds(2);
        else controller[action]();
        releases[0]();
        await pending;
        assert.equal(controller.isPlaying(), false);
        assert.equal(scheduled, 0);
      }
    } finally { controller.dispose(); }
  }
}

/**
 * 실제 preview 함수의 대기 중 ensureStarted가 취소 뒤 소리를 예약하지 않는지 검사한다.
 * - 인수 : 없음
 * - 반환값 : 비동기 검사 완료 Promise
 */
async function testPendingNotePreview(): Promise<void> {
  const source = readFileSync(new URL("../src/app/playback/app_note_preview.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("preview.ts", source, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
  const code = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  for (const cancelled of [false, true]) {
    let release!: () => void;
    let scheduled = 0;
    const exports: { createAppNotePreviewRuntime?: (dom: unknown) => AppNotePreviewRuntime } = {};
    runInNewContext(code, { exports, performance: { now: () => 1000 }, createOscillatorBackend: () => ({
      ensureStarted: () => new Promise<void>(resolve => { release = resolve; }),
      scheduleEvent: () => { scheduled += 1; }, dispose: () => {},
    }) });
    const preview = exports.createAppNotePreviewRuntime!({ waveSelect: { value: "sine" }, volumeInput: { value: "100" } });
    preview.previewMidi(60);
    if (cancelled) preview.dispose();
    release();
    await Promise.resolve();
    assert.equal(scheduled, cancelled ? 0 : 1);
  }
}

testEffects();
await testPendingPlayback();
await testPendingNotePreview();
console.log("Edit effects: 5 recovery, 5 pending playback and 2 pending preview cases passed.");
