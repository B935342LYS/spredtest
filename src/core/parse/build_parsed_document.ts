/**
 * src/core/parse/build_parsed_document.ts
 * ScoreFile의 모든 rawText 셀을 문서 단위 ParsedScoreDocument로 변환한다.
 * 이 파일은 셀 간 의미 분석을 수행하지 않고, 단일 셀 parser 결과를 analyzer 입력 축으로 묶는다.
 */

import type {
  GlobalKind,
  GlobalRowDefinition,
  RuntimeDocument,
  ScoreFile,
  ScoreIndexes,
  Track,
} from "../score/types";
import { parseGlobalCell } from "./parse_global_cell";
import { parseNoteCell } from "./parse_note_cell";
import type {
  ParsedCellEntry,
  ParsedGlobalCellEntry,
  ParsedScoreDocument,
} from "./types";

/**
 * RuntimeDocument 전체를 ParsedScoreDocument로 파싱한다.
 * - 인수 : document : validator와 index builder를 통과한 런타임 문서
 * - 반환값 : ParsedScoreDocument : analyzer가 소비할 문서 단위 parser 결과
 */
export function buildParsedDocument(
  document: RuntimeDocument,
): ParsedScoreDocument {
  const { score, indexes } = document;

  return {
    noteCellsByTrackAndCol: buildParsedNoteCells(score, indexes),
    globalCellsByKindAndCol: buildParsedGlobalCells(score, indexes),
  };
}

/**
 * 모든 track note 셀을 trackId와 col 기준 Map으로 파싱한다.
 * - 인수 : score : 악보 원본
 * - 인수 : indexes : score에서 파생된 런타임 조회 인덱스
 * - 반환값 : Map : trackId -> col -> ParsedCellEntry[] 구조
 */
function buildParsedNoteCells(
  score: ScoreFile,
  indexes: ScoreIndexes,
): ParsedScoreDocument["noteCellsByTrackAndCol"] {
  const result: ParsedScoreDocument["noteCellsByTrackAndCol"] = new Map();

  // track별 col Map은 analyzer의 track 단위 처리와 partial parse 축에 맞춰 만든다.
  for (const track of score.tracks) {
    result.set(track.trackId, buildParsedTrackCells(track));
  }

  // 현재 구현에서는 note 셀 경로에서 indexes를 직접 조회하지 않지만, 공개 함수 계약과 맞춘다.
  void indexes;

  return result;
}

/**
 * 단일 track의 모든 note 셀을 col 기준으로 파싱한다.
 * - 인수 : track : 파싱할 track 원본
 * - 반환값 : Map : col -> ParsedCellEntry[] 구조
 */
function buildParsedTrackCells(track: Track): Map<number, ParsedCellEntry[]> {
  const entriesByCol = new Map<number, ParsedCellEntry[]>();

  // 원본 track.cells 순회를 기준으로 위치 정보와 단일 셀 parser 결과를 함께 저장한다.
  for (const cell of track.cells) {
    const parsedCell = parseNoteCell({
      trackId: track.trackId,
      rowId: cell.rowId,
      col: cell.col,
      rawText: cell.rawText,
    });
    const entry: ParsedCellEntry = {
      trackId: track.trackId,
      rowId: cell.rowId,
      col: cell.col,
      parsedCell,
    };

    appendMapArray(entriesByCol, cell.col, entry);
  }

  return entriesByCol;
}

/**
 * 모든 global 셀을 global kind와 col 기준 Map으로 파싱한다.
 * - 인수 : score : 악보 원본
 * - 인수 : indexes : score에서 파생된 런타임 조회 인덱스
 * - 반환값 : Map : GlobalKind -> col -> ParsedGlobalCellEntry 구조
 */
function buildParsedGlobalCells(
  score: ScoreFile,
  indexes: ScoreIndexes,
): ParsedScoreDocument["globalCellsByKindAndCol"] {
  const result = createEmptyGlobalKindMap();

  // global parser는 rowId에서 kind를 유도하므로 rowById 문맥을 함께 전달한다.
  for (const cell of score.globalLines.cells) {
    const row = asGlobalRow(indexes.rowById.get(cell.rowId));
    const parsedCell = parseGlobalCell(cell, {
      rowById: indexes.rowById,
    });

    if (row === null) {
      continue;
    }

    result.get(row.kind)?.set(cell.col, {
      rowId: cell.rowId,
      kind: row.kind,
      col: cell.col,
      parsedCell,
    });
  }

  return result;
}

/**
 * 네 종류의 전역 행 kind를 모두 가진 빈 Map을 생성한다.
 * - 반환값 : Map : GlobalKind -> 빈 col Map 구조
 */
function createEmptyGlobalKindMap(): ParsedScoreDocument["globalCellsByKindAndCol"] {
  return new Map<GlobalKind, Map<number, ParsedGlobalCellEntry>>([
    ["bpm", new Map()],
    ["beatsPerBar", new Map()],
    ["stepsPerBeat", new Map()],
    ["dynamics", new Map()],
  ]);
}

/**
 * Map의 배열 값에 새 항목을 추가한다.
 * - 인수 : map : 배열 값을 담는 Map
 * - 인수 : key : 항목을 추가할 key
 * - 인수 : value : 배열에 추가할 값
 * - 반환값 : void : map을 제자리에서 갱신한다
 */
function appendMapArray<K, V>(
  map: Map<K, V[]>,
  key: K,
  value: V,
): void {
  const existing = map.get(key);

  // 같은 col에 여러 note 행 셀이 올 수 있으므로 배열 누적 구조를 사용한다.
  if (existing !== undefined) {
    existing.push(value);
    return;
  }

  map.set(key, [value]);
}

/**
 * RowDefinition에서 전역 행만 좁혀 반환한다.
 * - 인수 : row : rowById에서 찾은 행 정의 후보
 * - 반환값 : GlobalRowDefinition | null : 전역 행이면 해당 행, 아니면 null
 */
function asGlobalRow(row: unknown): GlobalRowDefinition | null {
  if (
    typeof row === "object" &&
    row !== null &&
    "type" in row &&
    row.type === "global"
  ) {
    return row as GlobalRowDefinition;
  }

  return null;
}
