import { buildScoreIndexes } from "../src/core/score/build_score_indexes";
import { strict as nodeAssert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolveTupletHeadPlacementHit } from "../src/app/edit/edit_controller";
import { applyReverseRowsOption, buildRuntimeArtifacts, createInitialState } from "../src/app/app_runtime";
import { applyRawTextBatchToScore } from "../src/app/app_runtime";
import { buildCanvasScoreLayout } from "../src/renderer/canvas_coordinate";
import { applyScoreCellRawTextBatch } from "../src/app/edit/edit_apply";
import { getScoreTextEditInvalidationKind, type ScoreTextEdit } from "../src/core/score/score_text_edit";
import {
  buildCellHistoryPatches,
  createScoreTextEditsFromHistoryPatches,
  createUndoHistoryState,
  popRedoHistoryEntry,
  popUndoHistoryEntry,
  pushUndoHistoryEntry,
} from "../src/app/edit/edit_history";
import { composeEditRawText } from "../src/app/edit/edit_core";
import {
  copyRangeSelectionToClipboard,
  createDeleteEditsForRangeSelection,
  createPasteEditsFromClipboard,
  createScoreRangeSelection,
} from "../src/app/edit/edit_range_selection";
import type { DefaultNoteEditInput } from "../src/app/edit/edit_default";
import { normalizeNumberRawInput } from "../src/app/edit/edit_number";
import { composeTupletRawText } from "../src/app/edit/edit_tuplet";
import {
  touchScoreTimestampsForSave,
  touchScoreUpdatedAt,
} from "../src/app/score_timestamp";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";
import {
  MAX_CELL_RAW_TEXT_LENGTH,
  MAX_LOCAL_SCORE_JSON_BYTES,
} from "../src/core/score/score_limits";
import { saveScoreToLocalStorage } from "../src/infra/score_local_storage";
import {
  AUTO_HARMONIC_2OCTAVE_ABSOLUTE_PITCH,
  resolveAutoDefaultText,
  resolveAutoHarmonicAbsolutePitch,
  resolveAutoPitchInputs,
} from "../src/app/pitch_label";

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
 * 기본 edit 입력 상태를 만든다.
 * - 인수 : overrides : 테스트별로 바꿀 입력 필드
 * - 반환값 : Default 영역과 modifier 영역 입력 상태
 */
function createDefaultInput(
  overrides: Partial<DefaultNoteEditInput> = {},
): DefaultNoteEditInput {
  return {
    mode: "custom",
    customText: "",
    autoText: "",
    hold: "",
    gliss: {
      kind: "",
      id: "a",
    },
    tremDivision: "",
    absolutePitch: "",
    microPitch: "",
    ...overrides,
  };
}

