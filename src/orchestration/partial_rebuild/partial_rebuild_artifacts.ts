/**
 * score text edit에 필요한 partial runtime artifact를 생성한다.
 */

import { analyzeDynamicsTimeline } from "../../core/analyze/analyze_dynamics";
import { analyzeTimingTimeline } from "../../core/analyze/analyze_timing";
import { analyzeTrackEvents } from "../../core/analyze/analyze_track";
import type { AnalysisResult } from "../../core/analyze/types";
import {
  buildParsedGlobalCells,
  buildParsedTrackCells,
} from "../../core/parse/build_parsed_document";
import type { ParsedScoreDocument } from "../../core/parse/types";
import type { RuntimeDocument, TrackId } from "../../core/score/types";
import {
  buildCanvasGlobalMarkerItems,
  buildCanvasGlobalTextRenderItems,
  buildCanvasMuteRenderItems,
  buildCanvasNoteMarkerItems,
  buildCanvasNoteRenderItems,
} from "../../renderer/canvas_item_builder";
import type {
  CanvasAnalyzedRenderInput,
  CanvasMarkerItem,
  CanvasMuteRenderItem,
  CanvasNoteRenderItem,
  CanvasRenderInput,
} from "../../renderer/canvas_types";
import type { AppState } from "../../app/app_types";
import type { ScoreTextEdit } from "../../app/edit/edit_apply";
import { getScoreTextEditInvalidationKind } from "../../app/edit/edit_apply";
import { DEFAULT_ACTIVE_TRACK_IDS } from "../../track/track_control";

/** partial artifact builder 입력. */
export type BuildScoreTextEditPartialArtifactsInput = {
  state: AppState;
  nextDocument: RuntimeDocument;
  edits: readonly ScoreTextEdit[];
  renderBaseInput: CanvasRenderInput;
};

/** partial artifact builder 결과. */
export type ScoreTextEditPartialArtifacts = {
  parsed: ParsedScoreDocument;
  analysis: AnalysisResult;
  renderInput: CanvasAnalyzedRenderInput;
};

/**
 * score text edit 종류에 맞는 partial runtime artifact를 만든다.
 * - 인수 : input : edit 전 state, edit 후 document, edit batch, renderer base input
 * - 반환값 : partial artifact 또는 full rebuild fallback이 필요하면 null
 */
export function buildScoreTextEditPartialArtifacts(
  input: BuildScoreTextEditPartialArtifactsInput,
): ScoreTextEditPartialArtifacts | null {
  const invalidationKind = getScoreTextEditInvalidationKind(input.edits);

  if (invalidationKind === "globalCell") {
    return buildGlobalEditRuntimeArtifacts(input.state, input.nextDocument, input.renderBaseInput);
  }

  if (invalidationKind === "noteCell") {
    return buildNoteEditRuntimeArtifacts(
      input.state,
      input.nextDocument,
      input.edits,
      input.renderBaseInput,
    );
  }

  return null;
}

/**
 * note cell 편집에 필요한 track analyzer와 note-derived renderer group만 재생성한다.
 * - 인수 : state : 편집 전 앱 상태
 * - 인수 : nextDocument : note cell edit이 적용된 런타임 문서
 * - 인수 : edits : 적용한 score text edit batch
 * - 인수 : renderBaseInput : 다음 문서 기준 renderer base 입력
 * - 반환값 : edited track만 갱신한 산출물
 */
