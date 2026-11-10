/** 다운로드 JSON의 크기·왕복 보존과 저장 실패 시 상태 보존을 검증한다. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareScoreJsonExport, serializeScoreFile, downloadScoreJson } from "../src/infra/score_file_io";
import { SCORE_JSON_WARNING_BYTES, getUtf8ByteLength } from "../src/core/score/score_limits";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";
import { createInitialState } from "../src/app/app_runtime";
import { bindFileControls } from "../src/app/app_file_binding";
import type { AppDom } from "../src/app/app_types";
import type { ScoreFile } from "../src/core/score/types";

const loaded = loadRuntimeDocument(readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8"));
assert.ok(loaded.ok);
const base = loaded.document.score;

/**
 * 허용된 열·행·문자열 길이 안에서 용량 경계용 악보를 생성한다.
 * - 인수 : count : 여러 note 행에 분산할 셀 수
 * - 반환값 : 원본 fixture와 참조를 공유하지 않는 악보
 */
function createLargeScore(count: number): ScoreFile {
  const score = structuredClone(base);
  score.globalLines.columnCount = 10000;
  score.tracks[0].cells = Array.from({ length: count }, (_, index) => ({
    rowId: `s1-note-${60 + Math.floor(index / 10000)}`,
    col: index % 10000,
    rawText: "P".padEnd(200, " "),
  }));
  return score;
}

const normal = prepareScoreJsonExport(base);
assert.ok(normal.ok);
assert.equal(normal.jsonText, serializeScoreFile(base));
const large = createLargeScore(28000);
const before = JSON.stringify(large);
assert.ok(loadRuntimeDocument(before).ok);
assert.ok(getUtf8ByteLength(serializeScoreFile(large)) > SCORE_JSON_WARNING_BYTES);
const compact = prepareScoreJsonExport(large);
assert.ok(compact.ok);
assert.ok(getUtf8ByteLength(compact.jsonText) <= SCORE_JSON_WARNING_BYTES);
const reloaded = loadRuntimeDocument(compact.jsonText);
assert.ok(reloaded.ok);
assert.deepEqual(reloaded.document.score, large);
assert.equal(JSON.stringify(large), before);

// 정확한 바이트 경계까지 셀 내부 공백을 조절하여 <= 비교와 +1 바이트 실패를 확인한다.
const boundary = createLargeScore(35000);
let excess = getUtf8ByteLength(JSON.stringify(boundary)) - SCORE_JSON_WARNING_BYTES;
assert.ok(excess > 0);
for (const cell of boundary.tracks[0].cells) {
  const remove = Math.min(excess, cell.rawText.length - 1);
  cell.rawText = cell.rawText.slice(0, cell.rawText.length - remove);
  excess -= remove;
  if (excess === 0) break;
}
assert.equal(excess, 0);
const exact = prepareScoreJsonExport(boundary);
assert.ok(exact.ok);
assert.equal(getUtf8ByteLength(exact.jsonText), SCORE_JSON_WARNING_BYTES);
assert.ok(loadRuntimeDocument(exact.jsonText).ok);
boundary.tracks[0].cells[0].rawText += " ";
assert.equal(prepareScoreJsonExport(boundary).ok, false);
// Node에는 document가 없다. 초과 시 브라우저 다운로드 경로에 접근하면 이 호출은 실패한다.
assert.equal(downloadScoreJson(boundary).ok, false);

const unicode = createLargeScore(18000);
for (const cell of unicode.tracks[0].cells) cell.rawText = "도".repeat(200);
assert.ok(JSON.stringify(unicode).length < SCORE_JSON_WARNING_BYTES);
assert.equal(prepareScoreJsonExport(unicode).ok, false, "UTF-8 bytes, not JS string length, govern the limit.");
const approvedExport = prepareScoreJsonExport(unicode, () => true);
assert(approvedExport.ok, "Approval must allow files over 8 MiB.");
assert(getUtf8ByteLength(approvedExport.jsonText) > SCORE_JSON_WARNING_BYTES);
assert(loadRuntimeDocument(approvedExport.jsonText, () => true).ok, "Approved large exports must load again.");

// 실제 버튼 바인딩을 실행하되 초과 악보의 렌더링 없이 실패 전후 상태 참조를 확인한다.
const button = new EventTarget();
const dom = {
  jsonDownloadButton: button, jsonLoadButton: new EventTarget(), jsonLoadInput: new EventTarget(),
  localSaveButton: new EventTarget(), localLoadButton: new EventTarget(),
  leftStatusLine: { textContent: "", dataset: {}, title: "", parentElement: null },
} as unknown as AppDom;
const initial = createInitialState(loaded.document);
let state: typeof initial = { ...initial, document: { ...initial.document, score: unicode }, scoreOrigin: "template" };
const original = state;
bindFileControls(dom, { getState: () => state, setState: (next) => { state = next; }, loadScoreJsonText: () => false });
const originalWindow = globalThis.window;
Object.assign(globalThis, { window: { confirm: () => false } });
button.dispatchEvent(new Event("click"));
Object.assign(globalThis, { window: originalWindow });
assert.equal(state.statusMessage.level, "error");
assert.equal(state.document, original.document);
assert.equal(state.scoreOrigin, original.scoreOrigin);
assert.equal(state.history, original.history);
assert.equal(state.document.score.musicData, original.document.score.musicData);
console.log("Score JSON export boundary tests passed.");
