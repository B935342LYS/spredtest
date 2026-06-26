/**
 * src\core\score\score_validate.ts
 * JSON 파싱이 끝난 값을 ScoreFile로 사용할 수 있는지 최소 검증한다.
 * 이 파일은 1단계 구현 안정화를 위한 구조/참조 무결성 검증을 담당한다.
 */

import type {
  GlobalCell,
  GlobalKind,
  RowDefinition,
  RowId,
  ScoreCell,
  ScoreFile,
  TrackId,
} from "./types";
import {
  MAX_CELL_RAW_TEXT_LENGTH,
  MAX_YOUTUBE_OFFSET_MS,
  MAX_ROW_DEFINITIONS,
  MAX_ROW_HEIGHT,
  MAX_SCORE_COLUMN_COUNT,
  MIN_YOUTUBE_OFFSET_MS,
} from "./score_limits";

/**
 * ScoreFile 검증 실패를 구분하는 오류 코드.
 * - invalid_shape : 필드 타입이나 지원 범위가 맞지 않음
 * - duplicate_* : 고유해야 하는 ID 또는 좌표가 중복됨
 * - unknown_row_id : 셀이 존재하지 않는 rowId를 참조함
 * - missing_required_track : 고정 트랙 레이어 중 하나가 없음
 * - missing_global_start_cell : 필수 전역 시작 셀이 없음
 */
export type ScoreValidationErrorCode =
  | "invalid_shape"
  | "missing_required_field"
  | "duplicate_string_id"
  | "duplicate_row_id"
  | "duplicate_track_id"
  | "duplicate_track_cell_coord"
  | "duplicate_global_cell_coord"
  | "missing_required_track"
  | "unknown_row_id"
  | "invalid_cell_row_type"
  | "invalid_global_row_type"
  | "col_out_of_range"
  | "raw_text_out_of_range"
  | "missing_global_start_cell";

/**
 * ScoreFile 구조 또는 참조 무결성 검증 실패 정보.
 * - code : 오류 분류 코드
 * - message : 사용자 또는 개발자에게 전달할 오류 설명
 * - path : 오류가 발견된 ScoreFile 내부 위치
 */
export type ScoreValidationError = {
  code: ScoreValidationErrorCode;
  message: string;
  path?: string;
};

/**
 * ScoreFile 검증 결과.
 * - 정상 검증 시 : ScoreFile
 * - 비정상 검증 시 : ScoreValidationError
 */
export type ScoreValidationResult =
  | {
      ok: true;
      score: ScoreFile;
    }
  | {
      ok: false;
      error: ScoreValidationError;
    };

const TRACK_IDS: TrackId[] = ["basic", "optional", "extra"];
const GLOBAL_KINDS: GlobalKind[] = [
  "bpm",
  "beatsPerBar",
  "stepsPerBeat",
  "dynamics",
];
const MIN_NOTE_MIDI = 0;
const MAX_NOTE_MIDI = 127;
const MIN_GAP_BOUNDARY_MIDI = -1;
const MAX_GAP_BOUNDARY_MIDI = 128;

/**
 * ScoreFile의 최소 구조와 핵심 참조 무결성을 검증한다.
 * - 인수 : value : 이전 모듈에서 건네준 JSON 파싱 성공 객체의 value 필드값.
 * - 반환값 : ScoreValidationResult : 검증 성공 또는 실패 반환 객체.
 */
