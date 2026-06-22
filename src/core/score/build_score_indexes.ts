/**
 * src\core\score\build_score_indexes.ts
 * validator를 통과한 ScoreFile에서 런타임 조회용 ScoreIndexes를 생성한다.
 * 이 파일은 저장 JSON 구조를 변경하지 않고, parser/analyzer/renderer가 반복 조회할 파생 Map을 만든다.
 */

import type {
  CellCoordKey,
  GlobalCell,
  GlobalCellCoordKey,
  GlobalKind,
  RowDefinition,
  RowId,
  ScoreCell,
  ScoreFile,
  ScoreIndexes,
  StringId,
  Track,
  TrackId,
} from "./types";

/**
 * ScoreFile에서 런타임 조회용 인덱스 묶음을 생성한다.
 * - 인수 : score : score_validate.ts 검증을 통과한 ScoreFile
 * - 반환값 : ScoreIndexes : parser/analyzer/renderer가 공유하는 조회용 파생 구조
 */
export function buildScoreIndexes(score: ScoreFile): ScoreIndexes {
  // 행 인덱스는 전역 셀 kind 유도에도 필요하므로 다른 전역 인덱스보다 먼저 만든다.
  const rowById = buildRowById(score.layout.rowDefinitions);

  // 표시 순서 배열은 원본 rowDefinitions의 순서를 보존하는 별도 view로 둔다.
  const rowsInDisplayOrder = [...score.layout.rowDefinitions];

  // note row 관련 인덱스는 현 단위 조회와 string/midi 역조회 축을 분리한다.
  const noteRowIdsByStringId = buildNoteRowIdsByStringId(
    score.layout.rowDefinitions,
  );
  const noteRowIdByStringMidi = buildNoteRowIdByStringMidi(
    score.layout.rowDefinitions,
  );

  // track 인덱스는 trackId 단건 조회와 좌표/열 단위 셀 조회를 각각 담당한다.
  const trackById = buildTrackById(score.tracks);
  const cellMapByTrackId = buildCellMapByTrackId(score.tracks);
  const cellsByTrackAndCol = buildCellsByTrackAndCol(score.tracks);

  // 전역 셀 인덱스는 좌표 조회, kind/col 조회, col 순회 배열을 모두 제공한다.
  const globalCellMapByCoord = buildGlobalCellMapByCoord(
    score.globalLines.cells,
  );
  const globalCellsByKindAndCol = buildGlobalCellsByKindAndCol(
    score.globalLines.cells,
    rowById,
  );
  const globalCellsInColOrder = buildGlobalCellsInColOrder(
    score.globalLines.cells,
    rowById,
  );

  return {
    rowById,
    rowsInDisplayOrder,
    noteRowIdsByStringId,
    noteRowIdByStringMidi,
    trackById,
    cellMapByTrackId,
    cellsByTrackAndCol,
    globalCellMapByCoord,
    globalCellsByKindAndCol,
    globalCellsInColOrder,
  };
}

/**
 * rowId로 RowDefinition을 바로 찾기 위한 Map을 생성한다.
 * - 인수 : rows : layout.rowDefinitions 배열
 * - 반환값 : Map<RowId, RowDefinition> : rowId 기반 행 정의 조회 Map
 */
function buildRowById(rows: RowDefinition[]): Map<RowId, RowDefinition> {
  const rowById = new Map<RowId, RowDefinition>();

  // validator가 rowId 중복을 이미 막았으므로 여기서는 조회 Map만 구성한다.
  for (const row of rows) {
    rowById.set(row.rowId, row);
  }

  return rowById;
}

/**
 * stringId별 note rowId 목록을 display 순서대로 묶는다.
 * - 인수 : rows : layout.rowDefinitions 배열
 * - 반환값 : Map<StringId, RowId[]> : 현별 note rowId 목록
 */
function buildNoteRowIdsByStringId(
  rows: RowDefinition[],
): Map<StringId, RowId[]> {
  const noteRowIdsByStringId = new Map<StringId, RowId[]>();

  // note row만 현별 그룹에 포함하고 global/gap row는 제외한다.
  for (const row of rows) {
    if (row.type !== "note") {
      continue;
    }

    const rowIds = noteRowIdsByStringId.get(row.stringId) ?? [];

    // rowDefinitions 순회 순서를 그대로 유지해 display 순서 기반 목록을 만든다.
    rowIds.push(row.rowId);
    noteRowIdsByStringId.set(row.stringId, rowIds);
  }

  return noteRowIdsByStringId;
}

/**
 * stringId와 midi 조합으로 note rowId를 찾기 위한 Map을 생성한다.
 * - 인수 : rows : layout.rowDefinitions 배열
 * - 반환값 : Map<`${StringId}|${number}`, RowId> : 현/음정 조합 기반 note rowId 조회 Map
 */
