import { readFileSync } from "node:fs";
import { runLayoutPitchShiftTests } from "./test_layout_pitch_shift";
import { runLayoutPitchApplyTests } from "./test_layout_pitch_apply";

import {
  applyLayoutDraftEditToState,
  createInitialState,
} from "../src/app/app_runtime";
import {
  applyLayoutDraftToScore,
  calculateLayoutCellDeletionSummary,
} from "../src/app/layout/layout_apply";
import {
  addLayoutDraftRow,
  createLayoutDraftBundle,
  deleteLayoutDraftRow,
} from "../src/app/layout/layout_draft";
import {
  createLayoutDraftFromPreset,
  createLayoutPresetFileName,
  createUserLayoutPresetData,
} from "../src/app/layout/layout_preset";
import {
  MAX_LAYOUT_PRESET_JSON_BYTES,
  parseUserLayoutPresetJson,
  serializeUserLayoutPresetData,
} from "../src/core/score/layout_preset";
import {
  InvalidLayoutPresetSlotError,
  loadLayoutPresetSlotFromLocalStorage,
  loadLayoutPresetSlotsFromLocalStorage,
  saveLayoutPresetSlotToLocalStorage,
} from "../src/infra/layout_preset_storage";
import { NORMAL_SCORE_LAYOUT_PRESET } from "../src/assets/templates/normal-score-layout-preset";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";

/**
 * 조건이 거짓이면 테스트 실패 상태를 기록한다.
 * - 인수 : condition : 통과 조건
 * - 인수 : message : 실패 시 출력할 메시지
 * - 반환값 : 없음
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
  }
}

/**
 * Node 테스트 환경에서 layout preset storage가 사용할 localStorage mock을 설치한다.
 * - 인수 : 없음
 * - 반환값 : 없음
 */
function installLocalStorageMock(): void {
  const storage = new Map<string, string>();

  globalThis.localStorage = {
    getItem(key: string): string | null {
      return storage.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      storage.set(key, value);
    },
    removeItem(key: string): void {
      storage.delete(key);
    },
    clear(): void {
      storage.clear();
    },
    key(index: number): string | null {
      return Array.from(storage.keys())[index] ?? null;
    },
    get length(): number {
      return storage.size;
    },
  };
}

const fixtureUrl = new URL("./test_cases/minimal-valid-score.json", import.meta.url);
const jsonText = readFileSync(fixtureUrl, "utf8");
const loadResult = loadRuntimeDocument(jsonText);

installLocalStorageMock();

assert(loadResult.ok, "Runtime document should load for layout apply test.");

