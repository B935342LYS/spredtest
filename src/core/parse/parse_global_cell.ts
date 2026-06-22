/**
 * src/core/parse/parse_global_cell.ts
 * 전역 행 셀의 rawText를 ParsedGlobalCell 구조로 변환한다.
 * 이 파일은 전역 셀 하나의 숫자 형식, 선형 변화 토큰, kind별 값 범위만 판정한다.
 */

import type { GlobalKind, RowDefinition } from "../score/types";
import type {
  GlobalCellParserContext,
  GlobalCellParserInput,
  GlobalParseError,
  GlobalParseErrorCode,
  ParsedGlobalCell,
  ParsedGlobalRamp,
} from "./types";

const MAX_BPM = 999;
const MAX_BEATS_PER_BAR = 999;
const MAX_STEPS_PER_BEAT = 999;
const MAX_DYNAMICS = 150;

/**
 * 전역 셀 하나의 rawText를 ParsedGlobalCell로 파싱한다.
 * - 인수 : input : 전역 셀 좌표와 원본 문자열
 * - 인수 : context : rowId에서 전역 행 kind를 유도하기 위한 parser 문맥
 * - 반환값 : ParsedGlobalCell : 전역 셀 파싱 성공 또는 실패 결과
 */
export function parseGlobalCell(
  input: GlobalCellParserInput,
  context: GlobalCellParserContext,
): ParsedGlobalCell {
  // 전역 셀의 kind는 셀 자체가 아니라 rowId가 가리키는 layout 행에서 유도한다.
  const row = context.rowById.get(input.rowId);

  // validator 이후 경로라도 parser 단독 호출 가능성을 고려해 global row 여부를 확인한다.
  if (!isGlobalRow(row)) {
    return invalidGlobalCell(
      input.rawText,
      "more_than_expected",
      null,
      "Global cell rowId must refer to a global row.",
    );
  }

  // 빈 전역 셀은 숫자 기준값을 만들 수 없으므로 parser 단계에서 invalid로 확정한다.
  if (input.rawText.length === 0) {
    return invalidGlobalCell(
      input.rawText,
      "empty_global",
      0,
      "Global cell text must not be empty.",
    );
  }

  // bpm/dynamics는 ramp token을 허용하므로 instant 계열과 다른 경로로 파싱한다.
  if (isLinearGlobalKind(row.kind)) {
    return parseLinearGlobalCell(input.rawText, row.kind);
  }

  return parseInstantGlobalCell(input.rawText, row.kind);
}

/**
 * bpm 또는 dynamics 전역 셀을 파싱한다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 인수 : globalKind : 선형 변화 토큰을 허용하는 전역 행 종류
 * - 반환값 : ParsedGlobalCell : 선형 전역 셀 파싱 성공 또는 실패 결과
 */
function parseLinearGlobalCell(
  rawText: string,
  globalKind: Extract<GlobalKind, "bpm" | "dynamics">,
): ParsedGlobalCell {
  // 선형 전역 셀은 숫자와 ramp token을 먼저 분리한 뒤 kind별 숫자 규칙을 적용한다.
  const rampParse = splitRampToken(rawText);

  // "<"처럼 ramp만 있고 숫자가 없는 입력은 유효한 전역값이 아니다.
  if (rampParse.numberText.length === 0) {
    return invalidGlobalCell(
      rawText,
      "invalid_number",
      0,
      "Global cell number text must not be empty.",
    );
  }

  // bpm은 실수를 허용하고, dynamics는 정수만 허용하므로 별도 함수로 분기한다.
  if (globalKind === "bpm") {
    return parseBpmCell(rawText, rampParse.numberText, rampParse.ramp);
  }

  return parseDynamicsCell(rawText, rampParse.numberText, rampParse.ramp);
}

/**
 * beatsPerBar 또는 stepsPerBeat 전역 셀을 파싱한다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 인수 : globalKind : 선형 변화 토큰을 허용하지 않는 전역 행 종류
 * - 반환값 : ParsedGlobalCell : 즉시 적용 전역 셀 파싱 성공 또는 실패 결과
 */