function buildNoteRowIdByStringMidi(
  rows: RowDefinition[],
): Map<`${StringId}|${number}`, RowId> {
  const noteRowIdByStringMidi = new Map<`${StringId}|${number}`, RowId>();

  // @n(midi_num) 같은 음정 기반 참조를 실제 note rowId로 연결하기 위한 역방향 Map이다.
  for (const row of rows) {
    if (row.type !== "note") {
      continue;
    }

    noteRowIdByStringMidi.set(
      createStringMidiKey(row.stringId, row.midi),
      row.rowId,
    );
  }

  return noteRowIdByStringMidi;
}

/**
 * trackId로 Track을 바로 찾기 위한 Map을 생성한다.
 * - 인수 : tracks : ScoreFile.tracks 배열
 * - 반환값 : Map<TrackId, Track> : trackId 기반 트랙 조회 Map
 */
function buildTrackById(tracks: Track[]): Map<TrackId, Track> {
  const trackById = new Map<TrackId, Track>();

  // validator가 trackId 중복을 이미 막았으므로 마지막 값 덮어쓰기 위험은 없다.
  for (const track of tracks) {
    trackById.set(track.trackId, track);
  }

  return trackById;
}

/**
 * 트랙별 좌표 key로 단일 ScoreCell을 찾기 위한 Map을 생성한다.
 * - 인수 : tracks : ScoreFile.tracks 배열
 * - 반환값 : Map<TrackId, Map<CellCoordKey, ScoreCell>> : 트랙/좌표 기반 셀 조회 Map
 */
function buildCellMapByTrackId(
  tracks: Track[],
): Map<TrackId, Map<CellCoordKey, ScoreCell>> {
  const cellMapByTrackId = new Map<TrackId, Map<CellCoordKey, ScoreCell>>();

  // 각 트랙 내부에서 rowId|col 좌표로 단일 셀을 찾을 수 있게 한다.
  for (const track of tracks) {
    const cellMap = new Map<CellCoordKey, ScoreCell>();

    // validator가 같은 트랙 내부 좌표 중복을 막았으므로 좌표 key는 단일 셀에 대응한다.
    for (const cell of track.cells) {
      cellMap.set(createCellCoordKey(cell), cell);
    }

    cellMapByTrackId.set(track.trackId, cellMap);
  }

  return cellMapByTrackId;
}

/**
 * 트랙별, 열별로 ScoreCell 배열을 찾기 위한 Map을 생성한다.
 * - 인수 : tracks : ScoreFile.tracks 배열
 * - 반환값 : Map<TrackId, Map<number, ScoreCell[]>> : 트랙/열 기반 셀 목록 조회 Map
 */
function buildCellsByTrackAndCol(
  tracks: Track[],
): Map<TrackId, Map<number, ScoreCell[]>> {
  const cellsByTrackAndCol = new Map<TrackId, Map<number, ScoreCell[]>>();

  // partial parse/analysis는 열 범위를 기준으로 삼으므로 col별 셀 묶음을 따로 만든다.
  for (const track of tracks) {
    const cellsByCol = new Map<number, ScoreCell[]>();

    // 같은 열에는 서로 다른 row의 셀이 여러 개 있을 수 있으므로 배열로 보관한다.
    for (const cell of track.cells) {
      const cells = cellsByCol.get(cell.col) ?? [];
      cells.push(cell);
      cellsByCol.set(cell.col, cells);
    }

    cellsByTrackAndCol.set(track.trackId, cellsByCol);
  }

  return cellsByTrackAndCol;
}

/**
 * 전역 셀 좌표 key로 단일 GlobalCell을 찾기 위한 Map을 생성한다.
 * - 인수 : globalCells : ScoreFile.globalLines.cells 배열
 * - 반환값 : Map<GlobalCellCoordKey, GlobalCell> : 전역 셀 좌표 기반 조회 Map
 */
function buildGlobalCellMapByCoord(
  globalCells: GlobalCell[],
): Map<GlobalCellCoordKey, GlobalCell> {
  const globalCellMapByCoord = new Map<GlobalCellCoordKey, GlobalCell>();

  // 전역 셀은 track 축이 없으므로 rowId|col 좌표만으로 단건 조회한다.
  for (const cell of globalCells) {
    globalCellMapByCoord.set(createGlobalCellCoordKey(cell), cell);
  }

  return globalCellMapByCoord;
}

/**
 * 전역 종류와 열 좌표로 GlobalCell을 찾기 위한 Map을 생성한다.
 * - 인수 : globalCells : ScoreFile.globalLines.cells 배열
 * - 인수 : rowById : rowId 기반 행 정의 조회 Map
 * - 반환값 : Map<GlobalKind, Map<number, GlobalCell>> : 전역 종류/열 기반 조회 Map
 */
