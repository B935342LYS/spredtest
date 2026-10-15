import { readFileSync } from "node:fs";

import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";
import { loadScoreFile } from "../src/core/score/json_load";
import {
  MAX_YOUTUBE_OFFSET_MS,
  MAX_CELL_RAW_TEXT_LENGTH,
  MAX_SCORE_COMMENT_LENGTH,
  MAX_ROW_DEFINITIONS,
  MAX_ROW_HEIGHT,
  MAX_SCORE_JSON_BYTES,
  MAX_SCORE_COLUMN_COUNT,
  MIN_YOUTUBE_OFFSET_MS,
} from "../src/core/score/score_limits";
import { validateScoreFile } from "../src/core/score/score_validate";

const fixtureUrl = new URL("./test_cases/minimal-valid-score.json", import.meta.url);
const jsonText = readFileSync(fixtureUrl, "utf8");
const fixtureValue = JSON.parse(jsonText);

/**
 * JSON fixture 값을 테스트별로 안전하게 변형하기 위한 복제 함수.
 * - 인수 : value : JSON 직렬화 가능한 fixture 값
 * - 반환값 : T : 원본과 참조를 공유하지 않는 복제 값
 */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * ScoreFile 검증 실패가 기대한 오류 코드와 경로로 발생하는지 확인한다.
 * - 인수 : value : validateScoreFile()에 전달할 fixture 변형 값
 * - 인수 : expectedCode : 기대하는 ScoreValidationError code
 * - 인수 : label : 실패 메시지에 표시할 테스트 설명
 * - 인수 : expectedPath : 기대하는 오류 path. 생략하면 path는 검사하지 않는다.
 * - 반환값 : 없음
 */
function expectValidationError(
  value: unknown,
  expectedCode: string,
  label: string,
  expectedPath?: string,
): void {
  const result = validateScoreFile(value);

  if (result.ok) {
    console.error(`Score validation failed to reject ${label}.`);
    process.exitCode = 1;
    return;
  }

  if (
    result.error.code !== expectedCode ||
    (expectedPath !== undefined && result.error.path !== expectedPath)
  ) {
    console.error(`Unexpected error for ${label}.`);
    console.error(result.error);
    process.exitCode = 1;
  }
}

// UI와 edit/save 계약을 위해 고정 트랙 레이어 누락은 validator에서 차단해야 한다.
const missingBasicTrack = cloneJson(fixtureValue);
missingBasicTrack.tracks = missingBasicTrack.tracks.filter(
  (track: { trackId: string }) => track.trackId !== "basic",
);

const missingBasicResult = validateScoreFile(missingBasicTrack);
if (missingBasicResult.ok) {
  console.error("Score validation failed to reject missing basic track.");
  process.exitCode = 1;
} else if (missingBasicResult.error.code !== "missing_required_track") {
  console.error("Unexpected error for missing basic track.");
  console.error(missingBasicResult.error);
  process.exitCode = 1;
}

const missingOptionalTrack = cloneJson(fixtureValue);
missingOptionalTrack.tracks = missingOptionalTrack.tracks.filter(
  (track: { trackId: string }) => track.trackId !== "optional",
);

const missingOptionalResult = validateScoreFile(missingOptionalTrack);
if (missingOptionalResult.ok) {
  console.error("Score validation failed to reject missing optional track.");
  process.exitCode = 1;
} else if (missingOptionalResult.error.code !== "missing_required_track") {
  console.error("Unexpected error for missing optional track.");
  console.error(missingOptionalResult.error);
  process.exitCode = 1;
}

const missingExtraTrack = cloneJson(fixtureValue);
missingExtraTrack.tracks = missingExtraTrack.tracks.filter(
  (track: { trackId: string }) => track.trackId !== "extra",
);

