import { readFileSync } from "node:fs";

import { buildParsedDocument } from "../src/core/parse/build_parsed_document";
import { parseGlobalCell } from "../src/core/parse/parse_global_cell";
import { parseNoteCell } from "../src/core/parse/parse_note_cell";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";

const fixtureUrl = new URL("./test_cases/minimal-valid-score.json", import.meta.url);
const jsonText = readFileSync(fixtureUrl, "utf8");

// parser 테스트도 score load pipeline을 통과한 RuntimeDocument를 기준으로 수행한다.
const result = loadRuntimeDocument(jsonText);

// 로드가 실패하면 parser 입력 전제가 없으므로 해당 오류를 먼저 보고한다.
if (!result.ok) {
  console.error("Runtime document load failed.");
  console.error(result.error);
  process.exitCode = 1;
} else {
  // fixture의 모든 전역 셀을 단일 셀 parser에 통과시켜 global parser 기본 경로를 확인한다.
  const parsedGlobalCells = result.document.score.globalLines.cells.map((cell) =>
    parseGlobalCell(cell, {
      rowById: result.document.indexes.rowById,
    }),
  );

  // 하나라도 invalid면 fixture 또는 parser 구현이 현재 전역 셀 명세와 맞지 않는 것이다.
  const invalidGlobalCells = parsedGlobalCells.filter(
    (cell) => cell.kind === "invalid",
  );

  console.log("Global cell parse completed.");
  console.log(`global cells: ${parsedGlobalCells.length}`);
  console.log(`invalid global cells: ${invalidGlobalCells.length}`);

  // invalid 결과 전체를 출력해 어떤 전역 셀이 실패했는지 바로 확인할 수 있게 한다.
  if (invalidGlobalCells.length > 0) {
    console.error(invalidGlobalCells);
    process.exitCode = 1;
  }

  const globalLimitSamples = [
    { rowId: "global-bpm", rawText: "1", expectedKind: "linearGlobalValue" },
    { rowId: "global-bpm", rawText: "0.999", expectedCode: "invalid_bpm_range" },
    { rowId: "global-bpm", rawText: "999<", expectedKind: "linearGlobalValue" },
    { rowId: "global-bpm", rawText: "1000", expectedCode: "invalid_bpm_range" },
    { rowId: "global-bpb", rawText: "999", expectedKind: "instantGlobalValue" },
    { rowId: "global-bpb", rawText: "1000", expectedCode: "invalid_beats_per_bar_range" },
    { rowId: "global-spb", rawText: "999", expectedKind: "instantGlobalValue" },
    { rowId: "global-spb", rawText: "1000", expectedCode: "invalid_steps_per_beat_range" },
  ] as const;

  // BPM은 1..999, 나머지 global timing 정수 계열은 1..999 범위로 고정한다.
  const unexpectedGlobalLimitResults = globalLimitSamples
    .map((sample) => ({
      sample,
      parsedCell: parseGlobalCell({
        rowId: sample.rowId,
        col: 0,
        rawText: sample.rawText,
      }, {
        rowById: result.document.indexes.rowById,
      }),
    }))
    .filter(({ sample, parsedCell }) => {
      if ("expectedCode" in sample) {
        return parsedCell.kind !== "invalid" || parsedCell.error.code !== sample.expectedCode;
      }

      return parsedCell.kind !== sample.expectedKind;
    });

  console.log("Global limit sample parse completed.");
  console.log(`global limit samples: ${globalLimitSamples.length}`);
  console.log(`unexpected global limit results: ${unexpectedGlobalLimitResults.length}`);

  if (unexpectedGlobalLimitResults.length > 0) {
    console.error(unexpectedGlobalLimitResults);
    process.exitCode = 1;
  }

  // fixture의 모든 트랙 셀을 단일 note parser에 통과시켜 기본 note 경로를 확인한다.
  const parsedNoteCells = result.document.score.tracks.flatMap((track) =>
    track.cells.map((cell) =>
      parseNoteCell({
        trackId: track.trackId,
        rowId: cell.rowId,
        col: cell.col,
        rawText: cell.rawText,
      }),
    ),
  );

  // 현재 fixture는 일반 note와 hold만 포함하므로 invalid가 있으면 1단계 note parser 문제로 본다.
  const invalidNoteCells = parsedNoteCells.filter(
    (cell) => cell.kind === "invalid",
  );

  console.log("Note cell parse completed.");
  console.log(`note cells: ${parsedNoteCells.length}`);
  console.log(`invalid note cells: ${invalidNoteCells.length}`);

  // invalid 결과 전체를 출력해 어떤 note 셀이 실패했는지 바로 확인할 수 있게 한다.
  if (invalidNoteCells.length > 0) {
    console.error(invalidNoteCells);
    process.exitCode = 1;
  }

  const validModifierSampleTexts = [
    "E3@g(a,S)",
    "E3@t(2)",
    "E3@p(60)",
    "E3@m(-12.5)",
    "~E3@g(b,M)@p(62)@m(0.5)",
  ];

  // fixture에 없는 modifier 경로는 작은 직접 샘플로 canonical order와 인수 파싱을 확인한다.
  const parsedModifierSampleCells = validModifierSampleTexts.map((rawText) =>
    parseNoteCell({
      trackId: "basic",
      rowId: "string-a-note-60",
      col: 0,
      rawText,
    }),
  );

  // valid modifier 샘플이 invalid가 되면 modifier 하위 parser의 회귀로 본다.
  const invalidModifierSampleCells = parsedModifierSampleCells.filter(
    (cell) => cell.kind === "invalid",
  );

  console.log("Note modifier sample parse completed.");
  console.log(`valid modifier samples: ${parsedModifierSampleCells.length}`);
  console.log(`invalid valid-modifier samples: ${invalidModifierSampleCells.length}`);

  if (invalidModifierSampleCells.length > 0) {
    console.error(invalidModifierSampleCells);
    process.exitCode = 1;
  }

  const invalidModifierSamples = [
    { rawText: "E3@x(1)", code: "unknown_modifier" },
    { rawText: "E3@p(60)@t(2)", code: "modifier_order" },
    { rawText: "E3@t(2)@t(3)", code: "duplicate_modifier" },
    { rawText: "~E3@t(2)", code: "vib_and_trem" },
    { rawText: "E3@m(1.25)", code: "invalid_number" },
    { rawText: "E3@g(aa,S)", code: "invalid_gliss_id" },
  ] as const;

  // invalid 샘플은 오류 코드까지 확인해 분기 우선순위가 흔들리지 않도록 한다.
  const unexpectedInvalidModifierResults = invalidModifierSamples
    .map((sample) => ({
      sample,
      parsedCell: parseNoteCell({
        trackId: "basic",
        rowId: "string-a-note-60",
        col: 0,
        rawText: sample.rawText,
      }),
    }))
    .filter(
      ({ sample, parsedCell }) =>
        parsedCell.kind !== "invalid" || parsedCell.error.code !== sample.code,
    );

  console.log("Invalid note modifier sample parse completed.");
  console.log(`invalid modifier samples: ${invalidModifierSamples.length}`);
  console.log(`unexpected invalid-modifier results: ${unexpectedInvalidModifierResults.length}`);

  if (unexpectedInvalidModifierResults.length > 0) {
    console.error(unexpectedInvalidModifierResults);
    process.exitCode = 1;
  }

  const validPletHeadSampleTexts = [
    "/3(E@n(60)|F@n(62)|G@n(64))",
    "/3(E@g(c,S)@n(60)||-@p(61)@n(61))",
  ];

  // tuplet head는 fixture에 없으므로 직접 샘플로 slot 분리와 @n 위치 토큰을 확인한다.
  const parsedPletHeadSampleCells = validPletHeadSampleTexts.map((rawText) =>
    parseNoteCell({
      trackId: "basic",
      rowId: "string-a-note-60",
      col: 0,
      rawText,
    }),
  );

  // valid pletHead 샘플은 모두 pletHead kind로 파싱되어야 한다.
  const unexpectedPletHeadSampleCells = parsedPletHeadSampleCells.filter(
    (cell) => cell.kind !== "pletHead",
  );

  console.log("Tuplet head sample parse completed.");
  console.log(`valid pletHead samples: ${parsedPletHeadSampleCells.length}`);
  console.log(`unexpected valid-pletHead samples: ${unexpectedPletHeadSampleCells.length}`);

  if (unexpectedPletHeadSampleCells.length > 0) {
    console.error(unexpectedPletHeadSampleCells);
    process.exitCode = 1;
  }

  const invalidPletHeadSamples = [
    { rawText: "/1(E@n(60))", code: "invalid_tuplet_division" },
    { rawText: "/3(E@n(60)|F@n(62))", code: "tuplet_slot_count_mismatch" },
    { rawText: "/3(E|F@n(62)|G@n(64))", code: "tuplet_position_required" },
    { rawText: "/3(/2(E@n(60)|F@n(61))|F@n(62)|G@n(64))", code: "tuplet_nested_forbidden" },
    { rawText: "/3(~E@t(2)@n(60)||)", code: "vib_and_trem" },
  ] as const;

  // pletHead invalid 샘플은 slot 구조 오류와 slot 내부 note 오류의 대표 분기를 고정한다.
  const unexpectedInvalidPletHeadResults = invalidPletHeadSamples
    .map((sample) => ({
      sample,
      parsedCell: parseNoteCell({
        trackId: "basic",
        rowId: "string-a-note-60",
        col: 0,
        rawText: sample.rawText,
      }),
    }))
    .filter(
      ({ sample, parsedCell }) =>
        parsedCell.kind !== "invalid" || parsedCell.error.code !== sample.code,
    );

  console.log("Invalid tuplet head sample parse completed.");
  console.log(`invalid pletHead samples: ${invalidPletHeadSamples.length}`);
  console.log(`unexpected invalid-pletHead results: ${unexpectedInvalidPletHeadResults.length}`);

  if (unexpectedInvalidPletHeadResults.length > 0) {
    console.error(unexpectedInvalidPletHeadResults);
    process.exitCode = 1;
  }

  // 문서 단위 parser는 단일 셀 parser 결과를 analyzer 입력 축으로 묶는다.
  const parsedDocument = buildParsedDocument(result.document);
  let parsedDocumentNoteCellCount = 0;
  let parsedDocumentInvalidNoteCellCount = 0;
  let parsedDocumentGlobalCellCount = 0;
  let parsedDocumentInvalidGlobalCellCount = 0;

  // note 문서 Map은 track -> col -> entries 구조이므로 중첩 순회로 개수를 센다.
  for (const cellsByCol of parsedDocument.noteCellsByTrackAndCol.values()) {
    for (const entries of cellsByCol.values()) {
      parsedDocumentNoteCellCount += entries.length;
      parsedDocumentInvalidNoteCellCount += entries.filter(
        (entry) => entry.parsedCell.kind === "invalid",
      ).length;
    }
  }

  // global 문서 Map은 kind -> col -> entry 구조이므로 전역 행별 파싱 결과를 센다.
  for (const cellsByCol of parsedDocument.globalCellsByKindAndCol.values()) {
    for (const entry of cellsByCol.values()) {
      parsedDocumentGlobalCellCount += 1;

      if (entry.parsedCell.kind === "invalid") {
        parsedDocumentInvalidGlobalCellCount += 1;
      }
    }
  }

  console.log("Parsed document build completed.");
  console.log(`parsed document note cells: ${parsedDocumentNoteCellCount}`);
  console.log(`parsed document invalid note cells: ${parsedDocumentInvalidNoteCellCount}`);
  console.log(`parsed document global cells: ${parsedDocumentGlobalCellCount}`);
  console.log(`parsed document invalid global cells: ${parsedDocumentInvalidGlobalCellCount}`);

  if (
    parsedDocumentNoteCellCount !== parsedNoteCells.length ||
    parsedDocumentInvalidNoteCellCount !== 0 ||
    parsedDocumentGlobalCellCount !== parsedGlobalCells.length ||
    parsedDocumentInvalidGlobalCellCount !== 0
  ) {
    console.error("Parsed document counts did not match parser fixture expectations.");
    process.exitCode = 1;
  }
}
