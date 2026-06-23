/**
 * RuntimeDocument에서 app 상태와 renderer 입력을 재생성하는 경계를 담당한다.
 */

import { analyzeDocument } from "../core/analyze/analyze_full";
import type { AnalysisResult } from "../core/analyze/types";
import { buildParsedDocument } from "../core/parse/build_parsed_document";
import type { ParsedScoreDocument } from "../core/parse/types";
import {
  createRuntimeDocument,
  loadRuntimeDocument,
} from "../core/score/create_runtime_document";
import type {
  GlobalKind,
  MusicData,
  RuntimeDocument,
  ScoreFile,
  TrackId,
} from "../core/score/types";
import {
  buildCanvasGlobalTextRenderItems,
  buildCanvasGlobalMarkerItems,
  buildCanvasMarkerItems,
  buildCanvasMuteRenderItems,
  buildCanvasNoteMarkerItems,
  buildCanvasNoteRenderItems,
} from "../renderer/canvas_item_builder";
import type { CanvasAnalyzedRenderInput } from "../renderer/canvas_types";
import type { CanvasRenderInput } from "../renderer/canvas_types";
import { buildScoreTextEditPartialArtifacts } from "../orchestration/partial_rebuild/partial_rebuild_artifacts";
import { createCanvasRenderInput } from "./canvas_renderer_adapter";
import {
  applyNoteCellRawText,
  applyScoreCellRawTextBatch,
} from "./edit/edit_apply";
import type { ScoreTextEdit } from "./edit/edit_apply";
import type {
  AppState,
  LoopState,
  ScoreOrigin,
  ScoreSelection,
} from "./app_types";
import { applyLayoutDraftToScore } from "./layout/layout_apply";
import { createLayoutDraftBundle } from "./layout/layout_draft";
import type { LayoutDraftBundle } from "./layout/layout_types";
import { DEFAULT_ACTIVE_TRACK_IDS } from "../track/track_control";
import { touchScoreUpdatedAt } from "./score_timestamp";
import {
  MAX_SCORE_COLUMN_COUNT,
} from "../core/score/score_limits";

const CLEAR_ALL_COLUMN_COUNT = 1000;
const DEFAULT_GLOBAL_RAW_TEXT_BY_KIND: Record<GlobalKind, string> = {
  bpm: "120",
  beatsPerBar: "4",
  stepsPerBeat: "4",
  dynamics: "100",
};
const DEFAULT_LOOP_STATE: LoopState = {
  enabled: false,
  startTick: null,
  endTick: null,
  pickMode: null,
};

/**
 * 새 악보 또는 Clear All에서 사용할 musicData 기본값을 만든다.
 * - 인수 : timestamp : createdAt/updatedAt에 함께 사용할 ISO 시각 문자열
 * - 반환값 : 필수 musicData 필드를 모두 채운 기본 metadata
 */