function parseInstantGlobalCell(
  rawText: string,
  globalKind: Extract<GlobalKind, "beatsPerBar" | "stepsPerBeat">,
): ParsedGlobalCell {
  // beatsPerBar/stepsPerBeat는 ramp token을 허용하지 않으므로 숫자 파싱 전에 차단한다.
  const rampErrorIndex = findTrailingRampTokenIndex(rawText);

  if (rampErrorIndex !== null) {
    return invalidGlobalCell(
      rawText,
      "invalid_ramp_token",
      rampErrorIndex,
      `${globalKind} does not allow ramp tokens.`,
    );
  }

  // 두 instant kind는 모두 양의 정수지만 오류 메시지와 globalKind가 다르므로 분리한다.
  if (globalKind === "beatsPerBar") {
    return parseBeatsPerBarCell(rawText);
  }

  return parseStepsPerBeatCell(rawText);
}

/**
 * bpm 전역 셀의 숫자와 ramp 값을 검증해 ParsedGlobalCell을 만든다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 인수 : numberText : ramp 토큰을 제거한 숫자 문자열
 * - 인수 : ramp : 파싱된 선형 변화 토큰
 * - 반환값 : ParsedGlobalCell : bpm 셀 파싱 성공 또는 실패 결과
 */
function parseBpmCell(
  rawText: string,
  numberText: string,
  ramp: ParsedGlobalRamp,
): ParsedGlobalCell {
  // bpm은 양의 십진수를 허용하므로 정수 parser가 아니라 decimal parser를 사용한다.
  const numberParse = parseFiniteDecimal(numberText);

  if (!numberParse.ok) {
    return invalidGlobalCell(
      rawText,
      "invalid_number",
      numberParse.charIndex,
      "BPM must be a positive number.",
    );
  }

  // 숫자 형식이 맞아도 parser 기준 범위를 벗어나면 timing 기준값으로 사용할 수 없다.
  if (numberParse.value <= 0 || numberParse.value > MAX_BPM) {
    return invalidGlobalCell(
      rawText,
      "invalid_bpm_range",
      0,
      `BPM must be greater than 0 and at most ${MAX_BPM}.`,
    );
  }

  return {
    kind: "linearGlobalValue",
    rawText,
    globalKind: "bpm",
    value: numberParse.value,
    ramp,
  };
}

/**
 * dynamics 전역 셀의 숫자와 ramp 값을 검증해 ParsedGlobalCell을 만든다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 인수 : numberText : ramp 토큰을 제거한 숫자 문자열
 * - 인수 : ramp : 파싱된 선형 변화 토큰
 * - 반환값 : ParsedGlobalCell : dynamics 셀 파싱 성공 또는 실패 결과
 */
function parseDynamicsCell(
  rawText: string,
  numberText: string,
  ramp: ParsedGlobalRamp,
): ParsedGlobalCell {
  // dynamics는 0~150 정수 범위만 허용하므로 non-negative integer로 먼저 읽는다.
  const integerParse = parseNonNegativeInteger(numberText);

  if (!integerParse.ok) {
    return invalidGlobalCell(
      rawText,
      "invalid_number",
      integerParse.charIndex,
      "Dynamics must be an integer.",
    );
  }

  // dynamics 상한 초과 값은 문법 문제가 아니라 dynamics 범위 문제로 구분한다.
  if (integerParse.value > MAX_DYNAMICS) {
    return invalidGlobalCell(
      rawText,
      "invalid_dynamics_range",
      0,
      `Dynamics must be between 0 and ${MAX_DYNAMICS}.`,
    );
  }

  return {
    kind: "linearGlobalValue",
    rawText,
    globalKind: "dynamics",
    value: integerParse.value,
    ramp,
  };
}

/**
 * beatsPerBar 전역 셀의 자연수 값을 검증해 ParsedGlobalCell을 만든다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 반환값 : ParsedGlobalCell : beatsPerBar 셀 파싱 성공 또는 실패 결과
 */
function parseBeatsPerBarCell(rawText: string): ParsedGlobalCell {
  // beatsPerBar는 박자 기준값이므로 1 이상의 정수만 허용한다.
  const integerParse = parsePositiveInteger(rawText);

  if (!integerParse.ok) {
    return invalidGlobalCell(
      rawText,
      "invalid_number",
      integerParse.charIndex,
      "beatsPerBar must be a positive integer.",
    );
  }

  if (integerParse.value > MAX_BEATS_PER_BAR) {
    return invalidGlobalCell(
      rawText,
      "invalid_beats_per_bar_range",
      0,
      `beatsPerBar must be between 1 and ${MAX_BEATS_PER_BAR}.`,
    );
  }

  return {
    kind: "instantGlobalValue",
    rawText,
    globalKind: "beatsPerBar",
    value: integerParse.value,
  };
}

/**
 * stepsPerBeat 전역 셀의 자연수 값을 검증해 ParsedGlobalCell을 만든다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 반환값 : ParsedGlobalCell : stepsPerBeat 셀 파싱 성공 또는 실패 결과
 */
