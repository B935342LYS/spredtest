/**
 * src/core/parse/types.ts
 * 셀 문자열 parser의 입력, 출력, 오류, 문서 단위 parsed 결과 타입을 정의한다.
 * parser는 rawText의 문법 해석까지만 담당하고, 셀 간 관계와 시간축 의미는 analyzer에 넘긴다.
 */

import type {
  GlobalKind,
  RuntimeDocument,
  RowDefinition,
  RowId,
  TrackId,
} from "../score/types";

/** 셀 단위 note parser 결과. */
export type ParsedCell =
  | ParsedMuteCell
  | ParsedNoteCell
  | ParsedPletHeadCell
  | ParsedPletExtendCell
  | ParsedInvalidCell;

/** note 영역 rawText의 1차 판별 결과. */
export type ParsedCellKind =
  | "mute"
  | "note"
  | "pletHead"
  | "pletExtend"
  | "invalid";

/** 모든 note parser 결과가 공유하는 최소 정보. */
export type ParsedCellBase = {
  kind: ParsedCellKind; // parser가 판별한 셀 종류
  rawText: string;      // 저장된 원본 문자열
};

/** 문법적으로 유효하지 않은 note 영역 셀. */
export type ParsedInvalidCell = ParsedCellBase & {
  kind: "invalid";
  error: ParseError;
};

/** note 영역 parser 오류 정보. */
export type ParseError = {
  code: ParseErrorCode;     // 오류 종류
  charIndex: number | null; // 오류 위치. 특정하기 어려우면 null
  message?: string;         // 디버깅과 UI 표시를 위한 보조 설명
};

/** note 영역 parser 오류 코드. */
export type ParseErrorCode =
  | "empty_note"
  | "invalid_escape"
  | "unexpected_reserved_char"
  | "unknown_modifier"
  | "modifier_order"
  | "duplicate_modifier"
  | "unterminated_paren"
  | "missing_argument"
  | "invalid_number"
  | "invalid_gliss_id"
  | "invalid_gliss_kind"
  | "invalid_trem_division"
  | "invalid_midi_range"
  | "invalid_cent_range"
  | "invalid_tuplet_division"
  | "tuplet_slot_count_mismatch"
  | "tuplet_nested_forbidden"
  | "tuplet_position_required"
  | "vib_and_trem"
  | "more_than_expected";

/** mute 셀. `//` 뒤의 내용은 표시 문자열로만 취급한다. */
export type ParsedMuteCell = ParsedCellBase & {
  kind: "mute";
  displayText: string;
};

/** 일반 note 셀. */
export type ParsedNoteCell = ParsedCellBase & {
  kind: "note";
  hold: HoldKind | null;       // 셀 앞의 "-" 또는 "~". 실제 연결은 analyzer가 판정한다.
  displayText: string;         // renderer가 기본 표시값으로 사용할 문자열
  modifiers: ParsedModifiers;  // 셀 단독으로 읽을 수 있는 modifier 묶음
};

/** hold 표식. "-"와 "~"는 연결 규칙은 같고 효과만 다르다. */
export type HoldKind = "-" | "~";

/** 일반 note 셀에 붙을 수 있는 modifier 묶음. */
export type ParsedModifiers = {
  gliss: ParsedGliss | null;
  trem: ParsedTrem | null;
  absolutePitch: ParsedAbsolutePitch | null;
  microPitch: ParsedMicroPitch | null;
};

/** tuplet head 셀. `/n(...)` 형태의 잇단음표 시작 셀이다. */
export type ParsedPletHeadCell = ParsedCellBase & {
  kind: "pletHead";
  divNum: number;          // tuplet 분할 수. slots.length와 일치해야 한다.
  slots: ParsedPletSlot[]; // 순서가 보존된 slot 목록
};

/** tuplet 내부 slot 하나의 parser 결과. */
export type ParsedPletSlot = {
  slotIndex: number;              // 0부터 시작하는 slot 순서
  isRest: boolean;                // 빈 slot이면 true
  note: ParsedPletSlotNote | null; // rest slot이면 null
};

/** tuplet 내부 note slot. */
export type ParsedPletSlotNote = {
  hold: HoldKind | null;
  displayText: string;
  modifiers: ParsedPletSlotModifiers;
  position: ParsedTupletPosition; // @n(midi_num). 실제 rowId 매핑은 analyzer가 담당한다.
};

/** tuplet 내부 note slot에 붙을 수 있는 modifier 묶음. */
export type ParsedPletSlotModifiers = {
  gliss: ParsedGliss | null;
  trem: ParsedTrem | null;
  absolutePitch: ParsedAbsolutePitch | null;
  microPitch: ParsedMicroPitch | null;
};

/** tuplet extend 셀. parser 단계에서는 `/&` 존재만 기록한다. */
export type ParsedPletExtendCell = ParsedCellBase & {
  kind: "pletExtend";
};

/** gliss modifier. 연결 상대 탐색은 analyzer가 수행한다. */
export type ParsedGliss = {
  id: string;
  glissKind: "S" | "M" | "E";
};

/** tremolo modifier. 허용 분할 수는 note parser 명세를 따른다. */
export type ParsedTrem = {
  divNum: 2 | 3 | 4;
};

/** 실제 발음 음정을 MIDI 번호로 직접 지정하는 modifier. */
export type ParsedAbsolutePitch = {
  midiNum: number;
};