function createDefaultMusicData(timestamp: string): MusicData {
  return {
    musicTitle: "Unknown",
    musicArtist: "Unknown",
    musicGenre: "Unknown",
    scoreWriter: "Anonymous",
    comment: "",
    scoreDifficulty: {
      basic: 0,
      optional: 0,
      extra: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    youtube: {
      videoId: "",
      offsetMs: 0,
    },
  };
}

/**
 * 현재 score의 표시 열 범위를 사용자 메시지로 만든다.
 * - 인수 : score : 현재 런타임 score JSON
 * - 반환값 : 0-based column 범위 메시지
 */
export function formatLoadedColumnStatus(score: ScoreFile): string {
  const lastCol = Math.max(0, score.globalLines.columnCount - 1);

  return `Loaded. cols 0-${lastCol}`;
}

/**
 * RuntimeDocument에서 parser/analyzer/renderer 입력을 재생성한다.
 * - 인수 : document : 인덱스가 생성된 런타임 문서
 * - 반환값 : 현재 score에서 파생된 분석 및 렌더 입력 묶음
 */
export function buildRuntimeArtifacts(
  document: RuntimeDocument,
  activeTrackIds: readonly TrackId[] = DEFAULT_ACTIVE_TRACK_IDS,
  reverseRows = false,
): {
  parsed: ParsedScoreDocument;
  analysis: AnalysisResult;
  renderInput: CanvasAnalyzedRenderInput;
} {
  // parser와 analyzer는 RuntimeDocument의 score/index를 기준으로 전체 산출물을 다시 만든다.
  const parsed = buildParsedDocument(document);
  const analysis = analyzeDocument({
    score: document.score,
    indexes: document.indexes,
    parsed,
  });
  return {
    parsed,
    analysis,
    // note layer는 analyzer 결과만 소비하도록 renderer 입력에 noteItems를 덧붙인다.
    renderInput: buildAnalyzedCanvasRenderInput(document, analysis, activeTrackIds, reverseRows),
  };
}

/**
 * 기존 analyzer 결과와 active track 상태에서 renderer 입력만 다시 만든다.
 * - 인수 : document : 현재 런타임 문서
 * - 인수 : analysis : 기존 analyzer 결과
 * - 인수 : activeTrackIds : renderer alpha에 반영할 active track 목록
 * - 반환값 : renderer가 소비할 분석 포함 canvas 입력
 */
export function buildAnalyzedCanvasRenderInput(
  document: RuntimeDocument,
  analysis: AnalysisResult,
  activeTrackIds: readonly TrackId[],
  reverseRows = false,
): CanvasAnalyzedRenderInput {
  const renderInput = applyReverseRowsOption(
    createCanvasRenderInput(document),
    reverseRows,
  );
  const globalMarkerItems = buildCanvasGlobalMarkerItems(analysis);
  const noteMarkerItems = buildCanvasNoteMarkerItems(analysis, activeTrackIds);

  return {
    ...renderInput,
    globalTextItems: buildCanvasGlobalTextRenderItems(document.score),
    noteItems: buildCanvasNoteRenderItems(analysis, activeTrackIds),
    muteItems: buildCanvasMuteRenderItems(analysis, activeTrackIds),
    globalMarkerItems,
    noteMarkerItems,
    markerItems: buildCanvasMarkerItems(analysis, activeTrackIds),
  };
}

/**
 * renderer source row에서 전역 행은 유지하고 나머지 score body 행만 뒤집는다.
 * - 인수 : input : score 저장 순서로 만든 renderer 입력
 * - 인수 : reverseRows : score body 행 순서를 뒤집을지 여부
 * - 반환값 : 표시용 행 순서가 반영된 renderer 입력
 */
export function applyReverseRowsOption(
  input: CanvasRenderInput,
  reverseRows: boolean,
): CanvasRenderInput {
  if (!reverseRows) {
    return input;
  }

  const globalRows = input.rows.filter((row) => row.kind === "global");
  const bodyRows = input.rows.filter((row) => row.kind !== "global").reverse();

  return {
    ...input,
    rows: [...globalRows, ...bodyRows],
  };
}

/**
 * RuntimeDocument를 AppState 초기값으로 변환한다.
 * - 인수 : document : 로드된 런타임 문서
 * - 인수 : scoreOrigin : 현재 score가 앱에 들어온 출처
 * - 반환값 : 첫 렌더에 필요한 앱 상태
 */
export function createInitialState(
  document: RuntimeDocument,
  scoreOrigin: ScoreOrigin = "loaded",
): AppState {
  const artifacts = buildRuntimeArtifacts(document);

  return {
    document,
    scoreOrigin,
    parsed: artifacts.parsed,
    analysis: artifacts.analysis,
    renderInput: artifacts.renderInput,
    activeTrackIds: [...DEFAULT_ACTIVE_TRACK_IDS],
    reverseRows: false,
    menuTheme: "light",
    speedScale: 1,
    textOff: false,
    loop: { ...DEFAULT_LOOP_STATE },
    mode: { kind: "view" },
    busy: { kind: "idle" },
    statusMessage: {
      level: "info",
      text: formatLoadedColumnStatus(document.score),
    },
    selection: null,
    layout: null,
    defaultLayoutDraft: createLayoutDraftBundle(document.score),
  };
}

/**
 * active track 목록만 바꾸고 parse/analyze 없이 renderer 입력을 갱신한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : activeTrackIds : 다음 active track 목록
 * - 반환값 : track layer 상태와 renderer 입력이 갱신된 앱 상태
 */
export function applyActiveTrackIdsToState(
  state: AppState,
  activeTrackIds: TrackId[],
): AppState {
  return {
    ...state,
    activeTrackIds: [...activeTrackIds],
    renderInput: buildAnalyzedCanvasRenderInput(
      state.document,
      state.analysis,
      activeTrackIds,
      state.reverseRows,
    ),
    statusMessage: {
      level: "info",
      text: activeTrackIds.length === 0
        ? "All tracks inactive."
        : `Active tracks: ${activeTrackIds.join(", ")}`,
    },
  };
}

/**
 * score body 행 표시 순서만 전환하고 parse/analyze 없이 renderer 입력을 갱신한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : reverseRows : score body 행을 뒤집을지 여부
 * - 반환값 : reverse 표시 옵션이 반영된 앱 상태
 */
export function applyReverseRowsToState(
  state: AppState,
  reverseRows: boolean,
): AppState {
  return {
    ...state,
    reverseRows,
    renderInput: buildAnalyzedCanvasRenderInput(
      state.document,
      state.analysis,
      state.activeTrackIds,
      reverseRows,
    ),
    statusMessage: {
      level: "info",
      text: reverseRows ? "Reverse row view enabled." : "Normal row view enabled.",
    },
  };
}

/**
 * 메뉴 영역 theme 상태를 앱 상태에 반영한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : menuTheme : 적용할 메뉴 theme
 * - 반환값 : theme 상태가 바뀐 앱 상태
 */
export function applyMenuThemeToState(
  state: AppState,
  menuTheme: AppState["menuTheme"],
): AppState {
  return {
    ...state,
    menuTheme,
    statusMessage: {
      level: "info",
      text: `Menu theme: ${menuTheme}`,
    },
  };
}

/**
 * score 오른쪽에 column을 추가하고 full rebuild 산출물을 만든다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : additionalColumns : 오른쪽에 추가할 column 수
 * - 반환값 : columnCount와 runtime artifact가 갱신된 앱 상태
 */
export function applyExpandColumnsToState(
  state: AppState,
  additionalColumns: number,
): AppState {
  if (!Number.isInteger(additionalColumns) || additionalColumns <= 0) {
    return {
      ...state,
      statusMessage: {
        level: "warning",
        text: "Expand columns requires a positive integer.",
      },
    };
  }

  const nextColumnCount = state.document.score.globalLines.columnCount + additionalColumns;

  if (nextColumnCount > MAX_SCORE_COLUMN_COUNT) {
    return {
      ...state,
      statusMessage: {
        level: "warning",
        text: `Score can have at most ${MAX_SCORE_COLUMN_COUNT} columns.`,
      },
    };
  }

  const nextScore: ScoreFile = {
    ...state.document.score,
    globalLines: {
      ...state.document.score.globalLines,
      columnCount: nextColumnCount,
    },
  };
  const nextDocument = createRuntimeDocument(nextScore);
  const artifacts = buildRuntimeArtifacts(
    nextDocument,
    state.activeTrackIds,
    state.reverseRows,
  );

  return {
    ...state,
    document: nextDocument,
    parsed: artifacts.parsed,
    analysis: artifacts.analysis,
    renderInput: artifacts.renderInput,
    loop: { ...DEFAULT_LOOP_STATE },
    statusMessage: {
      level: "info",
      text: `Expanded ${additionalColumns} columns. cols 0-${nextColumnCount - 1}`,
    },
  };
}

/**
 * score 오른쪽 끝 column을 제거하고 범위를 벗어난 cell을 삭제한 full rebuild 산출물을 만든다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : trimColumns : 오른쪽에서 제거할 column 수
 * - 반환값 : columnCount와 runtime artifact가 갱신된 앱 상태
 */
export function applyTrimRightColumnsToState(
  state: AppState,
  trimColumns: number,
): AppState {
  if (!Number.isInteger(trimColumns) || trimColumns <= 0) {
    return {
      ...state,
      statusMessage: {
        level: "warning",
        text: "Trim columns requires a positive integer.",
      },
    };
  }

  const currentColumnCount = state.document.score.globalLines.columnCount;
  const nextColumnCount = currentColumnCount - trimColumns;

  if (nextColumnCount < 1) {
    return {
      ...state,
      statusMessage: {
        level: "warning",
        text: "Trim Right must leave at least 1 column.",
      },
    };
  }

  const nextGlobalCells = state.document.score.globalLines.cells
    .filter((cell) => cell.col < nextColumnCount);
  const nextTracks = state.document.score.tracks.map((track) => ({
    ...track,
    cells: track.cells.filter((cell) => cell.col < nextColumnCount),
  }));
  const removedCellCount =
    state.document.score.globalLines.cells.length -
    nextGlobalCells.length +
    state.document.score.tracks.reduce((total, track, index) => (
      total + track.cells.length - (nextTracks[index]?.cells.length ?? 0)
    ), 0);
  const nextScore: ScoreFile = {
    ...state.document.score,
    globalLines: {
      columnCount: nextColumnCount,
      cells: nextGlobalCells,
    },
    tracks: nextTracks,
  };
  const nextDocument = createRuntimeDocument(nextScore);
  const artifacts = buildRuntimeArtifacts(
    nextDocument,
    state.activeTrackIds,
    state.reverseRows,
  );

  return {
    ...state,
    document: nextDocument,
    parsed: artifacts.parsed,
    analysis: artifacts.analysis,
    renderInput: artifacts.renderInput,
    selection: state.selection !== null && state.selection.col >= nextColumnCount
      ? null
      : state.selection,
    loop: { ...DEFAULT_LOOP_STATE },
    statusMessage: {
      level: "info",
      text: `Trimmed ${trimColumns} columns. Removed ${removedCellCount} cell(s). cols 0-${nextColumnCount - 1}`,
    },
  };
}

/**
 * 현재 layout/instData는 유지하고 악보 입력 내용과 metadata를 기본 1000열 score로 초기화한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : timestamp : musicData 생성/수정 시각에 사용할 ISO 시각 문자열
 * - 반환값 : 초기 global 0열과 빈 tracks가 반영된 앱 상태
 */
export function applyClearAllScoreToState(
  state: AppState,
  timestamp = new Date().toISOString(),
): AppState {
  const nextScore: ScoreFile = {
    ...state.document.score,
    musicData: createDefaultMusicData(timestamp),
    globalLines: {
      columnCount: CLEAR_ALL_COLUMN_COUNT,
      cells: state.document.score.layout.rowDefinitions
        .filter((row) => row.type === "global")
        .map((row) => ({
          rowId: row.rowId,
          col: 0,
          rawText: DEFAULT_GLOBAL_RAW_TEXT_BY_KIND[row.kind],
        })),
    },
    tracks: state.document.score.tracks.map((track) => ({
      ...track,
      cells: [],
    })),
  };
  const nextDocument = createRuntimeDocument(nextScore);
  const artifacts = buildRuntimeArtifacts(
    nextDocument,
    state.activeTrackIds,
    state.reverseRows,
  );

  return {
    ...state,
    document: nextDocument,
    parsed: artifacts.parsed,
    analysis: artifacts.analysis,
    renderInput: artifacts.renderInput,
    selection: null,
    loop: { ...DEFAULT_LOOP_STATE },
    statusMessage: {
      level: "info",
      text: `Cleared score. cols 0-${CLEAR_ALL_COLUMN_COUNT - 1}`,
    },
  };
}

/**
 * JSON 문자열을 RuntimeDocument로 로드한 뒤 AppState 초기값으로 변환한다.
 * - 인수 : jsonText : ScoreFile JSON 문자열
 * - 인수 : sourceLabel : 사용자 상태 메시지에 표시할 로드 출처
 * - 인수 : scoreOrigin : 현재 score가 앱에 들어온 출처
 * - 반환값 : 로드 성공 시 새 AppState, 실패 시 기존 상태에 표시할 오류 메시지
 */
export function loadScoreTextAsInitialState(
  jsonText: string,
  sourceLabel: string,
  scoreOrigin: ScoreOrigin = "loaded",
):
  | {
      ok: true;
      state: AppState;
    }
  | {
      ok: false;
      message: string;
    } {
  const loadResult = loadRuntimeDocument(jsonText);

  if (!loadResult.ok) {
    return {
      ok: false,
      message: loadResult.error.message,
    };
  }

  return {
    ok: true,
    state: {
      ...createInitialState(loadResult.document, scoreOrigin),
      statusMessage: {
        level: "info",
        text: `${sourceLabel} loaded.`,
      },
    },
  };
}

/**
 * ScoreFile의 musicData만 교체해 AppState에 반영한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : musicData : Details dialog에서 확정된 새 metadata
 * - 반환값 : metadata가 갱신된 앱 상태
 */
export function applyMusicDataEditToState(
  state: AppState,
  musicData: MusicData,
): AppState {
  const nextScore: ScoreFile = {
    ...state.document.score,
    musicData,
  };
  const nextDocument = createRuntimeDocument(nextScore);

  return {
    ...state,
    document: nextDocument,
    statusMessage: {
      level: "info",
      text: "Score details updated.",
    },
  };
}

/**
 * YouTube 패널에서 확정한 video id와 offset을 score metadata에 반영한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : videoId : 저장할 YouTube video id
 * - 인수 : offsetMs : 저장할 악보 기준 YouTube offset ms
 * - 반환값 : YouTube metadata와 updatedAt이 갱신된 앱 상태
 */
export function applyYoutubeSyncEditToState(
  state: AppState,
  videoId: string,
  offsetMs: number,
): AppState {
  const nextScore = touchScoreUpdatedAt({
    ...state.document.score,
    musicData: {
      ...state.document.score.musicData,
      youtube: {
        videoId,
        offsetMs,
      },
    },
  });
  const nextDocument = createRuntimeDocument(nextScore);

  return {
    ...state,
    document: nextDocument,
    statusMessage: {
      level: "info",
      text: "YouTube sync updated.",
    },
  };
}

/**
 * 레이아웃 draft를 ScoreFile에 적용하고 full rebuild 산출물을 만든다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : draft : Layout dialog에서 확정한 layout draft
 * - 인수 : allowCellDeletion : 삭제될 track cell이 있을 때 적용을 허용할지 여부
 * - 반환값 : full rebuild가 반영된 앱 상태
 */
export function applyLayoutDraftEditToState(
  state: AppState,
  draft: LayoutDraftBundle,
  allowCellDeletion: boolean,
): AppState {
  const applyResult = applyLayoutDraftToScore(state.document.score, draft, {
    allowCellDeletion,
  });

  if (!applyResult.ok) {
    return {
      ...state,
      statusMessage: {
        level: applyResult.level,
        text: applyResult.message,
      },
    };
  }

  const nextDocument = createRuntimeDocument(applyResult.score);
  const artifacts = buildRuntimeArtifacts(nextDocument, state.activeTrackIds, state.reverseRows);

  return {
    ...state,
    document: nextDocument,
    parsed: artifacts.parsed,
    analysis: artifacts.analysis,
    renderInput: artifacts.renderInput,
    selection: null,
    layout: null,
    loop: { ...DEFAULT_LOOP_STATE },
    statusMessage: {
      level: "info",
      text: applyResult.deletedCells.totalCount > 0
        ? `Layout applied. Deleted ${applyResult.deletedCells.totalCount} track cell(s).`
        : "Layout applied.",
    },
  };
}

/**
 * active track의 note cell에 rawText를 적용하고 full rebuild 산출물을 만든다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : editTarget : 이번 rawText 편집을 적용할 score 좌표와 track
 * - 인수 : rawText : parser가 읽을 note cell rawText
 * - 반환값 : full rebuild가 반영된 앱 상태
 */
export function applyRawTextToScore(
  state: AppState,
  editTarget: ScoreSelection,
  rawText: string,
): AppState {
  const applyResult = applyNoteCellRawText(
    state.document.score,
    editTarget,
    rawText,
  );

  if (!applyResult.ok) {
    return {
      ...state,
      selection: editTarget,
      statusMessage: {
        level: applyResult.level,
        text: applyResult.message,
      },
    };
  }

  const nextDocument = createRuntimeDocument(applyResult.score);
  const artifacts = buildRuntimeArtifacts(nextDocument, state.activeTrackIds, state.reverseRows);

  return {
    ...state,
    document: nextDocument,
    parsed: artifacts.parsed,
    analysis: artifacts.analysis,
    renderInput: artifacts.renderInput,
    selection: editTarget,
    statusMessage: {
      level: "info",
      text: applyResult.isDelete
        ? `Cleared ${editTarget.trackId} ${editTarget.rowId}:${editTarget.col}`
        : `Applied ${editTarget.trackId} ${editTarget.rowId}:${editTarget.col}`,
    },
  };
}

/**
 * 여러 score cell rawText 편집을 한 번의 full rebuild로 적용한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : edits : 적용할 score cell 편집 목록
 * - 반환값 : full rebuild가 반영된 앱 상태
 */
export function applyRawTextBatchToScore(
  state: AppState,
  edits: ScoreTextEdit[],
): AppState {
  if (edits.length === 0) {
    return state;
  }

  const applyResult = applyScoreCellRawTextBatch(state.document.score, edits);
  const lastSelection = edits[edits.length - 1]?.selection ?? state.selection;

  if (!applyResult.ok) {
    return {
      ...state,
      selection: lastSelection,
      statusMessage: {
        level: applyResult.level,
        text: applyResult.message,
      },
    };
  }

  const nextDocument = createRuntimeDocument(applyResult.score);
  const renderBaseInput = applyReverseRowsOption(
    createCanvasRenderInput(nextDocument),
    state.reverseRows,
  );
  const artifacts = buildScoreTextEditPartialArtifacts({
    state,
    nextDocument,
    edits,
    renderBaseInput,
  }) ?? buildRuntimeArtifacts(nextDocument, state.activeTrackIds, state.reverseRows);

  return {
    ...state,
    document: nextDocument,
    parsed: artifacts.parsed,
    analysis: artifacts.analysis,
    renderInput: artifacts.renderInput,
    selection: lastSelection,
    statusMessage: {
      level: "info",
      text: applyResult.isDelete
        ? `Cleared ${applyResult.updated} cells.`
        : `Applied ${applyResult.updated} cells.`,
    },
  };
}

/**
 * edit 적용 전후 busy/status 전환을 포함해 rawText full rebuild를 실행한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : editTarget : rawText 편집을 적용할 score 좌표와 track
 * - 인수 : rawText : parser가 읽을 note cell rawText
 * - 반환값 : 성공/실패 상태 메시지가 반영된 앱 상태
 */
export function applyRawTextEditToState(
  state: AppState,
  editTarget: ScoreSelection,
  rawText: string,
): AppState {
  const actionState: AppState = {
    ...state,
    busy: { kind: "idle" },
  };

  try {
    return {
      ...applyRawTextToScore(actionState, editTarget, rawText),
      busy: { kind: "idle" },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown edit error.";

    return {
      ...state,
      busy: { kind: "idle" },
      statusMessage: {
        level: "error",
        text: message,
      },
    };
  }
}

/**
 * edit 적용 전후 busy/status 전환을 포함해 여러 rawText 편집을 한 번에 적용한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : edits : 적용할 score cell 편집 목록
 * - 반환값 : 성공/실패 상태 메시지가 반영된 앱 상태
 */
export function applyRawTextBatchEditToState(
  state: AppState,
  edits: ScoreTextEdit[],
): AppState {
  const actionState: AppState = {
    ...state,
    busy: { kind: "idle" },
  };

  try {
    return {
      ...applyRawTextBatchToScore(actionState, edits),
      busy: { kind: "idle" },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown edit error.";

    return {
      ...state,
      busy: { kind: "idle" },
      statusMessage: {
        level: "error",
        text: message,
      },
    };
  }
}