function parseStepsPerBeatCell(rawText: string): ParsedGlobalCell {
  // stepsPerBeat도 subdivision 기준값이므로 1 이상의 정수만 허용한다.
  const integerParse = parsePositiveInteger(rawText);

  if (!integerParse.ok) {
    return invalidGlobalCell(
      rawText,
      "invalid_number",
      integerParse.charIndex,
      "stepsPerBeat must be a positive integer.",
    );
  }

  if (integerParse.value > MAX_STEPS_PER_BEAT) {
    return invalidGlobalCell(
      rawText,
      "invalid_steps_per_beat_range",
      0,
      `stepsPerBeat must be between 1 and ${MAX_STEPS_PER_BEAT}.`,
    );
  }

  return {
    kind: "instantGlobalValue",
    rawText,
    globalKind: "stepsPerBeat",
    value: integerParse.value,
  };
}

/**
 * 선형 변화 가능 전역 셀의 끝에서 ramp 토큰을 분리한다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 반환값 : { numberText: string; ramp: ParsedGlobalRamp } : 숫자 문자열과 ramp 해석 결과
 */
function splitRampToken(rawText: string): {
  numberText: string;
  ramp: ParsedGlobalRamp;
} {
  // "><"는 두 글자 토큰이므로 "<" 또는 ">"보다 먼저 판정한다.
  if (rawText.endsWith("><")) {
    return {
      numberText: rawText.slice(0, -2),
      ramp: "endStart",
    };
  }

  if (rawText.endsWith("<")) {
    return {
      numberText: rawText.slice(0, -1),
      ramp: "start",
    };
  }

  if (rawText.endsWith(">")) {
    return {
      numberText: rawText.slice(0, -1),
      ramp: "end",
    };
  }

  return {
    numberText: rawText,
    ramp: "none",
  };
}

/**
 * 선형 변화 불가 전역 셀 끝에 ramp 토큰이 있는지 확인한다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 반환값 : number | null : ramp 토큰 시작 위치 또는 없음
 */
function findTrailingRampTokenIndex(rawText: string): number | null {
  // "><"는 가장 긴 ramp token이므로 단일 문자 token보다 먼저 확인한다.
  if (rawText.endsWith("><")) {
    return rawText.length - 2;
  }

  if (rawText.endsWith("<") || rawText.endsWith(">")) {
    return rawText.length - 1;
  }

  return null;
}

/**
 * 양의 정수 문자열을 number로 파싱한다.
 * - 인수 : text : 숫자로 파싱할 문자열
 * - 반환값 : NumberParseResult : 양의 정수 파싱 성공 또는 실패 결과
 */
function parsePositiveInteger(text: string): NumberParseResult {
  // 숫자 형식 검증과 범위 검증을 분리해 invalid_number와 range 오류를 구분하기 쉽게 한다.
  const result = parseInteger(text);

  if (!result.ok) {
    return result;
  }

  // 양의 정수만 허용하므로 0은 실패로 처리한다.
  if (result.value < 1) {
    return {
      ok: false,
      charIndex: 0,
    };
  }

  return result;
}

/**
 * 0 이상의 정수 문자열을 number로 파싱한다.
 * - 인수 : text : 숫자로 파싱할 문자열
 * - 반환값 : NumberParseResult : 0 이상 정수 파싱 성공 또는 실패 결과
 */
function parseNonNegativeInteger(text: string): NumberParseResult {
  // 정수 형식 검증을 먼저 끝낸 뒤 0 이상 범위를 확인한다.
  const result = parseInteger(text);

  if (!result.ok) {
    return result;
  }

  if (result.value < 0) {
    return {
      ok: false,
      charIndex: 0,
    };
  }

  return result;
}

/**
 * 부호 없는 정수 문자열을 number로 파싱한다.
 * - 인수 : text : 숫자로 파싱할 문자열
 * - 반환값 : NumberParseResult : 정수 파싱 성공 또는 실패 결과
 */
function parseInteger(text: string): NumberParseResult {
  // parseInt는 "12abc"도 12로 읽을 수 있으므로 정규식으로 전체 문자열을 먼저 검사한다.
  const invalidIndex = findFirstRegexMismatch(text, /^[0-9]+$/);

  if (invalidIndex !== null) {
    return {
      ok: false,
      charIndex: invalidIndex,
    };
  }

  return {
    ok: true,
    value: Number.parseInt(text, 10),
  };
}

