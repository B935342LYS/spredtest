/**
 * src/core/analyze/analyze_global_segments.ts
 * 전역 행 parsed cell stream을 analyzer timeline segment 생성에 필요한 값 범위로 정규화한다.
 */

import type { GlobalKind } from "../score/types";
import type {
  ParsedGlobalCellEntry,
  ParsedInstantGlobalCell,
  ParsedLinearGlobalCell,
} from "../parse/types";
import type {
  AnalyzeContext,
  SegmentCurve,
  SourceCellRef,
  TimeRange,
} from "./types";

type LinearGlobalKind = Extract<GlobalKind, "bpm" | "dynamics">;
type InstantGlobalKind = Extract<GlobalKind, "beatsPerBar" | "stepsPerBeat">;

type LinearGlobalEntry = ParsedGlobalCellEntry & {
  parsedCell: ParsedLinearGlobalCell;
};

type InstantGlobalEntry = ParsedGlobalCellEntry & {
  parsedCell: ParsedInstantGlobalCell;
};

type NumericGlobalEntry = LinearGlobalEntry | InstantGlobalEntry;

type RampInterval = {
  startEntry: LinearGlobalEntry;
  endEntry: LinearGlobalEntry;
};

/** 전역 값 stream을 특정 segment 범위에서 조회한 결과. */
export type ResolvedGlobalRange = {
  startValue: number;
  endValue: number;
  curve: SegmentCurve;
  sourceCells: SourceCellRef[];
};

/** instant 전역 값 stream을 특정 col에서 조회한 결과. */
export type ResolvedInstantGlobalValue = {
  value: number;
  sourceCells: SourceCellRef[];
};

/**
 * 특정 전역 kind의 유효한 숫자 entry를 col 오름차순으로 모은다.
 * - 인수 : context : score/index/parsed 문맥
 * - 인수 : kind : 조회할 전역 행 종류
 * - 반환값 : NumericGlobalEntry[] : invalid를 제외한 숫자 전역 셀 목록
 */
export function getValidGlobalEntries(
  context: AnalyzeContext,
  kind: GlobalKind,
): NumericGlobalEntry[] {
  const entries = Array.from(
    context.parsed.globalCellsByKindAndCol.get(kind)?.values() ?? [],
  );

  return entries
    .filter((entry): entry is NumericGlobalEntry => isNumericGlobalEntry(entry))
    .sort((left, right) => left.col - right.col);
}

/**
 * 경계 col 목록을 문서 범위 안에서 정렬하고 중복 제거한다.
 * - 인수 : columnCount : 문서 전체 column 수
 * - 인수 : entryGroups : 경계 후보가 되는 전역 entry 묶음
 * - 반환값 : number[] : 0과 columnCount를 포함한 경계 col 목록
 */
export function collectBoundaryColumns(
  columnCount: number,
  entryGroups: NumericGlobalEntry[][],
): number[] {
  const boundarySet = new Set<number>([0, columnCount]);

  // 유효한 전역 셀의 col은 해당 값이 바뀌는 경계이므로 segment 분할 기준에 추가한다.
  for (const entries of entryGroups) {
    for (const entry of entries) {
      if (entry.col >= 0 && entry.col < columnCount) {
        boundarySet.add(entry.col);
      }
    }
  }

  return Array.from(boundarySet).sort((left, right) => left - right);
}

/**
 * number col 범위에서 analyzer TimeRange를 만든다.
 * - 인수 : startCol : segment 시작 col
 * - 인수 : endCol : segment 끝 col
 * - 반환값 : TimeRange : analyzer 공통 시간 범위
 */
export function createColumnTimeRange(
  startCol: number,
  endCol: number,
): TimeRange {
  return {
    startTick: {
      numerator: startCol,
      denominator: 1,
    },
    endTick: {
      numerator: endCol,
      denominator: 1,
    },
  };
}

/**
 * 선형 변화 가능 전역 stream을 특정 col 범위에서 조회한다.
 * - 인수 : entries : bpm 또는 dynamics 숫자 entry 목록
 * - 인수 : startCol : segment 시작 col
 * - 인수 : endCol : segment 끝 col
 * - 인수 : fallback : 유효 entry가 없을 때 사용할 값
 * - 반환값 : ResolvedGlobalRange : segment 시작/끝 값과 curve
 */
