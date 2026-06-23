/**
 * src/core/analyze/types.ts
 * analyzer의 입력, 출력, 이벤트, 전역 타임라인, 진단, 캐시 타입을 정의한다.
 * analyzer는 parser 결과와 ScoreIndexes를 받아 renderer/audio generator가 소비할 의미 이벤트를 만든다.
 */

import type { GlobalKind, RowId, ScoreFile, ScoreIndexes, TrackId } from "../score/types";
import type { ParsedCell, ParsedGlobalCell, ParsedScoreDocument } from "../parse/types";

/** analyzer 전체 실행에 필요한 문맥. */
export type AnalyzeContext = {
  score: ScoreFile;
  indexes: ScoreIndexes;
  parsed: ParsedScoreDocument;
};

/** analyzer 최종 출력. renderer와 audio generator가 공통으로 소비하는 공식 결과이다. */
export type AnalysisResult = {
  timingTimeline: AnalyzedTimeSegment[];
  dynamicsTimeline: AnalyzedDynamicsSegment[];
  trackResults: AnalyzedTrackResult[];
  analysisIssues: AnalyzedIssue[];
};

/** 한 track 내부의 analyzer 이벤트 목록. */
export type AnalyzedTrackResult = {
  trackId: TrackId;
  events: AnalyzedEvent[];
};

/** analyzer가 생성할 수 있는 이벤트 전체. */
export type AnalyzedEvent =
  | NoteEvent
  | RestEvent
  | MuteEvent
  | GlissEvent
  | TupletGroupEvent
  | TupletExtendGroupEvent;

/** analyzer 이벤트 종류. */
export type AnalyzedEventKind =
  | "note"
  | "rest"
  | "mute"
  | "gliss"
  | "tupletGroup"
  | "tupletExtendGroup";

/** 모든 analyzer 이벤트가 공유하는 필드. */
export type AnalyzedEventBase = {
  eventKind: AnalyzedEventKind;
  eventId: string;
  trackId: TrackId;
  time: TimeRange;
  sourceCells: SourceCellRef[];
};

/** 원본 셀 또는 tuplet slot을 가리키는 참조. */
export type SourceCellRef = {
  rowId: RowId;
  col: number;
  slotIndex?: number; // tuplet slot을 가리킬 때만 사용한다.
};

/** tick을 유리수로 표현한다. 일반 셀은 보통 denominator가 1이다. */
export type TimeFraction = {
  numerator: number;
  denominator: number;
};

/** analyzer 이벤트의 시간 범위. endTick은 배타적 끝점으로 취급한다. */
export type TimeRange = {
  startTick: TimeFraction;
  endTick: TimeFraction;
};

/** renderer가 음표를 배치할 의미적 위치. 실제 픽셀 좌표는 renderer가 계산한다. */
export type FinalDisplayPosition = {
  rowId: RowId;
  centOffset: number;
};

/** audio generator가 실제 발음 주파수를 계산할 때 쓰는 최종 음정. */
export type FinalSoundPitch = {
  midi: number;
  centOffset: number;
};

/** 실제 발음 구간을 나타내는 이벤트. hold로 연결된 여러 셀/slot이 하나로 병합될 수 있다. */
export type NoteEvent = AnalyzedEventBase & {
  eventKind: "note";
  text: string;
  displayTextAnchors: NoteDisplayTextAnchor[];
  display: FinalDisplayPosition;
  sound: FinalSoundPitch;
  effects: NoteEffectSegment[];
  glissRole?: GlissAnchorRole | null;
  glissAnchors: NoteGlissAnchor[];
  tuplet?: TupletMembership | null;
};

/**
 * NoteEvent 내부에서 원본 셀 또는 슬롯별로 표시할 텍스트와 시간 위치.
 * - 인수 : 없음
 * - 반환값 : renderer가 시간 범위 중심에 배치할 표시 텍스트 anchor
 */
export type NoteDisplayTextAnchor = {
  source: SourceCellRef;
  time: TimeRange;
  text: string;
};

/** note 내부의 시간 구간별 발음 효과. */
export type NoteEffectSegment = {
  time: TimeRange;
  vib: boolean;
  trem?: TremInfo | null;
};

/** tremolo 효과 정보. */
export type TremInfo = {
  division: number;
};

/** NoteEvent가 gliss anchor로 쓰이는 경우의 역할. */
export type GlissAnchorRole = {
  glissId: string;
  role: "start" | "mid" | "end";
};

/** NoteEvent 내부에서 원본 셀 단위 gliss anchor를 추적하는 정보. */
export type NoteGlissAnchor = GlissAnchorRole & {
  source: SourceCellRef;
  time: TimeRange;
  display: FinalDisplayPosition;
};

/** note/rest 이벤트가 tuplet group 안의 slot에서 온 경우의 소속 정보. */
export type TupletMembership = {
  groupId: string;
  slotIndex: number;
  divNum: number;
};

/** 시간축상 자리를 차지하지만 발음되지 않는 구간. 주로 tuplet rest slot에 사용한다. */
export type RestEvent = AnalyzedEventBase & {
  eventKind: "rest";
  display?: FinalDisplayPosition | null;
  tuplet?: TupletMembership | null;
};

/** 표시 텍스트는 있지만 발음 이벤트가 아닌 mute 셀 이벤트. */
export type MuteEvent = AnalyzedEventBase & {
  eventKind: "mute";
  display: FinalDisplayPosition;
  text: string;
};