/**
 * 유한한 십진수 문자열을 number로 파싱한다.
 * - 인수 : text : 숫자로 파싱할 문자열
 * - 반환값 : NumberParseResult : 십진수 파싱 성공 또는 실패 결과
 */
function parseFiniteDecimal(text: string): NumberParseResult {
  // parseFloat도 부분 파싱을 허용하므로 전체 문자열이 십진수 형식인지 먼저 검사한다.
  const invalidIndex = findFirstRegexMismatch(text, /^[0-9]+(?:\.[0-9]+)?$/);

  if (invalidIndex !== null) {
    return {
      ok: false,
      charIndex: invalidIndex,
    };
  }

  // 정규식 통과 후에도 런타임 number 값이 유한한지 한 번 더 보장한다.
  const value = Number.parseFloat(text);

  if (!Number.isFinite(value)) {
    return {
      ok: false,
      charIndex: 0,
    };
  }

  return {
    ok: true,
    value,
  };
}

/**
 * 전체 문자열이 정규식과 일치하는지 확인하고, 실패 시 첫 의심 위치를 반환한다.
 * - 인수 : text : 검사할 문자열
 * - 인수 : pattern : 전체 문자열 검사용 정규식
 * - 반환값 : number | null : 불일치 추정 위치 또는 통과 결과
 */
function findFirstRegexMismatch(text: string, pattern: RegExp): number | null {
  // 빈 문자열은 숫자 자체가 없는 경우이므로 0번 위치 오류로 본다.
  if (text.length === 0) {
    return 0;
  }

  // 전체 패턴이 맞으면 불일치 위치가 없다.
  if (pattern.test(text)) {
    return null;
  }

  // 숫자와 소수점이 아닌 문자가 있으면 그 위치를 우선 보고한다.
  const invalidIndex = text.search(/[^0-9.]/);

  if (invalidIndex >= 0) {
    return invalidIndex;
  }

  // 문자 종류는 숫자/소수점뿐인데 패턴이 틀렸다면 구조 오류이므로 0번 위치로 둔다.
  return 0;
}

/**
 * RowDefinition이 global row인지 확인한다.
 * - 인수 : row : rowById에서 조회한 RowDefinition 후보
 * - 반환값 : row is Extract<RowDefinition, { type: "global" }> : global row 여부
 */
function isGlobalRow(
  row: RowDefinition | undefined,
): row is Extract<RowDefinition, { type: "global" }> {
  return row?.type === "global";
}

/**
 * 전역 행 종류가 선형 변화 토큰을 허용하는지 확인한다.
 * - 인수 : kind : 전역 행 종류
 * - 반환값 : kind is Extract<GlobalKind, "bpm" | "dynamics"> : 선형 변화 가능 여부
 */
function isLinearGlobalKind(
  kind: GlobalKind,
): kind is Extract<GlobalKind, "bpm" | "dynamics"> {
  return kind === "bpm" || kind === "dynamics";
}

/**
 * 전역 셀 parser 실패 결과를 생성한다.
 * - 인수 : rawText : 전역 셀 원본 문자열
 * - 인수 : code : 전역 셀 parser 오류 코드
 * - 인수 : charIndex : 오류 위치. 특정하기 어려우면 null
 * - 인수 : message : 사람이 읽는 보조 오류 메시지
 * - 반환값 : ParsedGlobalCell : invalid 전역 셀 결과
 */
function invalidGlobalCell(
  rawText: string,
  code: GlobalParseErrorCode,
  charIndex: number | null,
  message: string,
): ParsedGlobalCell {
  return {
    kind: "invalid",
    rawText,
    error: createGlobalParseError(code, charIndex, message),
  };
}

/**
 * 전역 셀 parser 오류 객체를 생성한다.
 * - 인수 : code : 전역 셀 parser 오류 코드
 * - 인수 : charIndex : 오류 위치. 특정하기 어려우면 null
 * - 인수 : message : 사람이 읽는 보조 오류 메시지
 * - 반환값 : GlobalParseError : 전역 셀 parser 오류 객체
 */
function createGlobalParseError(
  code: GlobalParseErrorCode,
  charIndex: number | null,
  message: string,
): GlobalParseError {
  return {
    code,
    charIndex,
    message,
  };
}

/**
 * 숫자 파싱 성공 또는 실패 결과.
 * - 정상 파싱 시 : number 값
 * - 비정상 파싱 시 : 오류 위치
 */
type NumberParseResult =
  | {
      ok: true;
      value: number;
    }
  | {
      ok: false;
      charIndex: number;
    };