if (loadResult.ok) {
  const score = loadResult.document.score;
  runSharedLayoutSlotTests(score);
  runLayoutPitchShiftTests(score);
  runLayoutPitchApplyTests(score);
  const draft = createLayoutDraftBundle(score);
  const presetResult = createUserLayoutPresetData(draft);
  const longNamePresetResult = createUserLayoutPresetData(
    {
      ...draft,
      layoutPresetDisplayName: "1234567890123456789012345678901",
    },
  );
  const oversizedPresetResult = parseUserLayoutPresetJson(" ".repeat(MAX_LAYOUT_PRESET_JSON_BYTES + 1));
  const outOfRangeNoteAddResult = addLayoutDraftRow(draft, {
    rowType: "note",
    height: 7,
    position: "above",
  });

  assert(
    outOfRangeNoteAddResult.ok && outOfRangeNoteAddResult.message.includes("outside"),
    "Layout draft should allow an out-of-range note and explain the configured instrument range.",
  );

  globalThis.localStorage.setItem(
    "layout-slot:shared:v1:1",
    JSON.stringify({
      formatVersion: "1",
      layoutPresetId: "slot-1",
      layoutPresetDisplayName: "Broken Local Slot",
      instrumentPresetId: (score.instData.presetId ?? "custom"),
      createdAt: "2026-06-21T00:00:00.000Z",
      updatedAt: "2026-06-21T00:00:00.000Z",
      instData: score.instData,
      rowDefinitions: [
        {
          rowId: "s1-note-128",
          type: "note",
          stringId: "s1",
          midi: 128,
          height: 7,
          displayLabel: "G#6",
        },
      ],
    }),
  );

  assert(
    loadLayoutPresetSlotsFromLocalStorage()[0]?.readError !== undefined &&
      globalThis.localStorage.getItem("layout-slot:shared:v1:1") !== null,
    "Invalid local layout preset should remain stored and be reported as an error.",
  );
  globalThis.localStorage.clear();

  const unchangedLayoutApplyResult = applyLayoutDraftToScore(score, draft);

  assert(
    unchangedLayoutApplyResult.ok,
    "Unchanged layout apply should succeed.",
  );

  if (unchangedLayoutApplyResult.ok) {
    assert(
      unchangedLayoutApplyResult.score !== score,
      "Layout apply should return a new ScoreFile object.",
    );
    assert(
      unchangedLayoutApplyResult.score.tracks === score.tracks,
      "Layout apply should reuse tracks when no cells are deleted.",
    );
    assert(
      unchangedLayoutApplyResult.score.globalLines === score.globalLines,
      "Layout apply should reuse globalLines during structural sharing.",
    );
  }

  assert(presetResult.ok, "Layout preset data should be created from a valid draft.");
  assert(
    !longNamePresetResult.ok,
    "Layout preset creation should reject names longer than 30 characters.",
  );
  assert(
    !oversizedPresetResult.ok,
    "Layout preset parser should reject JSON larger than the preset size limit.",
  );

  if (presetResult.ok) {
    const presetJson = JSON.stringify(presetResult.value);
    const serializedPresetResult = serializeUserLayoutPresetData(presetResult.value);
    const parsedPresetResult = parseUserLayoutPresetJson(presetJson);

    assert(serializedPresetResult.ok, "Layout preset serialization should accept a normal preset.");
    assert(parsedPresetResult.ok, "Layout preset JSON should parse after serialization.");

    // 실제 저장 문자열을 다시 읽어 들인 뒤 들여쓰기와 마지막 개행까지 같은지 확인한다.
    if (serializedPresetResult.ok) {
      const roundTrip = parseUserLayoutPresetJson(serializedPresetResult.value);
      if (roundTrip.ok) {
        const rewritten = serializeUserLayoutPresetData(roundTrip.value);
        assert(rewritten.ok && rewritten.value === serializedPresetResult.value,
          "Preset JSON should survive parse/serialize without changing stored bytes.");
      } else {
        assert(false, "Serialized preset should parse successfully.");
      }
    }

    if (parsedPresetResult.ok) {
      const restoredDraft = createLayoutDraftFromPreset(parsedPresetResult.value, draft);
      const beforePreset = JSON.stringify(parsedPresetResult.value);
      const independentlyRestored = createLayoutDraftFromPreset(parsedPresetResult.value, draft);
      independentlyRestored.instData.strings[0]!.stringName = "Changed in draft";
      independentlyRestored.rowDefinitions[0]!.height = 99;
      assert(JSON.stringify(parsedPresetResult.value) === beforePreset,
        "Editing restored rows or strings must not mutate the source preset.");
      assert(restoredDraft.selectedStringId === draft.selectedStringId &&
        restoredDraft.selectedRowId === restoredDraft.rowDefinitions.find(
          row => row.stringId === draft.selectedStringId)?.rowId,
        "Restore should retain the selected string and choose its first row.");
      const missingSelection = createLayoutDraftFromPreset(parsedPresetResult.value,
        { ...draft, selectedStringId: "missing-string" });
      assert(missingSelection.selectedStringId === parsedPresetResult.value.instData.strings[0]?.stringId,
        "Missing selected string should fall back to the preset first string.");
      const emptySlots = loadLayoutPresetSlotsFromLocalStorage();

      assert(
        restoredDraft.layoutPresetDisplayName === draft.layoutPresetDisplayName,
        "Layout preset restore should keep display name.",
      );
      assert(
        restoredDraft.rowDefinitions.length === draft.rowDefinitions.length,
        "Layout preset restore should keep editable row count.",
      );
      assert(
        createLayoutPresetFileName(parsedPresetResult.value) === "layout-Otamatone_DX_Basic.json",
        "Layout preset file name should use only the layout preset display name.",
      );
      assert(
        emptySlots.length === 3 &&
          emptySlots[0]?.preset?.layoutPresetDisplayName === "Normal Score" &&
          emptySlots[1]?.preset === null &&
          emptySlots[2]?.preset === null,
        "Local layout preset storage should expose bundled Normal Score in slot 1 initially.",
      );

      const savedSlots = saveLayoutPresetSlotToLocalStorage(parsedPresetResult.value, 2);
      const loadedSlotPreset = loadLayoutPresetSlotFromLocalStorage(2);

      assert(
        savedSlots[1]?.preset?.layoutPresetDisplayName === parsedPresetResult.value.layoutPresetDisplayName,
        "Local layout preset storage should save data into the selected slot.",
      );
      assert(
        loadedSlotPreset?.layoutPresetId === "slot-2",
        "Local layout preset storage should normalize local preset id to the selected slot.",
      );
    }
  }

  globalThis.localStorage.clear();

  const normalScoreSlots = loadLayoutPresetSlotsFromLocalStorage();
  const normalScoreSlot = loadLayoutPresetSlotFromLocalStorage(1);

  // 기본 제공 객체의 반환값을 수정해도 다음 조회와 asset 원본은 보존한다.
  if (normalScoreSlot !== null) {
    const bundledBefore = JSON.stringify(NORMAL_SCORE_LAYOUT_PRESET);
    const independent = loadLayoutPresetSlotFromLocalStorage(1)!;
    independent.instData.strings[0]!.stringName = "Changed copy";
    independent.rowDefinitions[0]!.height = 99;
    assert(JSON.stringify(NORMAL_SCORE_LAYOUT_PRESET) === bundledBefore &&
      JSON.stringify(loadLayoutPresetSlotFromLocalStorage(1)) === bundledBefore,
      "Bundled preset must remain independent of returned mutable copies.");
  }
  const brokenKey = "layout-slot:shared:v1:1";
  globalThis.localStorage.setItem(brokenKey, "{broken");
  let rejectedCorruptSlot = false;
  try { loadLayoutPresetSlotFromLocalStorage(1); }
  catch (error) { rejectedCorruptSlot = error instanceof InvalidLayoutPresetSlotError; }
  assert(rejectedCorruptSlot && globalThis.localStorage.getItem(brokenKey) === "{broken",
    "Corrupt slot should reject loading without deleting or replacing its bytes.");
  assert(loadLayoutPresetSlotsFromLocalStorage()[0]?.readError !== undefined,
    "Corrupt slot should not be presented as Empty or the bundled preset.");
  globalThis.localStorage.clear();

  assert(
    normalScoreSlots[0]?.layoutPresetDisplayName === "Normal Score",
    "Bundled Normal Score preset should appear in slot 1 for otamatone-basic.",
  );
  assert(
    normalScoreSlot?.layoutPresetDisplayName === "Normal Score",
    "Bundled Normal Score preset should load from slot 1 when no user preset is saved.",
  );
  assert(
    normalScoreSlot?.rowDefinitions.length === 37 &&
      normalScoreSlot.rowDefinitions.every((row) => row.type === "note" && row.height === 21),
    "Bundled Normal Score preset should contain only 21px note rows from C3 to C6.",
  );
  assert(
    NORMAL_SCORE_LAYOUT_PRESET.instData.strings[0]?.minMidi === 48 &&
      NORMAL_SCORE_LAYOUT_PRESET.instData.strings[0]?.maxMidi === 84,
    "Bundled Normal Score instrument range should be C3..C6.",
  );

  const invalidPresetResult = parseUserLayoutPresetJson(JSON.stringify({
    formatVersion: "1",
    layoutPresetId: "invalid",
    layoutPresetDisplayName: "Invalid",
    instrumentPresetId: (score.instData.presetId ?? "custom"),
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
    instData: score.instData,
    rowDefinitions: [
      { rowId: "global-bpm", type: "global", kind: "bpm", height: 21 },
    ],
  }));

  assert(
    !invalidPresetResult.ok,
    "Layout preset parser should reject global rowDefinitions.",
  );

  const boundaryGapDeleteResult = deleteLayoutDraftRow(draft, "s1-gap-51-52");

  assert(boundaryGapDeleteResult.ok, "Boundary gap row should be removable in draft.");

  if (boundaryGapDeleteResult.ok) {
    const noteDeleteResult = deleteLayoutDraftRow(boundaryGapDeleteResult.draft, "s1-note-52");

    assert(noteDeleteResult.ok, "Bottom note row should be removable in draft.");

    if (noteDeleteResult.ok) {
      noteDeleteResult.draft.layoutPresetDisplayName = "Applied Layout Name";

      const expectedDeletedCount = score.tracks.reduce(
        (sum, track) =>
          sum + track.cells.filter((cell) => cell.rowId === "s1-note-52").length,
        0,
      );
      const deletionSummary = calculateLayoutCellDeletionSummary(score, noteDeleteResult.draft);

      assert(
        deletionSummary.totalCount === expectedDeletedCount,
        "Deletion summary should count track cells attached to removed note rows.",
      );
      assert(
        deletionSummary.countByRowId["s1-note-52"] === expectedDeletedCount,
        "Deletion summary should group removed cells by rowId.",
      );

      const blockedApplyResult = applyLayoutDraftToScore(score, noteDeleteResult.draft);

      assert(
        !blockedApplyResult.ok && blockedApplyResult.level === "warning",
        "Layout apply should warn before deleting existing track cells.",
      );

      const allowedApplyResult = applyLayoutDraftToScore(score, noteDeleteResult.draft, {
        allowCellDeletion: true,
      });

      assert(allowedApplyResult.ok, "Layout apply should succeed when cell deletion is allowed.");

      if (allowedApplyResult.ok) {
        const nextScore = allowedApplyResult.score;
        const hasRemovedRow = nextScore.layout.rowDefinitions.some(
          (row) => row.rowId === "s1-note-52",
        );
        const hasRemovedCell = nextScore.tracks.some((track) =>
          track.cells.some((cell) => cell.rowId === "s1-note-52"),
        );
        const globalRows = nextScore.layout.rowDefinitions.filter(
          (row) => row.type === "global",
        );

        assert(!hasRemovedRow, "Applied layout should remove deleted draft rowDefinitions.");
        assert(!hasRemovedCell, "Applied layout should remove cells attached to deleted note rows.");
        assert(globalRows.length === 4, "Applied layout should preserve global rowDefinitions.");
        assert(
          nextScore.instData.instName === "Applied Layout Name",
          "Applied layout should update instrument display name from draft.",
        );
        assert(
          allowedApplyResult.deletedCells.totalCount === expectedDeletedCount,
          "Apply result should include deleted cell summary.",
        );
        assert(
          score.layout.rowDefinitions.some((row) => row.rowId === "s1-note-52"),
          "Layout apply should not mutate the original ScoreFile.",
        );
        assert(
          nextScore.tracks !== score.tracks,
          "Layout apply should copy tracks when cells are deleted.",
        );
        assert(
          nextScore.tracks[0]?.cells !== score.tracks[0]?.cells,
          "Layout apply should copy changed track cells when cells are deleted.",
        );
      }

      const initialState = createInitialState(loadResult.document);
      const changedState = applyLayoutDraftEditToState(initialState, noteDeleteResult.draft, true);
      const restoredState = applyLayoutDraftEditToState(
        changedState,
        initialState.defaultLayoutDraft,
        false,
      );

      assert(
        changedState.document.score.layout.rowDefinitions.every((row) => row.rowId !== "s1-note-52"),
        "Changed state should remove the deleted note row before default restore.",
      );
      assert(
        restoredState.document.score.layout.rowDefinitions.some((row) => row.rowId === "s1-note-52"),
        "Default layout draft should restore the loaded score layout rows.",
      );
    }
  }
}

