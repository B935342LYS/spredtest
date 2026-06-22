/**
 * src/core/analyze/analyze_dynamics.ts
 * dynamics 전역 행을 volume 세그먼트 배열로 정규화한다.
 */

import {
  collectBoundaryColumns,
  createColumnTimeRange,
  getValidGlobalEntries,
  resolveLinearGlobalRange,
} from "./analyze_global_segments";
import type {
  AnalyzeContext,
  AnalyzedDynamicsSegment,
  AnalyzeDynamicsTimelineFn,
} from "./types";

const DEFAULT_DYNAMICS = 100;

/**
 * dynamics timeline을 생성한다.
 * - 인수 : context : score/index/parsed 문맥
 * - 반환값 : AnalyzedDynamicsSegment[] : dynamics segment 배열
 */
export const analyzeDynamicsTimeline: AnalyzeDynamicsTimelineFn = (
  context: AnalyzeContext,
): AnalyzedDynamicsSegment[] => {
  const columnCount = context.score.globalLines.columnCount;
  const dynamicsEntries = getValidGlobalEntries(context, "dynamics");
  const boundaryColumns = collectBoundaryColumns(columnCount, [
    dynamicsEntries,
  ]);
  const segments: AnalyzedDynamicsSegment[] = [];

  // dynamics 전역 셀 경계를 순회하며 상수 또는 선형 volume segment를 만든다.
  for (let index = 0; index < boundaryColumns.length - 1; index += 1) {
    const startCol = boundaryColumns[index];
    const endCol = boundaryColumns[index + 1];

    if (endCol <= startCol) {
      continue;
    }

    const dynamicsRange = resolveLinearGlobalRange(
      dynamicsEntries,
      startCol,
      endCol,
      DEFAULT_DYNAMICS,
    );

    segments.push({
      time: createColumnTimeRange(startCol, endCol),
      startValue: dynamicsRange.startValue,
      endValue: dynamicsRange.endValue,
      curve: dynamicsRange.curve,
      sourceCells: dynamicsRange.sourceCells,
    });
  }

  return segments;
};
