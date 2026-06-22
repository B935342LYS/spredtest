/**
 * src/core/analyze/analyze_timing.ts
 * 전역 timing 행을 BPM/박자/step 세그먼트 배열로 정규화한다.
 */

import {
  collectBoundaryColumns,
  createColumnTimeRange,
  getValidGlobalEntries,
  mergeSourceCells,
  resolveInstantGlobalValue,
  resolveLinearGlobalRange,
} from "./analyze_global_segments";
import type {
  AnalyzeContext,
  AnalyzedTimeSegment,
  AnalyzeTimingTimelineFn,
} from "./types";

const DEFAULT_BPM = 120;
const DEFAULT_BEATS_PER_BAR = 4;
const DEFAULT_STEPS_PER_BEAT = 4;

/**
 * timing timeline을 생성한다.
 * - 인수 : context : score/index/parsed 문맥
 * - 반환값 : AnalyzedTimeSegment[] : timing segment 배열
 */
export const analyzeTimingTimeline: AnalyzeTimingTimelineFn = (
  context: AnalyzeContext,
): AnalyzedTimeSegment[] => {
  const columnCount = context.score.globalLines.columnCount;
  const bpmEntries = getValidGlobalEntries(context, "bpm");
  const beatsPerBarEntries = getValidGlobalEntries(context, "beatsPerBar");
  const stepsPerBeatEntries = getValidGlobalEntries(context, "stepsPerBeat");
  const boundaryColumns = collectBoundaryColumns(columnCount, [
    bpmEntries,
    beatsPerBarEntries,
    stepsPerBeatEntries,
  ]);
  const segments: AnalyzedTimeSegment[] = [];

  // timing 관련 세 전역 stream의 경계 합집합을 순회하며 segment를 만든다.
  for (let index = 0; index < boundaryColumns.length - 1; index += 1) {
    const startCol = boundaryColumns[index];
    const endCol = boundaryColumns[index + 1];

    if (endCol <= startCol) {
      continue;
    }

    const bpmRange = resolveLinearGlobalRange(
      bpmEntries,
      startCol,
      endCol,
      DEFAULT_BPM,
    );
    const beatsPerBar = resolveInstantGlobalValue(
      beatsPerBarEntries,
      startCol,
      DEFAULT_BEATS_PER_BAR,
    );
    const stepsPerBeat = resolveInstantGlobalValue(
      stepsPerBeatEntries,
      startCol,
      DEFAULT_STEPS_PER_BEAT,
    );

    segments.push({
      time: createColumnTimeRange(startCol, endCol),
      startBpm: bpmRange.startValue,
      endBpm: bpmRange.endValue,
      bpmCurve: bpmRange.curve,
      beatsPerBar: beatsPerBar.value,
      stepsPerBeat: stepsPerBeat.value,
      sourceCells: mergeSourceCells([
        bpmRange.sourceCells,
        beatsPerBar.sourceCells,
        stepsPerBeat.sourceCells,
      ]),
    });
  }

  return segments;
};