export function validateScoreFile(value: unknown): ScoreValidationResult {
  // score 후보 객체 여부 확인
  if (!isRecord(value)) {
    return {
      ok: false,
      error: invalidShape("Score root must be an object."),
    };
  }

  // 타입 단언 + Partial<ScoreFile> : value를 불완전할 수 있는 ScoreFile 후보로 해석한다.
  const score = value as Partial<ScoreFile>;

  // 최상위 필드 누락 검사
  const requiredFieldError = validateRequiredTopLevelFields(score);
  if (requiredFieldError) {
    return { ok: false, error: requiredFieldError };
  }

  // 주요 필드의 기본 자료형 검사
  const shapeError = validateBasicShapes(score);
  if (shapeError) {
    return { ok: false, error: shapeError };
  }

  // 위 shape 검사를 통과한 뒤에만 후속 참조 검증을 위해 ScoreFile로 단언한다.
  const scoreFile = score as ScoreFile;

  // stringId의 중복을 검사
  const stringIdError = validateUniqueStringIds(scoreFile);
  if (stringIdError) {
    return { ok: false, error: stringIdError };
  }

  // rowId 중복 여부 검사
  const rowValidation = validateRows(scoreFile.layout.rowDefinitions);
  if (!rowValidation.ok) {
    return { ok: false, error: rowValidation.error };
  }

  const rowStringError = validateRowStringReferences(scoreFile);
  if (rowStringError) {
    return { ok: false, error: rowStringError };
  }

  // trackId가 올바른지 및 중복 여부 검사
  const trackIdError = validateTrackIds(scoreFile);
  if (trackIdError) {
    return { ok: false, error: trackIdError };
  }

  // 전역 셀의 rowId, row 타입, 열 범위, 좌표 중복 검사
  const globalCellError = validateGlobalCells(scoreFile, rowValidation.rowById);
  if (globalCellError) {
    return { ok: false, error: globalCellError };
  }

  // 트랙 셀의 rowId 참조, gap row 참조 금지, 열 범위, 좌표 중복 검사
  const trackCellError = validateTrackCells(scoreFile, rowValidation.rowById);
  if (trackCellError) {
    return { ok: false, error: trackCellError };
  }

  // 필수 전역 종류별 col 0 시작 셀이 존재하는지 검사
  const globalStartError = validateGlobalStartCells(
    scoreFile,
    rowValidation.rowById,
  );
  if (globalStartError) {
    return { ok: false, error: globalStartError };
  }

  // 검사 결과 문제 없으면 ScoreValidationResult 성공 타입 반환
  return {
    ok: true,
    score: scoreFile,
  };
}

/**
 * ScoreFile 최상위 필수 필드가 모두 존재하는지 확인한다.
 * - 인수 : score : 일반 객체로 확인된 ScoreFile 후보 객체
 * - 반환값 : ScoreValidationError | null : 누락 필드 오류 또는 통과 결과
 */
function validateRequiredTopLevelFields(
  score: Partial<ScoreFile>,
): ScoreValidationError | null {
  const requiredFields: (keyof ScoreFile)[] = [
    "format",
    "musicData",
    "instData",
    "layout",
    "globalLines",
    "tracks",
  ];

  // 누락 필드는 후속 shape 검사보다 먼저 보고하여 오류 원인을 분리한다.
  for (const field of requiredFields) {
    // 필드가 존재하지 않으면 해당 필드 경로를 포함한 missing_required_field를 반환한다.
    if (!(field in score)) {
      return {
        code: "missing_required_field",
        message: `Missing required field: ${field}.`,
        path: field,
      };
    }
  }

  return null;
}

/**
 * musicData.youtube 저장 필드의 최소 형태와 offset 범위를 확인한다.
 * - 인수 : musicData : ScoreFile 후보의 musicData 객체
 * - 반환값 : 필드 형태 오류 또는 통과 결과
 */