/** 두 gliss anchor 사이의 연속 음정 이동 관계. 자체 발음원은 만들지 않는다. */
export type GlissEvent = AnalyzedEventBase & {
  eventKind: "gliss";
  startDisplay: FinalDisplayPosition;
  endDisplay: FinalDisplayPosition;
  startSound: FinalSoundPitch;
  endSound: FinalSoundPitch;
  glissId: string;
  startAnchorTick: TimeFraction;
  endAnchorTick: TimeFraction;
  fromKind: "start" | "mid";
  toKind: "mid" | "end";
  startAttach: "attack" | "legato";
  endAttach: "release" | "holdContinue";
};

/** tuplet 전체 구조를 나타내는 그룹 이벤트. 실제 발음은 slot note/rest 이벤트가 담당한다. */
export type TupletGroupEvent = AnalyzedEventBase & {
  eventKind: "tupletGroup";
  groupId: string;
  divNum: number;
  headCell: SourceCellRef;
  containerRowId: RowId;
  extendCells: SourceCellRef[];
  slots: TupletSlotInfo[];
};

/** head가 없는 pletExtend 연속 구간. 편집 시 삭제 대상 범위를 표시하는 보조 이벤트이다. */
export type TupletExtendGroupEvent = AnalyzedEventBase & {
  eventKind: "tupletExtendGroup";
  groupId: string;
  rowId: RowId;
  extendCells: SourceCellRef[];
};

/** tuplet group 내부 slot의 분석 상태. */
export type TupletSlotInfo = {
  slotIndex: number;
  parsedKind: "note" | "rest" | "invalid";
};

/** BPM/박자/step 전역 상태가 유지되는 시간 세그먼트. */
export type AnalyzedTimeSegment = {
  time: TimeRange;
  startBpm: number;
  endBpm: number;
  bpmCurve: SegmentCurve;
  beatsPerBar: number;
  stepsPerBeat: number;
  sourceCells: SourceCellRef[];
};

/** dynamics 전역 상태가 유지되는 시간 세그먼트. */
export type AnalyzedDynamicsSegment = {
  time: TimeRange;
  startValue: number;
  endValue: number;
  curve: SegmentCurve;
  sourceCells: SourceCellRef[];
};

/** 전역 세그먼트 값 변화 방식. */
export type SegmentCurve = "instant" | "linear";

/** analyzer 단계에서 발견한 문맥 의존 진단. */
export type AnalyzedIssue = {
  level: "warning" | "error";
  code: AnalyzedIssueCode;
  message: string;
  trackId?: TrackId | null;
  sourceCells: SourceCellRef[];
};

/** analyzer 진단 코드. */
export type AnalyzedIssueCode =
  | "tuplet_slot_row_not_found"
  | "tuplet_slot_invalid_pitch"
  | "global_event_conflict"
  | "timing_segment_invalid"
  | "dynamics_segment_invalid";

/** analyzer가 소비하는 note 셀 입력 단위. */
export type AnalyzerNoteCellInput = {
  trackId: TrackId;
  rowId: RowId;
  col: number;
  parsedCell: ParsedCell;
};

/** analyzer가 소비하는 전역 셀 입력 단위. */
export type AnalyzerGlobalCellInput = {
  rowId: RowId;
  kind: GlobalKind;
  col: number;
  parsedCell: ParsedGlobalCell;
};

/** analyzer 부분 갱신 요청. analyzer 내부에서 실제 범위를 더 확장할 수 있다. */
export type AnalyzePartialRequest =
  | {
      scope: "track";
      trackId: TrackId;
      colStart: number;
      colEnd: number;
    }
  | {
      scope: "global";
      kind: GlobalKind;
      colStart: number;
      colEnd: number;
    };

/** 전역 timeline 분석 범위. */
export type AnalyzeGlobalRange = {
  kinds: GlobalKind[];
  colStart: number;
  colEnd: number;
};

/** track 이벤트 분석 범위. */
export type AnalyzeTrackRange = {
  colStart: number;
  colEnd: number;
};

/** 전체 문서 분석 함수 타입. */
export type AnalyzeDocumentFn = (context: AnalyzeContext) => AnalysisResult;

/** 부분 문서 분석 함수 타입. */
export type AnalyzeDocumentPartialFn = (
  prev: AnalysisResult,
  context: AnalyzeContext,
  request: AnalyzePartialRequest,
) => AnalysisResult;

/** timing timeline 분석 함수 타입. */
export type AnalyzeTimingTimelineFn = (
  context: AnalyzeContext,
  range?: AnalyzeGlobalRange,
) => AnalyzedTimeSegment[];

/** dynamics timeline 분석 함수 타입. */
export type AnalyzeDynamicsTimelineFn = (
  context: AnalyzeContext,
  range?: AnalyzeGlobalRange,
) => AnalyzedDynamicsSegment[];

/** 한 track의 이벤트 분석 함수 타입. */
export type AnalyzeTrackEventsFn = (
  trackId: TrackId,
  context: AnalyzeContext,
  range?: AnalyzeTrackRange,
) => AnalyzedTrackResult;

/** AnalysisResult에서 재생성 가능한 조회 최적화 캐시. 저장 구조가 아니다. */
export type AnalysisCache = {
  eventsByStartCol: Map<TrackId, Map<number, AnalyzedEvent[]>>;
  trackResultByTrackId: Map<TrackId, AnalyzedTrackResult>;
  tupletGroupById: Map<string, TupletGroupEvent>;
  glissEventsById: Map<string, GlissEvent[]>;
};