const missingExtraResult = validateScoreFile(missingExtraTrack);
if (missingExtraResult.ok) {
  console.error("Score validation failed to reject missing extra track.");
  process.exitCode = 1;
} else if (missingExtraResult.error.code !== "missing_required_track") {
  console.error("Unexpected error for missing extra track.");
  console.error(missingExtraResult.error);
  process.exitCode = 1;
}

const longTrackRawText = cloneJson(fixtureValue);
longTrackRawText.tracks[0].cells[0].rawText = "x".repeat(MAX_CELL_RAW_TEXT_LENGTH + 1);

const longTrackRawTextResult = validateScoreFile(longTrackRawText);
if (longTrackRawTextResult.ok) {
  console.error("Score validation failed to reject long track rawText.");
  process.exitCode = 1;
} else if (longTrackRawTextResult.error.code !== "raw_text_out_of_range") {
  console.error("Unexpected error for long track rawText.");
  console.error(longTrackRawTextResult.error);
  process.exitCode = 1;
}

const licenseCreditComment = [
  "Credits (please copy paste)",
  "Music: TheFatRat - Fly Away feat. Anjulie",
  "Watch the official music video: https://tinyurl.com/tfrflyaway",
  "Listen to Fly Away: https://thefatrat.ffm.to/flyaway",
  "Follow TheFatRat: https://ffm.bio/thefatrat",
].join("\n");

const licenseCreditCommentScore = cloneJson(fixtureValue);
licenseCreditCommentScore.musicData.comment = licenseCreditComment;

const licenseCreditCommentResult = validateScoreFile(licenseCreditCommentScore);
if (!licenseCreditCommentResult.ok) {
  console.error("Score validation failed to accept license credit comment.");
  console.error(licenseCreditCommentResult.error);
  process.exitCode = 1;
}

const tooLongComment = cloneJson(fixtureValue);
tooLongComment.musicData.comment = "x".repeat(MAX_SCORE_COMMENT_LENGTH + 1);
expectValidationError(
  tooLongComment,
  "invalid_shape",
  "too long musicData.comment",
  "musicData.comment",
);

const oversizedJsonResult = loadScoreFile(" ".repeat(MAX_SCORE_JSON_BYTES + 1));
if (oversizedJsonResult.ok) {
  console.error("Score JSON loader failed to reject oversized JSON text.");
  process.exitCode = 1;
} else if (oversizedJsonResult.error.code !== "json_too_large") {
  console.error("Unexpected error for oversized JSON text.");
  console.error(oversizedJsonResult.error);
  process.exitCode = 1;
}

const zeroColumnCount = cloneJson(fixtureValue);
zeroColumnCount.globalLines.columnCount = 0;
expectValidationError(
  zeroColumnCount,
  "invalid_shape",
  "zero globalLines.columnCount",
  "globalLines.columnCount",
);

const tooLargeColumnCount = cloneJson(fixtureValue);
tooLargeColumnCount.globalLines.columnCount = MAX_SCORE_COLUMN_COUNT + 1;
expectValidationError(
  tooLargeColumnCount,
  "invalid_shape",
  "too large globalLines.columnCount",
  "globalLines.columnCount",
);

const tooManyRows = cloneJson(fixtureValue);
tooManyRows.layout.rowDefinitions = Array.from(
  { length: MAX_ROW_DEFINITIONS + 1 },
  (_, index) => ({
    ...fixtureValue.layout.rowDefinitions[0],
    rowId: `overflow-global-${index}`,
  }),
);
expectValidationError(
  tooManyRows,
  "invalid_shape",
  "too many layout rows",
  "layout.rowDefinitions",
);

const tooTallRow = cloneJson(fixtureValue);
tooTallRow.layout.rowDefinitions[0].height = MAX_ROW_HEIGHT + 1;
expectValidationError(
  tooTallRow,
  "invalid_shape",
  "too tall row",
  "layout.rowDefinitions",
);