function buildGlobalCellsByKindAndCol(
  globalCells: GlobalCell[],
  rowById: Map<RowId, RowDefinition>,
): Map<GlobalKind, Map<number, GlobalCell>> {
  const globalCellsByKindAndCol = new Map<GlobalKind, Map<number, GlobalCell>>();

  // rowId에서 GlobalKind를 유도하여 parser/analyzer가 kind 축으로 전역 셀을 조회하게 한다.
  for (const cell of globalCells) {
    const row = rowById.get(cell.rowId);

    // validator 통과 이후에는 global row만 들어오지만, 타입 좁히기를 위해 다시 확인한다.
    if (row?.type !== "global") {
      continue;
    }

    const cellsByCol = globalCellsByKindAndCol.get(row.kind) ?? new Map();
    cellsByCol.set(cell.col, cell);
    globalCellsByKindAndCol.set(row.kind, cellsByCol);
  }

  return globalCellsByKindAndCol;
}

/**
 * 전역 종류별 GlobalCell 배열을 열 오름차순으로 생성한다.
 * - 인수 : globalCells : ScoreFile.globalLines.cells 배열
 * - 인수 : rowById : rowId 기반 행 정의 조회 Map
 * - 반환값 : Map<GlobalKind, GlobalCell[]> : 전역 종류별 col 오름차순 셀 배열
 */
function buildGlobalCellsInColOrder(
  globalCells: GlobalCell[],
  rowById: Map<RowId, RowDefinition>,
): Map<GlobalKind, GlobalCell[]> {
  const globalCellsInColOrder = new Map<GlobalKind, GlobalCell[]>();

  // analyzer timeline 생성은 같은 kind의 전역 셀을 시간 순서대로 훑어야 한다.
  for (const cell of globalCells) {
    const row = rowById.get(cell.rowId);

    // analyzer의 timeline 생성 입력이므로 global row에 속한 셀만 정렬 목록에 포함한다.
    if (row?.type !== "global") {
      continue;
    }

    const cells = globalCellsInColOrder.get(row.kind) ?? [];
    cells.push(cell);
    globalCellsInColOrder.set(row.kind, cells);
  }

  // 입력 JSON의 정렬 상태와 무관하게 analyzer가 안정적인 col 순서를 받도록 정렬한다.
  for (const cells of globalCellsInColOrder.values()) {
    cells.sort(compareCellsByColThenRowId);
  }

  return globalCellsInColOrder;
}

/**
 * ScoreCell의 rowId와 col을 좌표 key로 변환한다.
 * - 인수 : cell : 좌표 key를 만들 ScoreCell
 * - 반환값 : CellCoordKey : `${rowId}|${col}` 형식의 좌표 key
 */
function createCellCoordKey(cell: ScoreCell): CellCoordKey {
  return `${cell.rowId}|${cell.col}`;
}

/**
 * GlobalCell의 rowId와 col을 좌표 key로 변환한다.
 * - 인수 : cell : 좌표 key를 만들 GlobalCell
 * - 반환값 : GlobalCellCoordKey : `${rowId}|${col}` 형식의 좌표 key
 */
function createGlobalCellCoordKey(cell: GlobalCell): GlobalCellCoordKey {
  return `${cell.rowId}|${cell.col}`;
}

/**
 * stringId와 midi를 note row 조회용 key로 변환한다.
 * - 인수 : stringId : 현 식별자
 * - 인수 : midi : MIDI note number
 * - 반환값 : `${StringId}|${number}` : `${stringId}|${midi}` 형식의 조회 key
 */
function createStringMidiKey(
  stringId: StringId,
  midi: number,
): `${StringId}|${number}` {
  return `${stringId}|${midi}`;
}

/**
 * 셀 배열 정렬을 위해 col을 우선하고 rowId를 보조 기준으로 비교한다.
 * - 인수 : left : 비교할 왼쪽 셀
 * - 인수 : right : 비교할 오른쪽 셀
 * - 반환값 : number : Array.prototype.sort()에서 사용하는 비교 결과
 */
function compareCellsByColThenRowId(
  left: GlobalCell | ScoreCell,
  right: GlobalCell | ScoreCell,
): number {
  // timeline과 열 단위 처리가 우선이므로 col을 1차 정렬 기준으로 둔다.
  if (left.col !== right.col) {
    return left.col - right.col;
  }

  // 같은 열 안에서는 rowId 기준으로 정렬해 실행마다 순서가 흔들리지 않게 한다.
  return left.rowId.localeCompare(right.rowId);
}