export function resolveLinearGlobalRange(
  entries: NumericGlobalEntry[],
  startCol: number,
  endCol: number,
  fallback: number,
): ResolvedGlobalRange {
  const linearEntries = entries.filter(
    (entry): entry is LinearGlobalEntry => isLinearGlobalEntry(entry),
  );
  const ramp = findRampIntervalForRange(
    buildRampIntervals(linearEntries),
    startCol,
    endCol,
  );

  if (ramp !== null) {
    const startValue = interpolateRampValue(ramp, startCol);
    const endValue = interpolateRampValue(ramp, endCol);

    return {
      startValue,
      endValue,
      curve: Math.abs(startValue - endValue) < 1e-9 ? "instant" : "linear",
      sourceCells: [
        toSourceCell(ramp.startEntry),
        toSourceCell(ramp.endEntry),
      ],
    };
  }

  const latestEntry = findLatestEntryAtOrBefore(entries, startCol);
  const value = latestEntry?.parsedCell.value ?? fallback;

  return {
    startValue: value,
    endValue: value,
    curve: "instant",
    sourceCells: latestEntry === null ? [] : [toSourceCell(latestEntry)],
  };
}

/**
 * instant 전역 stream을 특정 col에서 조회한다.
 * - 인수 : entries : beatsPerBar 또는 stepsPerBeat 숫자 entry 목록
 * - 인수 : col : 조회할 segment 시작 col
 * - 인수 : fallback : 유효 entry가 없을 때 사용할 값
 * - 반환값 : ResolvedInstantGlobalValue : 현재 값과 source cell
 */
export function resolveInstantGlobalValue(
  entries: NumericGlobalEntry[],
  col: number,
  fallback: number,
): ResolvedInstantGlobalValue {
  const instantEntries = entries.filter(
    (entry): entry is InstantGlobalEntry => isInstantGlobalEntry(entry),
  );
  const latestEntry = findLatestEntryAtOrBefore(instantEntries, col);
  const value = latestEntry?.parsedCell.value ?? fallback;

  return {
    value,
    sourceCells: latestEntry === null ? [] : [toSourceCell(latestEntry)],
  };
}

/**
 * sourceCells 배열을 rowId/col 기준으로 중복 제거한다.
 * - 인수 : sourceGroups : 합칠 source cell 배열 묶음
 * - 반환값 : SourceCellRef[] : 입력 순서를 유지한 고유 source cell 목록
 */