function validateYoutubeSyncShape(musicData: Record<string, unknown>): ScoreValidationError | null {
  if (!isRecord(musicData.youtube)) {
    return invalidShape("musicData.youtube must be an object.", "musicData.youtube");
  }

  const youtube = musicData.youtube;
  const offsetMs = youtube.offsetMs;

  if (typeof youtube.videoId !== "string") {
    return invalidShape("musicData.youtube.videoId must be a string.", "musicData.youtube.videoId");
  }

  if (
    typeof offsetMs !== "number" ||
    !Number.isInteger(offsetMs) ||
    offsetMs < MIN_YOUTUBE_OFFSET_MS ||
    offsetMs > MAX_YOUTUBE_OFFSET_MS
  ) {
    return invalidShape(
      `musicData.youtube.offsetMs must be an integer from ${MIN_YOUTUBE_OFFSET_MS} to ${MAX_YOUTUBE_OFFSET_MS}.`,
      "musicData.youtube.offsetMs",
    );
  }

  return null;
}

/**
 * 후속 검증에서 직접 접근하는 주요 필드의 기본 형태를 확인한다.
 * - 인수 : score : 필수 최상위 필드 존재 확인을 통과한 ScoreFile 후보 객체
 * - 반환값 : ScoreValidationError | null : 필드 형태 오류 또는 통과 결과
 */
function validateBasicShapes(
  score: Partial<ScoreFile>,
): ScoreValidationError | null {
  // format은 파일 형식/버전 정보를 담는 객체여야 한다.
  if (!isRecord(score.format)) {
    return invalidShape("format must be an object.", "format");
  }

  // musicData는 표시용 메타데이터 묶음이므로 객체 형태가 필요하다.
  if (!isRecord(score.musicData)) {
    return invalidShape("musicData must be an object.", "musicData");
  }

  const youtubeSyncError = validateYoutubeSyncShape(score.musicData);
  if (youtubeSyncError !== null) {
    return youtubeSyncError;
  }

  // instData.strings에 접근하기 전에 instData 자체가 객체인지 먼저 확인한다.
  if (!isRecord(score.instData)) {
    return invalidShape("instData must be an object.", "instData");
  }

  // 현 목록은 stringId 중복 검사의 입력이므로 배열 형태가 필요하다.
  if (!Array.isArray(score.instData.strings)) {
    return invalidShape("instData.strings must be an array.", "instData.strings");
  }

  // layout.rowDefinitions에 접근하기 전에 layout 자체가 객체인지 먼저 확인한다.
  if (!isRecord(score.layout)) {
    return invalidShape("layout must be an object.", "layout");
  }

  // rowDefinitions는 rowId Map 생성과 셀 참조 검증의 기준 배열이다.
  if (!Array.isArray(score.layout.rowDefinitions)) {
    return invalidShape(
      "layout.rowDefinitions must be an array.",
      "layout.rowDefinitions",
    );
  }

  // globalLines.columnCount와 cells에 접근하기 전에 globalLines 객체 여부를 확인한다.
  if (!isRecord(score.globalLines)) {
    return invalidShape("globalLines must be an object.", "globalLines");
  }

  // columnCount는 모든 셀 col 범위 검사의 상한으로 사용된다.
  if (!Number.isInteger(score.globalLines.columnCount)) {
    return invalidShape(
      "globalLines.columnCount must be an integer.",
      "globalLines.columnCount",
    );
  }

  if (
    score.globalLines.columnCount < 1 ||
    score.globalLines.columnCount > MAX_SCORE_COLUMN_COUNT
  ) {
    return invalidShape(
      `globalLines.columnCount must be an integer from 1 to ${MAX_SCORE_COLUMN_COUNT}.`,
      "globalLines.columnCount",
    );
  }

  // 전역 셀 목록은 global kind별 시작 셀과 좌표 중복 검사의 입력이다.
  if (!Array.isArray(score.globalLines.cells)) {
    return invalidShape(
      "globalLines.cells must be an array.",
      "globalLines.cells",
    );
  }

  // tracks는 trackId 검증과 track cell 검증의 기준 배열이다.
  if (!Array.isArray(score.tracks)) {
    return invalidShape("tracks must be an array.", "tracks");
  }

  return null;
}

/**
 * 악기 현 정의의 stringId 중복 여부를 확인한다.
 * - 인수 : score : 기본 형태 검증을 통과한 ScoreFile
 * - 반환값 : ScoreValidationError | null : stringId 중복 오류 또는 통과 결과
 */