/** cent 단위 미세 음정 보정 modifier. */
export type ParsedMicroPitch = {
  centNum: number; // -100~100, 소수점 이하 최대 1자리
};

/** tuplet slot의 표시 위치를 MIDI 번호로 지정하는 token. */
export type ParsedTupletPosition = {
  midiNum: number;
};

/** 셀 일부를 파싱하는 하위 parser의 공통 반환 형태. */
export type ParsePartResult<T> =
  | {
      ok: true;
      value: T;
      nextIndex: number;
    }
  | {
      ok: false;
      error: ParseError;
    };

/** 전역 셀 parser 결과. */
export type ParsedGlobalCell =
  | ParsedLinearGlobalCell
  | ParsedInstantGlobalCell
  | ParsedGlobalInvalidCell;

/** 전역 셀의 1차 판별 결과. */
export type ParsedGlobalCellKind =
  | "linearGlobalValue"
  | "instantGlobalValue"
  | "invalid";

/** 모든 전역 셀 parser 결과가 공유하는 최소 정보. */
export type ParsedGlobalCellBase = {
  kind: ParsedGlobalCellKind;
  rawText: string;
};

/** 문법적으로 유효하지 않은 전역 셀. */
export type ParsedGlobalInvalidCell = ParsedGlobalCellBase & {
  kind: "invalid";
  error: GlobalParseError;
};

/** 전역 셀 parser 오류 정보. */
export type GlobalParseError = {
  code: GlobalParseErrorCode;
  charIndex: number | null;
  message?: string;
};

/** 전역 셀 parser 오류 코드. */
export type GlobalParseErrorCode =
  | "empty_global"
  | "invalid_number"
  | "invalid_ramp_token"
  | "more_than_expected"
  | "invalid_bpm_range"
  | "invalid_beats_per_bar_range"
  | "invalid_steps_per_beat_range"
  | "invalid_dynamics_range";

/** 선형 변화 토큰을 허용하는 전역 셀. 현재 bpm과 dynamics에 사용한다. */
export type ParsedLinearGlobalCell = ParsedGlobalCellBase & {
  kind: "linearGlobalValue";
  globalKind: Extract<GlobalKind, "bpm" | "dynamics">;
  value: number;
  ramp: ParsedGlobalRamp;
};

/** 선형 변화 없이 즉시 적용되는 전역 셀. 현재 beatsPerBar와 stepsPerBeat에 사용한다. */
export type ParsedInstantGlobalCell = ParsedGlobalCellBase & {
  kind: "instantGlobalValue";
  globalKind: Extract<GlobalKind, "beatsPerBar" | "stepsPerBeat">;
  value: number;
};

/** 전역 셀 문자열 끝의 선형 변화 토큰. */
export type ParsedGlobalRamp =
  | "none"     // 토큰 없음
  | "start"    // "<"
  | "end"      // ">"
  | "endStart"; // "><"

/** 단일 note 셀 parser 입력. */
export type NoteCellParserInput = {
  trackId: TrackId;
  rowId: RowId;
  col: number;
  rawText: string;
};

/** 단일 전역 셀 parser 입력. */
export type GlobalCellParserInput = {
  rowId: RowId;
  col: number;
  rawText: string;
};

/** 전역 셀 parser가 rowId에서 GlobalKind를 유도하기 위한 문맥. */
export type GlobalCellParserContext = {
  rowById: Map<RowId, RowDefinition>;
};

/** 문서 단위 parser 결과. analyzer가 소비하는 공식 parsed 문서 구조이다. */
export type ParsedScoreDocument = {
  noteCellsByTrackAndCol: Map<TrackId, Map<number, ParsedCellEntry[]>>;
  globalCellsByKindAndCol: Map<GlobalKind, Map<number, ParsedGlobalCellEntry>>;
};

/** 문서 안의 위치 정보가 붙은 note parser 결과. */
export type ParsedCellEntry = {
  trackId: TrackId;
  rowId: RowId;
  col: number;
  parsedCell: ParsedCell;
};

/** 문서 안의 위치 정보가 붙은 전역 셀 parser 결과. */
export type ParsedGlobalCellEntry = {
  rowId: RowId;
  kind: GlobalKind;
  col: number;
  parsedCell: ParsedGlobalCell;
};

/** parser 부분 갱신 범위. */
export type ParseRangeRequest =
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

/** 단일 note 셀 parser 함수 타입. */
export type ParseNoteCellFn = (input: NoteCellParserInput) => ParsedCell;

/** 단일 전역 셀 parser 함수 타입. */
export type ParseGlobalCellFn = (
  input: GlobalCellParserInput,
  context: GlobalCellParserContext,
) => ParsedGlobalCell;

/** 문서 전체를 파싱하는 full rebuild 함수 타입. */
export type ParseDocumentFn = (
  document: RuntimeDocument,
) => ParsedScoreDocument;

/** 문서 일부를 다시 파싱하는 partial rebuild 함수 타입. */
export type ParseDocumentRangeFn = (
  prev: ParsedScoreDocument,
  document: RuntimeDocument,
  request: ParseRangeRequest,
) => ParsedScoreDocument;

/** note 셀 parser 캐시 키. */
export type ParsedCellCacheKey = `${TrackId}|${RowId}|${number}`;

/** 전역 셀 parser 캐시 키. */
export type ParsedGlobalCellCacheKey = `${RowId}|${number}`;