function buildNoteEditRuntimeArtifacts(
  state: AppState,
  nextDocument: RuntimeDocument,
  edits: readonly ScoreTextEdit[],
  renderBaseInput: CanvasRenderInput,
): ScoreTextEditPartialArtifacts | null {
  const editedTrackIds = collectEditedNoteTrackIds(edits);

  if (editedTrackIds.length === 0) {
    return null;
  }

  const editedTrackIdSet = new Set<TrackId>(editedTrackIds);
  const parsed = buildNoteEditParsedDocument(state.parsed, nextDocument, editedTrackIdSet);
  const context = {
    score: nextDocument.score,
    indexes: nextDocument.indexes,
    parsed,
  };
  const nextTrackResults = state.analysis.trackResults.map((trackResult) =>
    editedTrackIdSet.has(trackResult.trackId)
      ? analyzeTrackEvents(trackResult.trackId, context)
      : trackResult
  );
  const missingEditedTrackResults = editedTrackIds
    .filter((trackId) => !nextTrackResults.some((trackResult) => trackResult.trackId === trackId))
    .map((trackId) => analyzeTrackEvents(trackId, context));
  const analysis: AnalysisResult = {
    timingTimeline: state.analysis.timingTimeline,
    dynamicsTimeline: state.analysis.dynamicsTimeline,
    trackResults: [
      ...nextTrackResults,
      ...missingEditedTrackResults,
    ],
    analysisIssues: state.analysis.analysisIssues,
  };
  const editedAnalysis: AnalysisResult = {
    timingTimeline: analysis.timingTimeline,
    dynamicsTimeline: analysis.dynamicsTimeline,
    trackResults: analysis.trackResults.filter((trackResult) =>
      editedTrackIdSet.has(trackResult.trackId)
    ),
    analysisIssues: analysis.analysisIssues,
  };
  const editedNoteItems = buildCanvasNoteRenderItems(editedAnalysis, state.activeTrackIds);
  const editedMuteItems = buildCanvasMuteRenderItems(editedAnalysis, state.activeTrackIds);
  const editedNoteMarkerItems = buildCanvasNoteMarkerItems(editedAnalysis, state.activeTrackIds);
  const noteItems = replaceTrackScopedItems(
    state.renderInput.noteItems,
    editedNoteItems,
    editedTrackIdSet,
  );
  const muteItems = replaceTrackScopedItems(
    state.renderInput.muteItems,
    editedMuteItems,
    editedTrackIdSet,
  );
  const noteMarkerItems = replaceTrackScopedMarkers(
    state.renderInput.noteMarkerItems,
    editedNoteMarkerItems,
    editedTrackIdSet,
  );

  return {
    parsed,
    analysis,
    renderInput: {
      ...renderBaseInput,
      noteItems,
      muteItems,
      globalTextItems: state.renderInput.globalTextItems,
      globalMarkerItems: state.renderInput.globalMarkerItems,
      noteMarkerItems,
      markerItems: [
        ...state.renderInput.globalMarkerItems,
        ...noteMarkerItems,
      ],
    },
  };
}

/**
 * global cell 편집에 필요한 parser/analyzer/renderer 산출물만 재생성한다.
 * - 인수 : state : 편집 전 앱 상태
 * - 인수 : nextDocument : global cell edit이 적용된 런타임 문서
 * - 인수 : renderBaseInput : 다음 문서 기준 renderer base 입력
 * - 반환값 : global timeline과 global renderer group만 갱신한 산출물
 */
function buildGlobalEditRuntimeArtifacts(
  state: AppState,
  nextDocument: RuntimeDocument,
  renderBaseInput: CanvasRenderInput,
): ScoreTextEditPartialArtifacts {
  const parsed = buildGlobalEditParsedDocument(state.parsed, nextDocument);
  const context = {
    score: nextDocument.score,
    indexes: nextDocument.indexes,
    parsed,
  };
  const analysis: AnalysisResult = {
    timingTimeline: analyzeTimingTimeline(context),
    dynamicsTimeline: analyzeDynamicsTimeline(context),
    trackResults: state.analysis.trackResults,
    analysisIssues: state.analysis.analysisIssues,
  };
  const globalMarkerItems = buildCanvasGlobalMarkerItems(analysis);
  const globalTextItems = buildCanvasGlobalTextRenderItems(nextDocument.score);

  return {
    parsed,
    analysis,
    renderInput: {
      ...renderBaseInput,
      noteItems: state.renderInput.noteItems,
      muteItems: state.renderInput.muteItems,
      globalTextItems,
      globalMarkerItems,
      noteMarkerItems: state.renderInput.noteMarkerItems,
      markerItems: [
        ...globalMarkerItems,
        ...state.renderInput.noteMarkerItems,
      ],
    },
  };
}

/**
 * note edit에 필요한 parsed document를 edited track만 교체해 만든다.
 * - 인수 : previousParsed : 편집 전 parsed document
 * - 인수 : nextDocument : 편집 후 런타임 문서
 * - 인수 : editedTrackIds : 편집된 note track set
 * - 반환값 : edited track parser 결과만 갱신한 parsed document
 */