function validateUniqueStringIds(score: ScoreFile): ScoreValidationError | null {
  const stringIds = new Set<string>();

  // 각 현의 stringId는 후속 row/string 인덱스의 기준이므로 중복을 허용하지 않는다.
  for (const stringInfo of score.instData.strings) {
    // 이미 등장한 stringId라면 같은 현을 안정적으로 구분할 수 없다.
    if (stringIds.has(stringInfo.stringId)) {
      return {
        code: "duplicate_string_id",
        message: `Duplicate stringId: ${stringInfo.stringId}.`,
        path: "instData.strings",
      };
    }

    stringIds.add(stringInfo.stringId);
  }

  return null;
}

/**
 * rowId 중복 여부를 확인하고 rowId 기반 조회 Map을 생성한다.
 * - 인수 : rows : layout.rowDefinitions 배열
 * - 반환값 : 검증 성공 시 rowById Map, 실패 시 ScoreValidationError
 */
function validateRows(
  rows: RowDefinition[],
):
  | {
      ok: true;
      rowById: Map<RowId, RowDefinition>;
    }
  | {
      ok: false;
      error: ScoreValidationError;
    } {
  const rowById = new Map<RowId, RowDefinition>();

  if (rows.length > MAX_ROW_DEFINITIONS) {
    return {
      ok: false,
      error: invalidShape(
        `layout.rowDefinitions must have ${MAX_ROW_DEFINITIONS} or fewer rows.`,
        "layout.rowDefinitions",
      ),
    };
  }

  // rowById는 이후 global/track cell의 rowId 참조 검증에 재사용된다.
  for (const row of rows) {
    const rowFieldError = validateRowFields(row);

    if (rowFieldError !== null) {
      return {
        ok: false,
        error: rowFieldError,
      };
    }

    // 같은 rowId가 두 행을 가리키면 셀 좌표의 기준이 모호해진다.
    if (rowById.has(row.rowId)) {
      return {
        ok: false,
        error: {
          code: "duplicate_row_id",
          message: `Duplicate rowId: ${row.rowId}.`,
          path: "layout.rowDefinitions",
        },
      };
    }

    rowById.set(row.rowId, row);
  }

  return {
    ok: true,
    rowById,
  };
}

/**
 * rowDefinition 내부 필드의 최소 범위를 확인한다.
 * - 인수 : row : 검사할 row definition
 * - 반환값 : 범위/형태 오류 또는 null
 */
function validateRowFields(row: RowDefinition): ScoreValidationError | null {
  if (!Number.isInteger(row.height) || row.height < 1 || row.height > MAX_ROW_HEIGHT) {
    return invalidShape(
      `Row height must be an integer from 1 to ${MAX_ROW_HEIGHT}: ${row.rowId}.`,
      "layout.rowDefinitions",
    );
  }

  if (row.type === "note") {
    if (!Number.isInteger(row.midi) || row.midi < MIN_NOTE_MIDI || row.midi > MAX_NOTE_MIDI) {
      return invalidShape(`Note row midi out of range: ${row.rowId}.`, "layout.rowDefinitions");
    }
  }

  if (row.type === "gap") {
    if (
      !Number.isInteger(row.fromMidi) ||
      !Number.isInteger(row.toMidi) ||
      row.fromMidi < MIN_GAP_BOUNDARY_MIDI ||
      row.toMidi > MAX_GAP_BOUNDARY_MIDI ||
      row.fromMidi >= row.toMidi
    ) {
      return invalidShape(`Gap row boundary midi out of range: ${row.rowId}.`, "layout.rowDefinitions");
    }
  }

  return null;
}

/**
 * note/gap row의 stringId 참조와 같은 string 안의 note MIDI 중복을 확인한다.
 * - 인수 : score : 기본 row 검증을 통과한 ScoreFile
 * - 반환값 : stringId 참조 또는 MIDI 중복 오류
 */
