/**
 * AppState 전후 상태와 edit batch에서 partial rebuild plan을 만든다.
 */

import type { AppState } from "../../app/app_types";
import type { ScoreTextEdit } from "../../app/edit/edit_apply";
import { getScoreTextEditInvalidationKind } from "../../app/edit/edit_apply";
import { diffAnalyzedEventsById } from "../../core/analyze/event_diff";
import type { AnalysisResult, AnalyzedEvent } from "../../core/analyze/types";
import { createPartialRebuildPlan } from "./partial_rebuild_plan";
import type { PartialRebuildPlan } from "./partial_rebuild_types";

/** score text edit 전후 partial rebuild plan 생성 입력. */
export type CreateScoreTextEditPartialPlanInput = {
  previousState: AppState;
  nextState: AppState;
  edits: ScoreTextEdit[];
};

/**
 * score text edit 전후 AppState에서 partial rebuild plan을 만든다.
 * - 인수 : input : edit 전후 AppState와 적용한 edit batch
 * - 반환값 : 성공 edit이면 PartialRebuildPlan, 실패나 no-op이면 null
 */
export function createScoreTextEditPartialPlan(
  input: CreateScoreTextEditPartialPlanInput,
): PartialRebuildPlan | null {
  if (input.previousState.document === input.nextState.document) {
    return null;
  }

  const eventDiff = diffAnalyzedEventsById(
    collectAnalyzedEvents(input.previousState.analysis),
    collectAnalyzedEvents(input.nextState.analysis),
  );

  return createPartialRebuildPlan({
    editKind: getScoreTextEditInvalidationKind(input.edits),
    eventDiff,
  });
}

/**
 * score text edit batch의 renderer redraw scope fallback을 계산한다.
 * - 인수 : edits : 적용한 score text edit batch
 * - 반환값 : note/global/all redraw scope
 */
export function getScoreTextEditRedrawScope(edits: ScoreTextEdit[]): "note" | "global" | "all" {
  const invalidationKind = getScoreTextEditInvalidationKind(edits);

  if (invalidationKind === "noteCell") {
    return "note";
  }

  if (invalidationKind === "globalCell") {
    return "global";
  }

  return "all";
}

/**
 * AnalysisResult 내부 track event를 하나의 목록으로 펼친다.
 * - 인수 : analysis : analyzer 결과
 * - 반환값 : AnalyzedEvent[] : eventId diff용 이벤트 목록
 */
function collectAnalyzedEvents(analysis: AnalysisResult): AnalyzedEvent[] {
  return analysis.trackResults.flatMap((trackResult) => trackResult.events);
}