const unknownStringRow = cloneJson(fixtureValue);
unknownStringRow.layout.rowDefinitions.find(
  (row: { rowId: string }) => row.rowId === "s1-note-85",
).stringId = "missing-string";
expectValidationError(
  unknownStringRow,
  "invalid_shape",
  "note row with unknown stringId",
  "layout.rowDefinitions",
);

const duplicateStringMidiRow = cloneJson(fixtureValue);
duplicateStringMidiRow.layout.rowDefinitions.push({
  ...fixtureValue.layout.rowDefinitions.find(
    (row: { rowId: string }) => row.rowId === "s1-note-85",
  ),
  rowId: "s1-note-85-duplicate",
});
expectValidationError(
  duplicateStringMidiRow,
  "invalid_shape",
  "duplicate note MIDI in one string",
  "layout.rowDefinitions",
);

const tooSmallYoutubeOffset = cloneJson(fixtureValue);
tooSmallYoutubeOffset.musicData.youtube.offsetMs = MIN_YOUTUBE_OFFSET_MS - 1;

const tooSmallYoutubeOffsetResult = validateScoreFile(tooSmallYoutubeOffset);
if (tooSmallYoutubeOffsetResult.ok) {
  console.error("Score validation failed to reject too small YouTube offset.");
  process.exitCode = 1;
} else if (tooSmallYoutubeOffsetResult.error.path !== "musicData.youtube.offsetMs") {
  console.error("Unexpected error for too small YouTube offset.");
  console.error(tooSmallYoutubeOffsetResult.error);
  process.exitCode = 1;
}

const tooLargeYoutubeOffset = cloneJson(fixtureValue);
tooLargeYoutubeOffset.musicData.youtube.offsetMs = MAX_YOUTUBE_OFFSET_MS + 1;

const tooLargeYoutubeOffsetResult = validateScoreFile(tooLargeYoutubeOffset);
if (tooLargeYoutubeOffsetResult.ok) {
  console.error("Score validation failed to reject too large YouTube offset.");
  process.exitCode = 1;
} else if (tooLargeYoutubeOffsetResult.error.path !== "musicData.youtube.offsetMs") {
  console.error("Unexpected error for too large YouTube offset.");
  console.error(tooLargeYoutubeOffsetResult.error);
  process.exitCode = 1;
}

// score 모듈 전체 로드 경로를 확인하기 위해 JSON -> RuntimeDocument까지 한 번에 실행한다.
const result = loadRuntimeDocument(jsonText);

// 로드 실패는 JSON 파싱, ScoreFile 검증, RuntimeDocument 생성 전 단계의 오류를 그대로 출력한다.
if (!result.ok) {
  console.error("Runtime document load failed.");
  console.error(result.error);
  process.exitCode = 1;
} else {
  // 성공 결과에서 원본 score와 파생 indexes가 같은 문서 기준으로 묶였는지 확인한다.
  const { score, indexes } = result.document;
  const rowCount = score.layout.rowDefinitions.length;
  const trackCount = score.tracks.length;
  const globalCellCount = score.globalLines.cells.length;

  console.log("Runtime document load succeeded.");
  console.log(`title: ${score.musicData.musicTitle}`);
  console.log(`rows: ${rowCount}`);
  console.log(`tracks: ${trackCount}`);
  console.log(`global cells: ${globalCellCount}`);
  console.log(`indexed rows: ${indexes.rowById.size}`);
  console.log(`indexed tracks: ${indexes.trackById.size}`);
  console.log(
    `indexed note rows for s1: ${indexes.noteRowIdsByStringId.get("s1")?.length ?? 0}`,
  );

  // 핵심 인덱스 크기가 원본 배열 크기와 다르면 index builder 단계의 실패로 본다.
  if (
    indexes.rowById.size !== rowCount ||
    indexes.trackById.size !== trackCount ||
    indexes.globalCellMapByCoord.size !== globalCellCount
  ) {
    console.error("Score index build failed.");
    process.exitCode = 1;
  }
}