function validateRowStringReferences(score: ScoreFile): ScoreValidationError | null {
  const stringIds = new Set(score.instData.strings.map((stringInfo) => stringInfo.stringId));
  const noteKeys = new Set<string>();

  for (const row of score.layout.rowDefinitions) {
    if (row.type !== "note" && row.type !== "gap") {
      continue;
    }

    if (!stringIds.has(row.stringId)) {
      return invalidShape(
        `Row references unknown stringId: ${row.rowId}.`,
        "layout.rowDefinitions",
      );
    }

    if (row.type !== "note") {
      continue;
    }

    const noteKey = `${row.stringId}|${row.midi}`;

    if (noteKeys.has(noteKey)) {
      return invalidShape(
        `Duplicate note MIDI in string: ${row.stringId} ${row.midi}.`,
        "layout.rowDefinitions",
      );
    }

    noteKeys.add(noteKey);
  }

  return null;
}

/**
 * tracks 배열의 trackId가 지원 범위 안에 있고 중복되지 않는지 확인한다.
 * - 인수 : score : 기본 형태 검증을 통과한 ScoreFile
 * - 반환값 : ScoreValidationError | null : trackId 오류 또는 통과 결과
 */
function validateTrackIds(score: ScoreFile): ScoreValidationError | null {
  const trackIds = new Set<TrackId>();

  // trackId의 허용 범위와 중복 여부를 먼저 확정해야 필수 트랙 누락을 안정적으로 판정할 수 있다.
  for (const track of score.tracks) {
    // 지원하지 않는 trackId는 UI/parser/analyzer가 처리할 수 없는 레이어이다.
    if (!TRACK_IDS.includes(track.trackId)) {
      return {
        code: "invalid_shape",
        message: `Unsupported trackId: ${track.trackId}.`,
        path: "tracks",
      };
    }

    // 같은 trackId가 중복되면 trackById 인덱스의 기준이 모호해진다.
    if (trackIds.has(track.trackId)) {
      return {
        code: "duplicate_track_id",
        message: `Duplicate trackId: ${track.trackId}.`,
        path: "tracks",
      };
    }

    trackIds.add(track.trackId);
  }

  // 세 트랙을 항상 보장하면 UI/edit/save 경로에서 없는 트랙을 동적으로 생성하지 않아도 된다.
  for (const trackId of TRACK_IDS) {
    if (!trackIds.has(trackId)) {
      return {
        code: "missing_required_track",
        message: `Missing required track: ${trackId}.`,
        path: "tracks",
      };
    }
  }

  return null;
}

/**
 * 전역 셀의 rowId 참조, row 타입, 열 범위, 좌표 중복을 확인한다.
 * - 인수 : score : 기본 형태 검증을 통과한 ScoreFile
 * - 인수 : rowById : validateRows()에서 생성한 rowId 조회 Map
 * - 반환값 : ScoreValidationError | null : 전역 셀 오류 또는 통과 결과
 */