console.log("Layout apply test completed.");

// ID를 생략한 악보에서도 독립 프리셋은 custom 계열로 저장·재로드되어야 한다.
if (loadResult.ok) {
  const score = structuredClone(loadResult.document.score);
  delete score.instData.presetId;
  const draft = createLayoutDraftBundle(score);
  draft.layoutPresetDisplayName = "Optional preset ID";
  const preset = createUserLayoutPresetData(draft);
  assert(preset.ok, "Missing score preset ID should allow custom preset creation.");
  if (preset.ok) {
    assert(preset.value.instData.presetId === "custom", "Saved preset must carry custom ID.");
    assert(preset.value.instrumentPresetId === "custom", "Saved preset must use custom slot family.");
    assert(parseUserLayoutPresetJson(JSON.stringify(preset.value)).ok, "Custom preset must round trip.");
  }
}

/**
 * 악기 ID가 다른 악보의 로드·적용과 저장 오류가 공통 슬롯에 미치는 영향을 검증한다.
 * - 인수 : score : 유효한 악보 fixture
 * - 반환값 : 없음
 */
function runSharedLayoutSlotTests(score: import("../src/core/score/types").ScoreFile): void {
  const storage = globalThis.localStorage;
  storage.clear();
  const legacyKey = "layout-slot:otamatone-basic:2";
  storage.setItem(legacyKey, "legacy bytes");
  assert(loadLayoutPresetSlotsFromLocalStorage()[1]?.preset === null,
    "Legacy keys must not be migrated or read.");
  for (const slot of [1, 2, 3] as const) {
    const preset = structuredClone(NORMAL_SCORE_LAYOUT_PRESET);
    preset.layoutPresetDisplayName = `Saved ${slot}`;
    saveLayoutPresetSlotToLocalStorage(preset, slot);
  }
  const storedBytes = [1, 2, 3].map(n => storage.getItem(`layout-slot:shared:v1:${n}`));
  for (const presetId of [undefined, "custom", "another-instrument"]) {
    const source = structuredClone(score);
    if (presetId === undefined) delete source.instData.presetId;
    else source.instData.presetId = presetId;
    const loaded = loadRuntimeDocument(JSON.stringify(source));
    assert(loaded.ok, "Scores with absent/custom/other preset IDs should load.");
    if (!loaded.ok) continue;
    const slots = loadLayoutPresetSlotsFromLocalStorage();
    assert(slots.map(s => s.layoutPresetDisplayName).join() === "Saved 1,Saved 2,Saved 3",
      "Loading another instrument must preserve all three saved slot labels.");
    const preset = slots[0]!.preset!;
    const draft = createLayoutDraftFromPreset(preset, createLayoutDraftBundle(loaded.document.score));
    const applied = applyLayoutDraftToScore(loaded.document.score, draft, { allowCellDeletion: true });
    assert(applied.ok && applied.score.instData.presetId === preset.instData.presetId,
      "A shared preset should be applicable across instrument IDs.");
    const resaved = createUserLayoutPresetData(draft);
    assert(resaved.ok && resaved.value.instrumentPresetId === preset.instData.presetId,
      "Saving a loaded draft should retain its instrument metadata, not the current score ID.");
    assert(JSON.stringify(storedBytes) === JSON.stringify(
      [1, 2, 3].map(n => storage.getItem(`layout-slot:shared:v1:${n}`))),
      "Loading/applying must preserve the stored preset bytes.");
  }
  const replacement = { ...structuredClone(NORMAL_SCORE_LAYOUT_PRESET), layoutPresetDisplayName: "Replacement" };
  saveLayoutPresetSlotToLocalStorage(replacement, 2);
  assert(storage.getItem("layout-slot:shared:v1:1") === storedBytes[0] &&
    storage.getItem("layout-slot:shared:v1:3") === storedBytes[2] &&
    loadLayoutPresetSlotFromLocalStorage(2)?.layoutPresetDisplayName === "Replacement",
    "Explicit save should overwrite only the selected shared slot.");
  const beforeFailure = storage.getItem("layout-slot:shared:v1:2");
  const originalSetItem = storage.setItem;
  storage.setItem = () => { throw new Error("Quota exceeded"); };
  let rejected = false;
  try { saveLayoutPresetSlotToLocalStorage(replacement, 2); } catch { rejected = true; }
  storage.setItem = originalSetItem;
  assert(rejected && storage.getItem("layout-slot:shared:v1:2") === beforeFailure,
    "Failed save must preserve the previous bytes.");
  const originalGetItem = storage.getItem;
  storage.getItem = () => { throw new Error("Storage denied"); };
  assert(loadLayoutPresetSlotsFromLocalStorage().every(s => s.readError !== undefined),
    "Access errors must be distinct from empty slots.");
  storage.getItem = originalGetItem;
  assert(storage.getItem(legacyKey) === "legacy bytes", "Legacy bytes must remain untouched.");
  storage.clear();
}