function buildNoteEditParsedDocument(
  previousParsed: ParsedScoreDocument,
  nextDocument: RuntimeDocument,
  editedTrackIds: ReadonlySet<TrackId>,
): ParsedScoreDocument {
  const noteCellsByTrackAndCol = new Map(previousParsed.noteCellsByTrackAndCol);

  // edited track만 next document의 cell 배열을 다시 파싱하고 나머지 track/global parser 결과는 재사용한다.
  for (const trackId of editedTrackIds) {
    const track = nextDocument.indexes.trackById.get(trackId);

    if (track === undefined) {
      noteCellsByTrackAndCol.delete(trackId);
      continue;
    }

    noteCellsByTrackAndCol.set(trackId, buildParsedTrackCells(track));
  }

  return {
    noteCellsByTrackAndCol,
    globalCellsByKindAndCol: previousParsed.globalCellsByKindAndCol,
  };
}

/**
 * global edit에 필요한 parsed document를 global parser 결과만 교체해 만든다.
 * - 인수 : previousParsed : 편집 전 parsed document
 * - 인수 : nextDocument : 편집 후 런타임 문서
 * - 반환값 : global parser 결과만 갱신한 parsed document
 */
function buildGlobalEditParsedDocument(
  previousParsed: ParsedScoreDocument,
  nextDocument: RuntimeDocument,
): ParsedScoreDocument {
  return {
    noteCellsByTrackAndCol: previousParsed.noteCellsByTrackAndCol,
    globalCellsByKindAndCol: buildParsedGlobalCells(nextDocument.score, nextDocument.indexes),
  };
}

/**
 * note edit batch에서 영향을 받은 trackId 목록을 안정 정렬해 수집한다.
 * - 인수 : edits : 적용한 score text edit batch
 * - 반환값 : TrackId[] : 편집된 note track 목록
 */
function collectEditedNoteTrackIds(edits: readonly ScoreTextEdit[]): TrackId[] {
  return Array.from(new Set(
    edits
      .filter((edit) => edit.selection.rowKind === "note")
      .map((edit) => edit.selection.trackId),
  )).sort((left, right) => getTrackOrder(left) - getTrackOrder(right));
}

/**
 * trackId를 가진 renderer item 배열에서 edited track 항목만 교체한다.
 * - 인수 : previousItems : 편집 전 item 배열
 * - 인수 : nextItems : edited track에서 새로 만든 item 배열
 * - 인수 : editedTrackIds : 교체 대상 trackId set
 * - 반환값 : edited track item만 교체한 배열
 */
function replaceTrackScopedItems<TItem extends CanvasNoteRenderItem | CanvasMuteRenderItem>(
  previousItems: readonly TItem[],
  nextItems: readonly TItem[],
  editedTrackIds: ReadonlySet<string>,
): TItem[] {
  return [
    ...previousItems.filter((item) =>
      item.trackId === undefined || !editedTrackIds.has(item.trackId)
    ),
    ...nextItems,
  ];
}

/**
 * note marker item 배열에서 edited track 항목만 교체한다.
 * - 인수 : previousItems : 편집 전 marker 배열
 * - 인수 : nextItems : edited track에서 새로 만든 marker 배열
 * - 인수 : editedTrackIds : 교체 대상 trackId set
 * - 반환값 : edited track marker만 교체한 배열
 */
function replaceTrackScopedMarkers(
  previousItems: readonly CanvasMarkerItem[],
  nextItems: readonly CanvasMarkerItem[],
  editedTrackIds: ReadonlySet<string>,
): CanvasMarkerItem[] {
  return [
    ...previousItems.filter((item) =>
      !("trackId" in item) || item.trackId === undefined || !editedTrackIds.has(item.trackId)
    ),
    ...nextItems,
  ];
}

/**
 * trackId의 기본 정렬 순서를 반환한다.
 * - 인수 : trackId : score track id
 * - 반환값 : 낮을수록 먼저 오는 정렬값
 */
function getTrackOrder(trackId: TrackId): number {
  const index = DEFAULT_ACTIVE_TRACK_IDS.indexOf(trackId);

  return index === -1 ? DEFAULT_ACTIVE_TRACK_IDS.length : index;
}