/**
 * Node 테스트 환경에서 score localStorage가 사용할 mock을 설치한다.
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

const allTokenResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    customText: "C#4",
    hold: "-",
    gliss: {
      kind: "S",
      id: "b",
    },
    tremDivision: "3",
    absolutePitch: "61",
    microPitch: "-12.5",
  }),
});

const escapedResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    customText: "A/B-~",
  }),
});

const commentResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    mode: "comment",
    customText: "memo/@",
  }),
});

const modifierOnlyResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    absolutePitch: "60",
  }),
});

const zeroPitchResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    customText: "C4",
    absolutePitch: "0",
    microPitch: "0.0",
  }),
});

const autoFlatPitchResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    mode: "autoFlat",
    autoText: "Db4+",
    absolutePitch: "61",
    microPitch: "12.5",
  }),
});

const glissHoldStartPresetResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    mode: "autoSharp",
    autoText: "C4",
    customText: "ignored",
    hold: "~",
    gliss: {
      kind: "holdStart",
      id: "c",
    },
    tremDivision: "3",
    absolutePitch: "60",
    microPitch: "12.5",
  }),
});

const glissHoldStartUnresolvedAutoPitchResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    gliss: {
      kind: "holdStart",
      id: "d",
    },
    absolutePitch: AUTO_HARMONIC_2OCTAVE_ABSOLUTE_PITCH,
  }),
});

const deleteResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput(),
});

const blockedResult = composeEditRawText({
  kind: "default",
  input: createDefaultInput({
    hold: "~",
    tremDivision: "2",
  }),
});

const tupletResult = composeEditRawText({
  kind: "tuplet",
  draft: {
    divNum: 3,
    slots: [
      {
        slotIndex: 0,
        text: "C4@n(60)",
      },
      {
        slotIndex: 1,
        text: "",
      },
      {
        slotIndex: 2,
        text: "-@n(60)",
      },
    ],
    activeSlotIndex: null,
  },
});
const longTupletResult = composeTupletRawText({
  divNum: 7,
  slots: Array.from({ length: 7 }, (_, slotIndex) => ({
    slotIndex,
    text: "x".repeat(30),
  })),
  activeSlotIndex: null,
});

const fixtureUrl = new URL("./test_cases/minimal-valid-score.json", import.meta.url);
const jsonText = readFileSync(fixtureUrl, "utf8");
const loadResult = loadRuntimeDocument(jsonText);

installLocalStorageMock();

assert(
  allTokenResult.kind === "apply" &&
    allTokenResult.rawText === "-C#4@g(b,S)@t(3)@p(61)@m(-12.5)",
  "All note edit tokens should compose in parser canonical order.",
);
assert(
  escapedResult.kind === "apply" &&
    escapedResult.rawText === "A\\/B\\-\\~",
  "Default text reserved characters should be escaped.",
);
assert(
  commentResult.kind === "apply" &&
    commentResult.rawText === "//memo\\/\\@",
  "Comment mode should compose mute cell rawText.",
);
assert(
  modifierOnlyResult.kind === "apply" &&
    modifierOnlyResult.rawText === "@p(60)",
  "Modifier-only note input should be applicable.",
);
assert(
  zeroPitchResult.kind === "apply" &&
    zeroPitchResult.rawText === "C4",
  "Zero absolutePitch and microPitch should not create modifier tokens.",
);
assert(
  autoFlatPitchResult.kind === "apply" &&
    autoFlatPitchResult.rawText === "Db4+@p(61)@m(12.5)",
  "AUTO flat should use generated display text and keep effective pitch modifiers.",
);
assert(
  glissHoldStartPresetResult.kind === "apply" &&
    glissHoldStartPresetResult.rawText === "-@g(c,S)@p(60)@m(12.5)",
  "Gliss hold-start preset should ignore Default/Long/Trem values and keep pitch modifiers.",
);
assert(
  glissHoldStartUnresolvedAutoPitchResult.kind === "blocked",
  "Gliss hold-start preset should still block unresolved automatic pitch modifiers.",
);
assert(deleteResult.kind === "delete", "Empty CUSTOM input without modifiers should delete.");
assert(blockedResult.kind === "blocked", "Vibrato hold and tremolo should be blocked.");
assert(
  tupletResult.kind === "apply" &&
    tupletResult.rawText === "/3(C4@n(60)||-@n(60))",
  "Tuplet draft should compose pletHead rawText.",
);
assert(
  longTupletResult.kind === "notReady",
  "Tuplet draft should reject rawText longer than the cell limit.",
);
assert(
  normalizeNumberRawInput("999") === "999" &&
    normalizeNumberRawInput("1000") === "1000" &&
    normalizeNumberRawInput("87.5") === "87.5" &&
    normalizeNumberRawInput("12a3") === "123" &&
    normalizeNumberRawInput("12.3.4") === "12.34",
  "Number raw input should allow decimal text while removing invalid characters.",
);

assert(loadResult.ok, "Runtime document should load for tuplet placement test.");

if (loadResult.ok && tupletResult.kind === "apply") {
  const placementState = createInitialState(loadResult.document);
  const testLayout = buildCanvasScoreLayout(placementState.renderInput, {
    zoom: 1,
    devicePixelRatio: 1,
  });
  const noteRangeSelection = createScoreRangeSelection(
    testLayout,
    ["basic"],
    {
      rowId: "s1-note-52",
      rowKind: "note",
      col: 0,
    },
    {
      rowId: "s1-note-54",
      rowKind: "note",
      col: 10,
    },
  );
  const globalRangeSelection = createScoreRangeSelection(
    testLayout,
    ["basic"],
    {
      rowId: "global-bpm",
      rowKind: "global",
      col: 0,
    },
    {
      rowId: "global-dyn",
      rowKind: "global",
      col: 0,
    },
  );
  const autoHarmonicInput = resolveAutoPitchInputs(
    placementState,
    createDefaultInput({
      mode: "autoSharp",
      absolutePitch: AUTO_HARMONIC_2OCTAVE_ABSOLUTE_PITCH,
    }),
    "s1-note-60",
  );
  const preservedAutoHarmonicInput = resolveAutoDefaultText(
    placementState,
    createDefaultInput({
      mode: "autoSharp",
      absolutePitch: AUTO_HARMONIC_2OCTAVE_ABSOLUTE_PITCH,
    }),
    "s1-note-60",
  );
  const nextRowAutoHarmonicInput = resolveAutoPitchInputs(
    placementState,
    preservedAutoHarmonicInput,
    "s1-note-62",
  );
  const autoHarmonicResult = composeEditRawText({
    kind: "default",
    input: autoHarmonicInput,
  });
  const nextRowAutoHarmonicResult = composeEditRawText({
    kind: "default",
    input: nextRowAutoHarmonicInput,
  });
  const longRawTextApplyResult = applyScoreCellRawTextBatch(loadResult.document.score, [
    {
      selection: {
        trackId: "basic",
        rowId: "s1-note-60",
        rowKind: "note",
        col: 2,
      },
      rawText: "x".repeat(MAX_CELL_RAW_TEXT_LENGTH + 1),
    },
  ]);
  const protectedGlobalDeleteResult = applyScoreCellRawTextBatch(loadResult.document.score, [
    {
      selection: {
        trackId: "basic",
        rowId: "global-bpm",
        rowKind: "global",
        col: 0,
      },
      rawText: "",
    },
  ]);
  const protectedGlobalUpdateResult = applyScoreCellRawTextBatch(loadResult.document.score, [
    {
      selection: {
        trackId: "basic",
        rowId: "global-bpm",
        rowKind: "global",
        col: 0,
      },
      rawText: "140",
    },
  ]);

  assert(
    autoHarmonicResult.kind === "apply" &&
      autoHarmonicResult.rawText === "C6@p(84)",
    "AUTO◇ should resolve selected row MIDI to display and absolutePitch two octaves higher.",
  );
  assert(
    preservedAutoHarmonicInput.absolutePitch === AUTO_HARMONIC_2OCTAVE_ABSOLUTE_PITCH &&
      nextRowAutoHarmonicResult.kind === "apply" &&
      nextRowAutoHarmonicResult.rawText === "D6@p(86)",
    "AUTO◇ state should stay automatic and recalculate when the target note row changes.",
  );
  assert(
    resolveAutoHarmonicAbsolutePitch(103) === "127" &&
      resolveAutoHarmonicAbsolutePitch(104) === null,
    "AUTO◇ should block note rows whose two-octave target exceeds MIDI range.",
  );
  assert(
    !longRawTextApplyResult.ok,
    "Edit apply should reject rawText longer than the cell limit.",
  );
  assert(
    !protectedGlobalDeleteResult.ok,
    "Edit apply should reject deleting global row values at column 0.",
  );
  assert(
    protectedGlobalUpdateResult.ok &&
      protectedGlobalUpdateResult.score.globalLines.cells.some((cell) =>
        cell.rowId === "global-bpm" && cell.col === 0 && cell.rawText === "140"
      ),
    "Edit apply should allow changing global row values at column 0.",
  );

  const createdCellEdit = {
    selection: {
      trackId: "basic" as const,
      rowId: "s1-note-60",
      rowKind: "note" as const,
      col: 99,
    },
    rawText: "C4",
  };
  const createdCellApplyResult = applyScoreCellRawTextBatch(loadResult.document.score, [
    createdCellEdit,
  ]);

  assert(createdCellApplyResult.ok, "History setup should create a new note cell.");

  if (createdCellApplyResult.ok) {
    const createPatches = buildCellHistoryPatches(loadResult.document.indexes, buildScoreIndexes(createdCellApplyResult.score),
      [createdCellEdit],
    );
    const undoCreateEdits = createScoreTextEditsFromHistoryPatches(createPatches, "before");
    const redoCreateEdits = createScoreTextEditsFromHistoryPatches(createPatches, "after");

    assert(
      createPatches.length === 1 &&
        createPatches[0]?.beforeRawText === null &&
        createPatches[0]?.afterRawText === "C4",
      "History patch should record newly created cells as null -> rawText.",
    );
    assert(
      undoCreateEdits.length === 1 &&
        undoCreateEdits[0]?.rawText === "" &&
        redoCreateEdits[0]?.rawText === "C4",
      "History patch should convert new-cell undo to delete and redo to upsert.",
    );
  }

  const deletedCellEdit = {
    selection: {
      trackId: "basic" as const,
      rowId: "s1-note-52",
      rowKind: "note" as const,
      col: 0,
    },
    rawText: "",
  };
  const deletedCellApplyResult = applyScoreCellRawTextBatch(loadResult.document.score, [
    deletedCellEdit,
  ]);

  assert(deletedCellApplyResult.ok, "History setup should delete an existing note cell.");

  if (deletedCellApplyResult.ok) {
    const deletePatches = buildCellHistoryPatches(loadResult.document.indexes, buildScoreIndexes(deletedCellApplyResult.score),
      [deletedCellEdit],
    );
    const undoDeleteEdits = createScoreTextEditsFromHistoryPatches(deletePatches, "before");
    const redoDeleteEdits = createScoreTextEditsFromHistoryPatches(deletePatches, "after");

    assert(
      deletePatches.length === 1 &&
        deletePatches[0]?.beforeRawText !== null &&
        deletePatches[0]?.afterRawText === null,
      "History patch should record deleted cells as rawText -> null.",
    );
    assert(
      undoDeleteEdits[0]?.rawText === deletePatches[0]?.beforeRawText &&
        redoDeleteEdits[0]?.rawText === "",
      "History patch should convert delete undo to restore and redo to delete.",
    );
  }

  const overwriteEdits = [
    {
      selection: {
        trackId: "basic" as const,
        rowId: "s1-note-52",
        rowKind: "note" as const,
        col: 0,
      },
      rawText: "Z",
    },
    {
      selection: {
        trackId: "basic" as const,
        rowId: "s1-note-52",
        rowKind: "note" as const,
        col: 0,
      },
      rawText: "Y",
    },
  ];
  const overwriteApplyResult = applyScoreCellRawTextBatch(loadResult.document.score, overwriteEdits);

  assert(overwriteApplyResult.ok, "History setup should overwrite an existing cell.");

  if (overwriteApplyResult.ok) {
    const overwritePatches = buildCellHistoryPatches(loadResult.document.indexes, buildScoreIndexes(overwriteApplyResult.score),
      overwriteEdits,
    );

    assert(
      overwritePatches.length === 1 &&
        overwritePatches[0]?.beforeRawText !== null &&
        overwritePatches[0]?.afterRawText === "Y",
      "History patch should merge duplicate edit targets and keep the final after rawText.",
    );
  }

  const firstEntry = {
    id: "history-a",
    label: "History A",
    patches: createdCellApplyResult.ok
      ? buildCellHistoryPatches(loadResult.document.indexes, buildScoreIndexes(createdCellApplyResult.score), [createdCellEdit])
      : [],
  };
  const secondEntry = {
    id: "history-b",
    label: "History B",
    patches: deletedCellApplyResult.ok
      ? buildCellHistoryPatches(loadResult.document.indexes, buildScoreIndexes(deletedCellApplyResult.score), [deletedCellEdit])
      : [],
  };
  const oneEntryHistory = pushUndoHistoryEntry(createUndoHistoryState(1), firstEntry);
  const cappedHistory = pushUndoHistoryEntry(oneEntryHistory, secondEntry);
  const undoPop = popUndoHistoryEntry(cappedHistory);
  const redoPop = popRedoHistoryEntry(undoPop.history);

  assert(
    cappedHistory.undoStack.length === 1 &&
      cappedHistory.undoStack[0]?.id === "history-b",
    "Undo history should drop the oldest entry when maxEntries is exceeded.",
  );
  assert(
    undoPop.entry?.id === "history-b" &&
      undoPop.history.undoStack.length === 0 &&
      undoPop.history.redoStack.length === 1,
    "Undo pop should move the latest undo entry to redo stack.",
  );
  assert(
    redoPop.entry?.id === "history-b" &&
      redoPop.history.undoStack.length === 1 &&
      redoPop.history.redoStack.length === 0,
    "Redo pop should move the latest redo entry back to undo stack.",
  );
  assert(
    noteRangeSelection !== null &&
      noteRangeSelection.rowIds.includes("s1-note-52") &&
      noteRangeSelection.rowIds.includes("s1-note-53") &&
      noteRangeSelection.rowIds.includes("s1-note-54") &&
      !noteRangeSelection.rowIds.includes("s1-gap-52-53") &&
      noteRangeSelection.startCol === 0 &&
      noteRangeSelection.endColExclusive === 11,
    "Ctrl drag note range should collect note rows only and normalize columns.",
  );
  assert(
    globalRangeSelection !== null &&
      globalRangeSelection.rowIds.length === 4 &&
      globalRangeSelection.trackIds.length === 0,
    "Ctrl drag global range should collect global rows without track ids.",
  );

  if (noteRangeSelection !== null && globalRangeSelection !== null) {
    const noteDelete = createDeleteEditsForRangeSelection(
      loadResult.document.score,
      noteRangeSelection,
    );
    const globalDelete = createDeleteEditsForRangeSelection(
      loadResult.document.score,
      globalRangeSelection,
    );
    const copiedRange = copyRangeSelectionToClipboard(
      loadResult.document.score,
      noteRangeSelection,
    );
    const pasteResult = createPasteEditsFromClipboard(
      loadResult.document.score,
      testLayout,
      copiedRange,
      20,
    );

    assert(
      noteDelete.edits.length === 11 &&
        noteDelete.edits.every((edit) => edit.selection.trackId === "basic"),
      "Note range delete should create delete edits for existing selected cells only.",
    );
    assert(
      globalDelete.edits.length === 0 &&
        globalDelete.protectedGlobalStartCellCount === 4,
      "Global range delete should protect required column 0 cells.",
    );
    assert(
      copiedRange.cells.length === 11 &&
        copiedRange.width === 11 &&
        copiedRange.trackIds.includes("basic"),
      "Range copy should keep existing note cells and source width.",
    );
    assert(
      pasteResult.edits.length === 11 &&
        pasteResult.rangeSelection !== null &&
        pasteResult.rangeSelection.startCol === 20 &&
        pasteResult.rangeSelection.endColExclusive === 31 &&
        pasteResult.edits.some((edit) =>
          edit.selection.rowId === "s1-note-52" && edit.selection.col === 20
        ) &&
        !pasteResult.edits.some((edit) => edit.selection.rowId === "s1-note-60"),
      "Range paste should preserve copied rowIds and move only by target column.",
    );
  }

  const placementResult = resolveTupletHeadPlacementHit(
    placementState,
    {
      rowId: "s1-note-67",
      rowKind: "note",
      col: 12,
    },
    tupletResult.rawText,
  );

  assert(placementResult.kind === "hit", "Tuplet placement should resolve first slot row.");

  if (placementResult.kind === "hit") {
    assert(placementResult.hit.rowId === "s1-note-60", "Tuplet placement hit should use first slot @n row.");
    assert(placementResult.hit.col === 12, "Tuplet placement hit should keep clicked column.");
  }

  const restFirstPlacementResult = resolveTupletHeadPlacementHit(
    placementState,
    {
      rowId: "s1-note-67",
      rowKind: "note",
      col: 13,
    },
    "/3(|D@n(62)|E@n(64))",
  );

  assert(restFirstPlacementResult.kind === "hit", "Tuplet placement should use the first non-rest slot.");

  if (restFirstPlacementResult.kind === "hit") {
    assert(restFirstPlacementResult.hit.rowId === "s1-note-62", "Rest-first tuplet placement should use slot 2 row.");
    assert(restFirstPlacementResult.hit.col === 13, "Rest-first placement should keep clicked column.");
  }

  const allRestPlacementResult = resolveTupletHeadPlacementHit(
    placementState,
    {
      rowId: "s1-note-67",
      rowKind: "note",
      col: 14,
    },
    "/3(||)",
  );

  assert(allRestPlacementResult.kind === "hit", "All-rest tuplet placement should keep clicked row.");

  if (allRestPlacementResult.kind === "hit") {
    assert(allRestPlacementResult.hit.rowId === "s1-note-67", "All-rest tuplet placement should keep source row.");
    assert(allRestPlacementResult.hit.col === 14, "All-rest placement should keep clicked column.");
  }

  const batchApplyResult = applyScoreCellRawTextBatch(loadResult.document.score, [
    {
      selection: {
        trackId: "basic",
        rowId: "s1-note-60",
        rowKind: "note",
        col: 2,
      },
      rawText: "C4",
    },
    {
      selection: {
        trackId: "basic",
        rowId: "global-bpm",
        rowKind: "global",
        col: 2,
      },
      rawText: "120<",
    },
  ]);

  assert(
    getScoreTextEditInvalidationKind([
      {
        selection: {
          trackId: "basic",
          rowId: "s1-note-60",
          rowKind: "note",
          col: 2,
        },
        rawText: "C4",
      },
    ]) === "noteCell",
    "Note-only edit batch should invalidate note cells.",
  );
  assert(
    getScoreTextEditInvalidationKind([
      {
        selection: {
          trackId: "basic",
          rowId: "global-bpm",
          rowKind: "global",
          col: 2,
        },
        rawText: "120<",
      },
    ]) === "globalCell",
    "Global-only edit batch should invalidate global cells.",
  );
  assert(
    getScoreTextEditInvalidationKind([
      {
        selection: {
          trackId: "basic",
          rowId: "s1-note-60",
          rowKind: "note",
          col: 2,
        },
        rawText: "C4",
      },
      {
        selection: {
          trackId: "basic",
          rowId: "global-bpm",
          rowKind: "global",
          col: 2,
        },
        rawText: "120<",
      },
    ]) === "mixedCell",
    "Mixed edit batch should be classified as the mixed fallback.",
  );

  assert(batchApplyResult.ok, "Batch edit should apply note and global cells together.");

  if (batchApplyResult.ok) {
    const noteCell = batchApplyResult.score.tracks
      .find((track) => track.trackId === "basic")
      ?.cells.find((cell) => cell.rowId === "s1-note-60" && cell.col === 2);
    const globalCell = batchApplyResult.score.globalLines.cells.find(
      (cell) => cell.rowId === "global-bpm" && cell.col === 2,
    );

    assert(noteCell?.rawText === "C4", "Batch edit should upsert note rawText.");
    assert(globalCell?.rawText === "120<", "Batch edit should upsert global rawText.");
    assert(
      batchApplyResult.score.musicData.updatedAt === loadResult.document.score.musicData.updatedAt,
      "Batch edit should preserve musicData.updatedAt until explicit save.",
    );

    const touchedScore = touchScoreUpdatedAt(batchApplyResult.score, "2026-06-13T12:00:00.000Z");

    assert(
      touchedScore.musicData.createdAt === batchApplyResult.score.musicData.createdAt,
      "Explicit save timestamp update should preserve createdAt.",
    );
    assert(
      touchedScore.musicData.updatedAt === "2026-06-13T12:00:00.000Z",
      "Explicit save timestamp update should set updatedAt.",
    );

    const templateSavedScore = touchScoreTimestampsForSave(
      batchApplyResult.score,
      "template",
      "2026-06-13T13:00:00.000Z",
    );
    const loadedSavedScore = touchScoreTimestampsForSave(
      batchApplyResult.score,
      "loaded",
      "2026-06-13T14:00:00.000Z",
    );

    assert(
      templateSavedScore.musicData.createdAt === "2026-06-13T13:00:00.000Z" &&
        templateSavedScore.musicData.updatedAt === "2026-06-13T13:00:00.000Z",
      "Template score save should initialize createdAt and updatedAt together.",
    );
    assert(
      loadedSavedScore.musicData.createdAt === batchApplyResult.score.musicData.createdAt &&
        loadedSavedScore.musicData.updatedAt === "2026-06-13T14:00:00.000Z",
      "Loaded score save should preserve createdAt and update updatedAt.",
    );

    const oversizedLocalScore = {
      ...batchApplyResult.score,
      musicData: {
        ...batchApplyResult.score.musicData,
        comment: "x".repeat(MAX_LOCAL_SCORE_JSON_BYTES),
      },
    };
    let localSaveRejected = false;

    try {
      saveScoreToLocalStorage(oversizedLocalScore);
    } catch {
      localSaveRejected = true;
    }

    assert(localSaveRejected, "Local score save should reject JSON larger than the local limit.");
  }

  const globalOnlyStateResult = applyRawTextBatchToScore(placementState, [
    {
      selection: {
        trackId: "basic",
        rowId: "global-bpm",
        rowKind: "global",
        col: 3,
      },
      rawText: "90",
    },
  ]);
  nodeAssert.equal(globalOnlyStateResult.kind, "applied");
  const globalOnlyState = globalOnlyStateResult.state;

  assert(
    globalOnlyState.analysis.trackResults === placementState.analysis.trackResults,
    "Global-only edit should reuse previous track analysis.",
  );
  assert(
    globalOnlyState.renderInput.noteItems === placementState.renderInput.noteItems &&
      globalOnlyState.renderInput.noteMarkerItems === placementState.renderInput.noteMarkerItems,
    "Global-only edit should reuse note-derived renderer item groups.",
  );
  assert(
    globalOnlyState.renderInput.globalTextItems !== placementState.renderInput.globalTextItems &&
      globalOnlyState.renderInput.globalMarkerItems !== placementState.renderInput.globalMarkerItems,
    "Global-only edit should rebuild global renderer item groups.",
  );

  const optionalOnlyStateResult = applyRawTextBatchToScore(placementState, [
    {
      selection: {
        trackId: "optional",
        rowId: "s1-note-60",
        rowKind: "note",
        col: 4,
      },
      rawText: "C4",
    },
  ]);
  nodeAssert.equal(optionalOnlyStateResult.kind, "applied");
  const optionalOnlyState = optionalOnlyStateResult.state;
  const previousBasicTrackResult = placementState.analysis.trackResults.find(
    (trackResult) => trackResult.trackId === "basic",
  );
  const previousOptionalTrackResult = placementState.analysis.trackResults.find(
    (trackResult) => trackResult.trackId === "optional",
  );
  const nextBasicTrackResult = optionalOnlyState.analysis.trackResults.find(
    (trackResult) => trackResult.trackId === "basic",
  );
  const nextOptionalTrackResult = optionalOnlyState.analysis.trackResults.find(
    (trackResult) => trackResult.trackId === "optional",
  );

  assert(
    optionalOnlyState.analysis.timingTimeline === placementState.analysis.timingTimeline &&
      optionalOnlyState.analysis.dynamicsTimeline === placementState.analysis.dynamicsTimeline,
    "Note-only edit should reuse global timing and dynamics analysis.",
  );
  assert(
    previousBasicTrackResult === nextBasicTrackResult,
    "Note-only edit should reuse unedited track analysis.",
  );
  assert(
    previousOptionalTrackResult !== nextOptionalTrackResult,
    "Note-only edit should rebuild edited track analysis.",
  );
  assert(
    optionalOnlyState.renderInput.globalTextItems === placementState.renderInput.globalTextItems &&
      optionalOnlyState.renderInput.globalMarkerItems === placementState.renderInput.globalMarkerItems,
    "Note-only edit should reuse global renderer item groups.",
  );
  assert(
    optionalOnlyState.renderInput.noteItems.some((item) =>
      item.trackId === "optional" && item.sourceEventId === "optional:note:s1-note-60:4"
    ),
    "Note-only edit should add renderer items for the edited track.",
  );
}

// 일반/반전 표시에서 셀 편집 결과가 전체 재빌드와 같고 기존 좌표 입력이 보존되는지 확인한다.
if (loadResult.ok) {
  const noteEdit: ScoreTextEdit = {
    selection: { trackId: "basic", rowId: "s1-note-60", rowKind: "note", col: 2 },
    rawText: "C4",
  };
  const globalEdit: ScoreTextEdit = {
    selection: { trackId: "basic", rowId: "global-bpm", rowKind: "global", col: 3 },
    rawText: "90",
  };
  for (const reverseRows of [false, true]) {
    const initialState = createInitialState(loadResult.document);
    const state = {
      ...initialState,
      reverseRows,
      renderInput: {
        ...initialState.renderInput,
        ...applyReverseRowsOption(initialState.renderInput, reverseRows),
      },
    };
    for (const edits of [[noteEdit], [globalEdit], [noteEdit, globalEdit]]) {
      const nextStateResult = applyRawTextBatchToScore(state, edits);
      nodeAssert.equal(nextStateResult.kind, "applied");
      const nextState = nextStateResult.state;
      const rebuilt = buildRuntimeArtifacts(nextState.document, state.activeTrackIds, reverseRows);
      const context = `reverseRows=${reverseRows}, kind=${getScoreTextEditInvalidationKind(edits)}`;
      assert(
        JSON.stringify(nextState.renderInput) === JSON.stringify(rebuilt.renderInput),
        `Cell edit renderer output should match full rebuild (${context}).`,
      );
      assert(
        JSON.stringify(nextState.analysis) === JSON.stringify(rebuilt.analysis),
        `Cell edit analysis should match full rebuild (${context}).`,
      );
      if (edits.length === 1) {
        assert(
          nextState.renderInput.rows === state.renderInput.rows &&
            nextState.renderInput.columnCount === state.renderInput.columnCount &&
            nextState.renderInput.baseColumnWidthPx === state.renderInput.baseColumnWidthPx,
          `Partial cell edit should reuse the existing base input (${context}).`,
        );
      }
    }
  }
}

// 최종 값 비교는 입력 검증을 생략하지 않으며 원본 악보를 변경하지 않는다.
{
  const loaded = loadRuntimeDocument(readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8"));
  nodeAssert(loaded.ok);
  const score = loaded.document.score;
  const originalJson = JSON.stringify(score);
  const note: ScoreTextEdit = { selection: { trackId: "basic", rowId: "s1-note-52", rowKind: "note", col: 0 }, rawText: "E3" };
  const absent: ScoreTextEdit = { ...note, selection: { ...note.selection, col: 12 }, rawText: "" };
  const global: ScoreTextEdit = { selection: { trackId: "basic", rowId: "global-bpm", rowKind: "global", col: 0 }, rawText: score.globalLines.cells.find(cell => cell.rowId === "global-bpm" && cell.col === 0)!.rawText };
  for (const edits of [
    [note], [absent], [global],
    [{ ...note, rawText: "F3" }, note],
    [{ ...absent, rawText: "E3" }, absent],
    [{ ...global, rawText: "140" }, global],
    [note, global, absent],
  ]) {
    const result = applyScoreCellRawTextBatch(score, edits);
    nodeAssert(result.ok);
    nodeAssert.equal(result.score, score, "Net-zero batch must preserve score identity");
  }
  for (const edits of [
    [{ ...note, rawText: "x".repeat(201) }, note],
    [{ ...global, rawText: "" }, global],
    [{ ...absent, selection: { ...absent.selection, rowKind: "gap" as const } }],
  ]) nodeAssert.equal(applyScoreCellRawTextBatch(score, edits).ok, false);
  nodeAssert.equal(applyScoreCellRawTextBatch({ ...score, tracks: [] }, [note]).ok, false);
  const mixed = applyScoreCellRawTextBatch(score, [note, { ...global, rawText: global.rawText + " " }]);
  nodeAssert(mixed.ok);
  nodeAssert.notEqual(mixed.score, score, "rawText difference is a real edit even if parsed meaning is the same");
  nodeAssert.equal(mixed.score.globalLines.cells.find(cell => cell.rowId === "global-bpm" && cell.col === 0)!.rawText, global.rawText + " ");
  nodeAssert.equal(JSON.stringify(score), originalJson);
}

// 트랙별 같은 좌표와 global 중복 좌표의 이력 순서·null 의미를 보존한다.
{
  const loaded = loadRuntimeDocument(readFileSync(new URL("./test_cases/minimal-valid-score.json", import.meta.url), "utf8"));
  nodeAssert(loaded.ok);
  const score = loaded.document.score;
  const basic: ScoreTextEdit = { selection: { trackId: "basic", rowId: "s1-note-52", col: 0, rowKind: "note" }, rawText: "F3" };
  const optional: ScoreTextEdit = { ...basic, selection: { ...basic.selection, trackId: "optional" }, rawText: "G3" };
  const global: ScoreTextEdit = { selection: { trackId: "basic", rowId: "global-bpm", col: 0, rowKind: "global" }, rawText: "145" };
  const globalLast: ScoreTextEdit = { ...global, selection: { ...global.selection, trackId: "extra" }, rawText: "150" };
  const edits = [optional, global, basic, globalLast, basic];
  const result = applyScoreCellRawTextBatch(score, edits);
  nodeAssert(result.ok);
  const before = loaded.document.indexes;
  const after = buildScoreIndexes(result.score);
  const patches = buildCellHistoryPatches(before, after, edits);
  nodeAssert.equal(patches.length, 3);
  nodeAssert.equal(patches[0].selection, optional.selection);
  nodeAssert.equal(patches[0].beforeRawText, null);
  nodeAssert.equal(patches[0].afterRawText, "G3");
  nodeAssert.equal(patches[1].selection, globalLast.selection);
  nodeAssert.equal(patches[1].afterRawText, "150");
  nodeAssert.equal(patches[2].beforeRawText, "E3");
  nodeAssert.equal(patches[2].afterRawText, "F3");
  const reverse = buildCellHistoryPatches(after, before, edits);
  nodeAssert.equal(reverse[0].afterRawText, null);
  nodeAssert.deepEqual(buildCellHistoryPatches(before, before, edits), []);
}

console.log("Edit composer test completed.");