function validateGlobalCells(
  score: ScoreFile,
  rowById: Map<RowId, RowDefinition>,
): ScoreValidationError | null {
  const coords = new Set<string>();
  const columnCount = score.globalLines.columnCount;

  // 전역 셀은 rowId 참조, row 타입, 열 범위, 좌표 유일성을 순서대로 검사한다.
  for (const cell of score.globalLines.cells) {
    const row = rowById.get(cell.rowId);

    // 존재하지 않는 rowId는 parser가 global kind를 유도할 수 없으므로 실패시킨다.
    if (!row) {
      return unknownRowId(cell.rowId, "globalLines.cells");
    }

    // globalLines.cells는 전역 상태 행에만 붙을 수 있으므로 note/gap row 참조를 차단한다.
    if (row.type !== "global") {
      return {
        code: "invalid_global_row_type",
        message: `Global cell rowId must refer to a global row: ${cell.rowId}.`,
        path: "globalLines.cells",
      };
    }

    const colError = validateCellCol(cell, columnCount, "globalLines.cells");
    if (colError) {
      return colError;
    }

    const rawTextError = validateCellRawText(cell, "globalLines.cells");
    if (rawTextError) {
      return rawTextError;
    }

    // 같은 전역 행과 같은 열에는 하나의 전역 셀만 존재할 수 있다.
    const coordKey = `${cell.rowId}|${cell.col}`;
    if (coords.has(coordKey)) {
      return {
        code: "duplicate_global_cell_coord",
        message: `Duplicate global cell coordinate: ${coordKey}.`,
        path: "globalLines.cells",
      };
    }

    coords.add(coordKey);
  }

  return null;
}

/**
 * 트랙 셀의 rowId 참조, gap row 참조 금지, 열 범위, 좌표 중복을 확인한다.
 * - 인수 : score : 기본 형태 검증을 통과한 ScoreFile
 * - 인수 : rowById : validateRows()에서 생성한 rowId 조회 Map
 * - 반환값 : ScoreValidationError | null : 트랙 셀 오류 또는 통과 결과
 */
function validateTrackCells(
  score: ScoreFile,
  rowById: Map<RowId, RowDefinition>,
): ScoreValidationError | null {
  const columnCount = score.globalLines.columnCount;

  for (const track of score.tracks) {
    const coords = new Set<string>();

    // 좌표 중복은 트랙 단위로만 금지한다. 서로 다른 트랙의 같은 좌표는 허용된다.
    for (const cell of track.cells) {
      const row = rowById.get(cell.rowId);

      // 존재하지 않는 rowId는 note 위치와 행 문맥을 알 수 없으므로 실패시킨다.
      if (!row) {
        return unknownRowId(cell.rowId, `tracks.${track.trackId}.cells`);
      }

      // gap row는 화면 간격 표현용 행이므로 실제 입력 셀이 붙을 수 없다.
      if (row.type === "gap") {
        return {
          code: "invalid_cell_row_type",
          message: `Track cell rowId must not refer to a gap row: ${cell.rowId}.`,
          path: `tracks.${track.trackId}.cells`,
        };
      }

      const colError = validateCellCol(
        cell,
        columnCount,
        `tracks.${track.trackId}.cells`,
      );
      if (colError) {
        return colError;
      }

      const rawTextError = validateCellRawText(cell, `tracks.${track.trackId}.cells`);
      if (rawTextError) {
        return rawTextError;
      }

      // 좌표 중복은 트랙별로 검사한다. 서로 다른 트랙의 같은 좌표 입력은 허용된다.
      const coordKey = `${cell.rowId}|${cell.col}`;
      if (coords.has(coordKey)) {
        return {
          code: "duplicate_track_cell_coord",
          message: `Duplicate track cell coordinate in ${track.trackId}: ${coordKey}.`,
          path: `tracks.${track.trackId}.cells`,
        };
      }

      coords.add(coordKey);
    }
  }

  return null;
}

/**
 * 필수 전역 종류가 col 0에 시작 셀을 가지고 있는지 확인한다.
 * - 인수 : score : 기본 형태 검증을 통과한 ScoreFile
 * - 인수 : rowById : validateRows()에서 생성한 rowId 조회 Map
 * - 반환값 : ScoreValidationError | null : 전역 시작 셀 누락 오류 또는 통과 결과
 */
