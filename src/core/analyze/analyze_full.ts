/**
 * src/core/analyze/analyze_full.ts
 * 문서 전체 analyzer MVP 진입점을 제공한다.
 */

import { analyzeDynamicsTimeline } from "./analyze_dynamics";
import { analyzeTimingTimeline } from "./analyze_timing";
import { analyzeTrackEvents } from "./analyze_track";
import type {
  AnalyzeContext,
  AnalyzeDocumentFn,
  AnalysisResult,
} from "./types";

/**
 * ParsedScoreDocument와 ScoreIndexes를 바탕으로 문서 전체 AnalysisResult를 만든다.
 * - 인수 : context : score/index/parsed 문맥
 * - 반환값 : AnalysisResult : renderer/audio generator가 소비할 analyzer 결과
 */
export const analyzeDocument: AnalyzeDocumentFn = (
  context: AnalyzeContext,
): AnalysisResult => {
  // timing, dynamics, track 분석 결과와 issue 목록을 묶어서 AnalysisResult로 반환한다.
  return {
    timingTimeline: analyzeTimingTimeline(context),
    dynamicsTimeline: analyzeDynamicsTimeline(context),
    trackResults: context.score.tracks.map((track) =>
      analyzeTrackEvents(track.trackId, context),
    ),
    analysisIssues: [],
  };
};