export function mergeSourceCells(
  sourceGroups: SourceCellRef[][],
): SourceCellRef[] {
  const seen = new Set<string>();
  const result: SourceCellRef[] = [];

  // timeline source는 stream 우선순위 순서로 넣고 같은 cell이 중복되면 한 번만 보존한다.
  for (const sources of sourceGroups) {
    for (const source of sources) {
      const key = `${source.rowId}|${source.col}|${source.slotIndex ?? ""}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(source);
    }
  }

  return result;
}

/**
 * 전역 entry가 숫자 값 parser 결과인지 확인한다.
 * - 인수 : entry : 검사할 parsed global entry
 * - 반환값 : entry is NumericGlobalEntry : invalid가 아닌 전역 숫자 entry 여부
 */
function isNumericGlobalEntry(
  entry: ParsedGlobalCellEntry,
): entry is NumericGlobalEntry {
  return isLinearGlobalEntry(entry) || isInstantGlobalEntry(entry);
}

/**
 * 전역 entry가 bpm/dynamics 선형 가능 entry인지 확인한다.
 * - 인수 : entry : 검사할 parsed global entry
 * - 반환값 : entry is LinearGlobalEntry : linear global entry 여부
 */
function isLinearGlobalEntry(
  entry: ParsedGlobalCellEntry,
): entry is LinearGlobalEntry {
  return entry.parsedCell.kind === "linearGlobalValue" &&
    isLinearGlobalKind(entry.parsedCell.globalKind);
}

/**
 * 전역 entry가 beatsPerBar/stepsPerBeat instant entry인지 확인한다.
 * - 인수 : entry : 검사할 parsed global entry
 * - 반환값 : entry is InstantGlobalEntry : instant global entry 여부
 */
function isInstantGlobalEntry(
  entry: ParsedGlobalCellEntry,
): entry is InstantGlobalEntry {
  return entry.parsedCell.kind === "instantGlobalValue" &&
    isInstantGlobalKind(entry.parsedCell.globalKind);
}

/**
 * GlobalKind가 선형 변화 가능 kind인지 확인한다.
 * - 인수 : kind : 검사할 GlobalKind
 * - 반환값 : kind is LinearGlobalKind : bpm 또는 dynamics 여부
 */
function isLinearGlobalKind(kind: GlobalKind): kind is LinearGlobalKind {
  return kind === "bpm" || kind === "dynamics";
}

/**
 * GlobalKind가 즉시 적용 kind인지 확인한다.
 * - 인수 : kind : 검사할 GlobalKind
 * - 반환값 : kind is InstantGlobalKind : beatsPerBar 또는 stepsPerBeat 여부
 */
function isInstantGlobalKind(kind: GlobalKind): kind is InstantGlobalKind {
  return kind === "beatsPerBar" || kind === "stepsPerBeat";
}

/**
 * ramp token stream에서 실제로 성립한 start/end 쌍을 만든다.
 * - 인수 : entries : bpm 또는 dynamics entry 목록
 * - 반환값 : RampInterval[] : 완성된 선형 변화 구간 목록
 */
function buildRampIntervals(entries: LinearGlobalEntry[]): RampInterval[] {
  const intervals: RampInterval[] = [];
  let openStart: LinearGlobalEntry | null = null;

  // 미완성 ramp는 편집 중 상태로 보고 interval을 만들지 않는다.
  for (const entry of entries) {
    const ramp = entry.parsedCell.ramp;

    if (ramp === "none") {
      openStart = null;
      continue;
    }

    if (ramp === "start") {
      openStart = entry;
      continue;
    }

    if ((ramp === "end" || ramp === "endStart") && openStart !== null) {
      if (openStart.col < entry.col) {
        intervals.push({
          startEntry: openStart,
          endEntry: entry,
        });
      }

      openStart = null;
    }

    if (ramp === "endStart") {
      openStart = entry;
    }
  }

  return intervals;
}

/**
 * 특정 segment 범위를 완전히 포함하는 ramp interval을 찾는다.
 * - 인수 : intervals : 성립한 ramp interval 목록
 * - 인수 : startCol : segment 시작 col
 * - 인수 : endCol : segment 끝 col
 * - 반환값 : RampInterval | null : 포함하는 ramp 또는 null
 */
function findRampIntervalForRange(
  intervals: RampInterval[],
  startCol: number,
  endCol: number,
): RampInterval | null {
  return intervals.find(
    (interval) =>
      startCol >= interval.startEntry.col &&
      endCol <= interval.endEntry.col &&
      startCol < interval.endEntry.col,
  ) ?? null;
}

/**
 * ramp interval 안의 특정 col에서 선형 보간 값을 구한다.
 * - 인수 : interval : 성립한 ramp interval
 * - 인수 : col : 보간할 col
 * - 반환값 : number : 보간된 값
 */
function interpolateRampValue(interval: RampInterval, col: number): number {
  const startCol = interval.startEntry.col;
  const endCol = interval.endEntry.col;
  const ratio = (col - startCol) / (endCol - startCol);

  return interval.startEntry.parsedCell.value +
    (interval.endEntry.parsedCell.value - interval.startEntry.parsedCell.value) * ratio;
}

/**
 * 특정 col 이하에서 가장 가까운 entry를 찾는다.
 * - 인수 : entries : col 오름차순 entry 목록
 * - 인수 : col : 조회할 col
 * - 반환값 : entry 또는 null
 */
function findLatestEntryAtOrBefore<T extends NumericGlobalEntry>(
  entries: T[],
  col: number,
): T | null {
  let latest: T | null = null;

  // entry 목록은 col 오름차순이므로 조회 col을 넘으면 탐색을 중단한다.
  for (const entry of entries) {
    if (entry.col > col) {
      break;
    }

    latest = entry;
  }

  return latest;
}

/**
 * parsed global entry를 analyzer source cell 참조로 바꾼다.
 * - 인수 : entry : 전역 parsed entry
 * - 반환값 : SourceCellRef : rowId/col source 참조
 */
function toSourceCell(entry: NumericGlobalEntry): SourceCellRef {
  return {
    rowId: entry.rowId,
    col: entry.col,
  };
}