function validateGlobalStartCells(
  score: ScoreFile,
  rowById: Map<RowId, RowDefinition>,
): ScoreValidationError | null {
  const startKinds = new Set<GlobalKind>();

  // 전역 시작값 검사는 col 0 셀만 대상으로 한다.
  for (const cell of score.globalLines.cells) {
    // 시작 시점의 기본 전역 상태만 확인하므로 col 0 셀만 수집한다.
    if (cell.col !== 0) {
      continue;
    }

    const row = rowById.get(cell.rowId);
    if (row?.type === "global") {
      startKinds.add(row.kind);
    }
  }

  // 네 종류의 전역 행은 모두 재생 시작 시점의 기준값을 가져야 한다.
  for (const kind of GLOBAL_KINDS) {
    if (!startKinds.has(kind)) {
      return {
        code: "missing_global_start_cell",
        message: `Missing global ${kind} start cell at col 0.`,
        path: "globalLines.cells",
      };
    }
  }

  return null;
}

/**
 * 셀의 열 좌표가 정수이며 악보 열 범위 안에 있는지 확인한다.
 * - 인수 : cell : 열 좌표를 가진 ScoreCell 또는 GlobalCell
 * - 인수 : columnCount : 악보 전체 열 개수
 * - 인수 : path : 오류가 발생한 ScoreFile 내부 위치
 * - 반환값 : ScoreValidationError | null : 열 범위 오류 또는 통과 결과
 */
function validateCellCol(
  cell: ScoreCell | GlobalCell,
  columnCount: number,
  path: string,
): ScoreValidationError | null {
  if (
    !Number.isInteger(cell.col) ||
    cell.col < 0 ||
    cell.col >= columnCount
  ) {
    return {
      code: "col_out_of_range",
      message: `Cell col out of range: ${cell.col}.`,
      path,
    };
  }

  return null;
}

/**
 * 셀 rawText가 저장 가능한 문자열이며 길이 제한 안에 있는지 확인한다.
 * - 인수 : cell : rawText를 가진 ScoreCell 또는 GlobalCell
 * - 인수 : path : 오류가 발생한 ScoreFile 내부 위치
 * - 반환값 : rawText 범위 오류 또는 null
 */
function validateCellRawText(
  cell: ScoreCell | GlobalCell,
  path: string,
): ScoreValidationError | null {
  if (typeof cell.rawText !== "string") {
    return {
      code: "raw_text_out_of_range",
      message: "Cell rawText must be a string.",
      path,
    };
  }

  if (cell.rawText.length === 0 || cell.rawText.length > MAX_CELL_RAW_TEXT_LENGTH) {
    return {
      code: "raw_text_out_of_range",
      message: `Cell rawText length must be 1..${MAX_CELL_RAW_TEXT_LENGTH}.`,
      path,
    };
  }

  return null;
}

/**
 * 존재하지 않는 rowId 참조 오류 객체를 생성한다.
 * - 인수 : rowId : 셀이 참조했지만 layout.rowDefinitions에 없는 rowId
 * - 인수 : path : 오류가 발생한 ScoreFile 내부 위치
 * - 반환값 : ScoreValidationError : unknown_row_id 오류 객체
 */
function unknownRowId(rowId: RowId, path: string): ScoreValidationError {
  return {
    code: "unknown_row_id",
    message: `Unknown rowId: ${rowId}.`,
    path,
  };
}

/**
 * 필드 형식이 맞지 않는 경우 ScoreValidationError 객체를 생성한다.
 * - 인수 : message : 사용자에게 보일 오류 메시지 문자열
 * - 인수 : path : 오류 발생 위치 문자열. 생략 가능
 * - 반환값 : ScoreValidationError : invalid_shape 오류 객체
 */
function invalidShape(message: string, path?: string): ScoreValidationError {
  return {
    code: "invalid_shape",
    message,
    path,
  };
}

/**
 * 입력값이 ScoreFile 후보로 다룰 수 있는 일반 객체인지 확인한다.
 * - 인수 : value : JSON 파싱 이후의 unknown 값
 * - 반환값 : value is Record<string, unknown> : null과 배열을 제외한 object 여부
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  // typeof null도 object로 평가되며, 배열도 object의 일종이므로 둘 다 명시적으로 제외한다.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
