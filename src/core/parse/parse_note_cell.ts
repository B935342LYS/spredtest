/**
 * src/core/parse/parse_note_cell.ts
 * 노트 영역 셀의 rawText를 ParsedCell 구조로 변환한다.
 * 이 파일의 1단계 구현은 최상위 셀 종류 판별과 mute, pletExtend, 기본 note, modifier 파싱을 담당한다.
 */

import type {
  HoldKind,
  NoteCellParserInput,
  ParseError,
  ParseErrorCode,
  ParsePartResult,
  ParsedCell,
  ParsedAbsolutePitch,
  ParsedGliss,
  ParsedMicroPitch,
  ParsedModifiers,
  ParsedPletSlot,
  ParsedPletSlotNote,
  ParsedTrem,
  ParsedTupletPosition,
} from "./types";

const RESERVED_NOTE_CHARS = new Set(["/", "@", "|", "(", ")", "-", "~"]);
const ESCAPABLE_CHARS = new Set(["\\", "/", "@", "|", "(", ")", "-", "~"]);
const KNOWN_MODIFIER_TOKENS = ["@g(", "@t(", "@p(", "@m("] as const;
const TUPLET_POSITION_TOKEN = "@n(" as const;

// ============================================================
// Public entry
// ============================================================

/**
 * 노트 영역 셀 하나의 rawText를 ParsedCell로 파싱한다.
 * - 인수 : input : 트랙 셀 좌표와 원본 문자열
 * - 반환값 : ParsedCell : 노트 영역 셀 파싱 성공 또는 실패 결과
 */
export function parseNoteCell(input: NoteCellParserInput): ParsedCell {
  const { rawText } = input;

  // 빈 문자열은 저장하지 않는 것이 원칙이지만, 단독 parser 호출에 대비해 invalid로 처리한다.
  if (rawText.length === 0) {
    return invalidCell(rawText, "empty_note", 0, "Note cell text must not be empty.");
  }

  // mute 셀은 이후 토큰을 modifier로 재해석하지 않으므로 가장 먼저 분기한다.
  if (rawText.startsWith("//")) {
    return parseMuteText(rawText);
  }

  // tuplet extend는 정확히 "/&" 하나만 유효한 독립 셀 종류이다.
  if (rawText === "/&") {
    return parsePletExtend(rawText);
  }

  // tuplet head는 내부 slot까지 셀 단독 문법으로 구조화한 뒤 analyzer에 넘긴다.
  if (isPletHeadCandidate(rawText)) {
    return parsePletHead(rawText);
  }

  // 위 특수 셀에 해당하지 않으면 일반 note 셀 문법으로 해석한다.
  return parseNoteText(rawText);
}

// ============================================================
// Special top-level cell parsers
// ============================================================

/**
 * mute 셀 문자열을 표시용 텍스트로 변환한다.
 * - 인수 : rawText : `//`로 시작하는 mute 셀 원본 문자열
 * - 반환값 : ParsedCell : mute 셀 파싱 성공 또는 실패 결과
 */
function parseMuteText(rawText: string): ParsedCell {
  const content = rawText.slice(2);

  // mute 내부는 modifier를 읽지 않지만 escape 복원은 수행해 표시 문자열을 만든다.
  const unescapeResult = unescapeText(content, 2, false);

  if (!unescapeResult.ok) {
    return invalidCell(rawText, "invalid_escape", unescapeResult.charIndex, "Invalid escape sequence in mute cell.");
  }

  return {
    kind: "mute",
    rawText,
    displayText: unescapeResult.value,
  };
}

/**
 * tuplet extend 셀을 ParsedPletExtendCell로 변환한다.
 * - 인수 : rawText : `/&` 원본 문자열
 * - 반환값 : ParsedCell : tuplet extend 파싱 결과
 */
function parsePletExtend(rawText: string): ParsedCell {
  return {
    kind: "pletExtend",
    rawText,
  };
}

/**
 * tuplet head 셀을 ParsedPletHeadCell로 변환한다.
 * - 인수 : rawText : `/n(...)` 형태로 보이는 원본 문자열
 * - 반환값 : ParsedCell : tuplet head 파싱 성공 또는 실패 결과
 */
function parsePletHead(rawText: string): ParsedCell {
  const openIndex = rawText.indexOf("(");
  const divText = rawText.slice(1, openIndex);
  const divNum = Number.parseInt(divText, 10);

  // 분할 수는 셀 단독으로 확정 가능한 tuplet 구조 제약이다.
  if (!/^[0-9]+$/.test(divText) || divNum < 2) {
    return invalidCell(
      rawText,
      "invalid_tuplet_division",
      1,
      "Tuplet division must be an integer greater than or equal to 2.",
    );
  }

  const closeIndex = findMatchingParen(rawText, openIndex);

  if (closeIndex === -1) {
    return invalidCell(rawText, "unterminated_paren", openIndex, "Tuplet head parenthesis is not closed.");
  }

  if (closeIndex !== rawText.length - 1) {
    return invalidCell(rawText, "more_than_expected", closeIndex + 1, "Unexpected text after tuplet head.");
  }

  const bodyStartIndex = openIndex + 1;
  const body = rawText.slice(bodyStartIndex, closeIndex);
  const splitResult = splitTupletSlots(body, bodyStartIndex);

  if (!splitResult.ok) {
    return {
      kind: "invalid",
      rawText,
      error: splitResult.error,
    };
  }

  if (splitResult.value.slots.length !== divNum) {
    return invalidCell(
      rawText,
      "tuplet_slot_count_mismatch",
      bodyStartIndex,
      "Tuplet slot count must match the division number.",
    );
  }

  const slots: ParsedPletSlot[] = [];

  // slot은 순서를 보존해야 하므로 0-based index를 붙여 차례대로 파싱한다.
  for (let slotIndex = 0; slotIndex < splitResult.value.slots.length; slotIndex += 1) {
    const slotText = splitResult.value.slots[slotIndex] ?? "";
    const slotStartIndex = splitResult.value.startIndexes[slotIndex] ?? bodyStartIndex;
    const slotResult = parsePletSlot(slotText, slotIndex, slotStartIndex);

    if (!slotResult.ok) {
      return {
        kind: "invalid",
        rawText,
        error: slotResult.error,
      };
    }

    slots.push(slotResult.value);
  }

  return {
    kind: "pletHead",
    rawText,
    divNum,
    slots,
  };
}

// ============================================================
// Normal note parser
// ============================================================

/**
 * 일반 note 셀의 hold와 defaultText를 파싱한다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 반환값 : ParsedCell : 기본 note 셀 파싱 성공 또는 실패 결과
 */
function parseNoteText(rawText: string): ParsedCell {
  let index = 0;
  let hold: HoldKind | null = null;
  const firstChar = rawText[index];

  // 문자열 맨 앞의 "-" 또는 "~"만 hold 토큰으로 인정한다.
  if (isHoldKind(firstChar)) {
    hold = firstChar;
    index += 1;
  }

  // 이번 단계에서는 modifier 파싱 전까지의 defaultText와 예약문자 충돌만 처리한다.
  const defaultTextResult = scanDefaultText(rawText, index);

  if (!defaultTextResult.ok) {
    return {
      kind: "invalid",
      rawText,
      error: defaultTextResult.error,
    };
  }

  index = defaultTextResult.nextIndex;

  // defaultText 뒤에는 canonical order에 맞춰 modifier를 선택적으로 읽는다.
  const modifierResult = parseModifiers(rawText, index, hold);

  if (!modifierResult.ok) {
    return {
      kind: "invalid",
      rawText,
      error: modifierResult.error,
    };
  }

  // hold도 defaultText도 없으면 note 셀로서 해석할 내용이 없다.
  if (
    hold === null &&
    defaultTextResult.value.length === 0 &&
    !hasAnyModifier(modifierResult.value)
  ) {
    return invalidCell(rawText, "empty_note", 0, "Note cell text must not be empty.");
  }

  return {
    kind: "note",
    rawText,
    hold,
    displayText: decideDisplayText(defaultTextResult.value, hold),
    modifiers: modifierResult.value,
  };
}

// ============================================================
// Modifier parser
// ============================================================

/**
 * 일반 note 셀의 modifier 묶음을 canonical order대로 파싱한다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : startIndex : modifier 읽기를 시작할 문자 위치
 * - 인수 : hold : 셀 앞 hold 토큰
 * - 인수 : stopBeforeTupletPosition : tuplet slot 위치 토큰 앞에서 멈출지 여부
 * - 반환값 : ParseModifiersResult : modifier 묶음과 다음 위치 또는 오류
 */
function parseModifiers(
  rawText: string,
  startIndex: number,
  hold: HoldKind | null,
  stopBeforeTupletPosition = false,
): ParseModifiersResult {
  let index = startIndex;
  const modifiers = createEmptyModifiers();
  const seenModifiers = new Set<ModifierKind>();

  // @g, @t, @p, @m 순서로만 선택 파싱하여 modifier order를 강제한다.
  if (rawText.startsWith("@g(", index)) {
    const result = parseGliss(rawText, index);

    if (!result.ok) {
      return result;
    }

    modifiers.gliss = result.value;
    seenModifiers.add("gliss");
    index = result.nextIndex;
  }

  if (rawText.startsWith("@t(", index)) {
    // "~" hold와 trem은 같은 note 셀에서 공존할 수 없다.
    if (hold === "~") {
      return {
        ok: false,
        error: createParseError(
          "vib_and_trem",
          index,
          "Vibrato hold and tremolo modifier cannot be used together.",
        ),
      };
    }

    const result = parseTrem(rawText, index);

    if (!result.ok) {
      return result;
    }

    modifiers.trem = result.value;
    seenModifiers.add("trem");
    index = result.nextIndex;
  }

  if (rawText.startsWith("@p(", index)) {
    const result = parseAbsolutePitch(rawText, index);

    if (!result.ok) {
      return result;
    }

    modifiers.absolutePitch = result.value;
    seenModifiers.add("absolutePitch");
    index = result.nextIndex;
  }

  if (rawText.startsWith("@m(", index)) {
    const result = parseMicroPitch(rawText, index);

    if (!result.ok) {
      return result;
    }

    modifiers.microPitch = result.value;
    seenModifiers.add("microPitch");
    index = result.nextIndex;
  }

  // tuplet slot parser는 modifier 뒤의 @n 위치 토큰을 별도로 읽어야 하므로 여기서 멈춘다.
  if (stopBeforeTupletPosition && rawText.startsWith(TUPLET_POSITION_TOKEN, index)) {
    return {
      ok: true,
      value: modifiers,
      nextIndex: index,
    };
  }

  // canonical order 처리 뒤 남은 토큰은 unknown, order, duplicate 중 하나로 분류한다.
  if (index !== rawText.length) {
    return {
      ok: false,
      error: classifyRemainingModifierError(rawText, index, seenModifiers),
    };
  }

  return {
    ok: true,
    value: modifiers,
    nextIndex: index,
  };
}

// ============================================================
// Tuplet slot parser
// ============================================================

/**
 * tuplet head 내부 slot 하나를 파싱한다.
 * - 인수 : slotText : `|`로 분리된 slot 원본 문자열
 * - 인수 : slotIndex : tuplet 내부 0-based slot 순서
 * - 인수 : rawStartIndex : 전체 rawText 기준 slot 시작 위치
 * - 반환값 : ParsePletSlotResult : rest 또는 note slot 파싱 결과
 */
function parsePletSlot(
  slotText: string,
  slotIndex: number,
  rawStartIndex: number,
): ParsePletSlotResult {
  // 빈 slot은 tuplet 내부 시간 점유를 유지하는 rest slot으로 기록한다.
  if (slotText.length === 0) {
    return {
      ok: true,
      value: {
        slotIndex,
        isRest: true,
        note: null,
      },
      nextIndex: rawStartIndex,
    };
  }

  // parser 단계에서 nested tuplet은 구조 오류로 확정할 수 있다.
  if (containsPletHeadCandidate(slotText)) {
    return invalidPart(
      "tuplet_nested_forbidden",
      rawStartIndex,
      "Nested tuplet is not allowed inside a tuplet slot.",
    );
  }

  const noteResult = parsePletSlotNote(slotText, rawStartIndex);

  if (!noteResult.ok) {
    return noteResult;
  }

  return {
    ok: true,
    value: {
      slotIndex,
      isRest: false,
      note: noteResult.value,
    },
    nextIndex: rawStartIndex + slotText.length,
  };
}

/**
 * tuplet 내부 note slot의 note 문법과 위치 토큰을 파싱한다.
 * - 인수 : slotText : rest가 아닌 slot 문자열
 * - 인수 : rawStartIndex : 전체 rawText 기준 slot 시작 위치
 * - 반환값 : ParsePletSlotNoteResult : slot note 파싱 결과
 */
function parsePletSlotNote(
  slotText: string,
  rawStartIndex: number,
): ParsePletSlotNoteResult {
  let index = 0;
  let hold: HoldKind | null = null;
  const firstChar = slotText[index];

  // slot 내부 note도 일반 note와 동일하게 맨 앞 hold 토큰만 인정한다.
  if (isHoldKind(firstChar)) {
    hold = firstChar;
    index += 1;
  }

  const defaultTextResult = scanDefaultText(slotText, index);

  if (!defaultTextResult.ok) {
    return invalidPart(
      defaultTextResult.error.code,
      offsetCharIndex(defaultTextResult.error.charIndex, rawStartIndex),
      defaultTextResult.error.message ?? "Invalid tuplet slot text.",
    );
  }

  index = defaultTextResult.nextIndex;

  // slot note의 modifier는 @n 위치 토큰 앞까지만 읽는다.
  const modifierResult = parseModifiers(slotText, index, hold, true);

  if (!modifierResult.ok) {
    return invalidPart(
      modifierResult.error.code,
      offsetCharIndex(modifierResult.error.charIndex, rawStartIndex),
      modifierResult.error.message ?? "Invalid tuplet slot modifier.",
    );
  }

  index = modifierResult.nextIndex;

  const positionResult = parseTupletPosition(slotText, index);

  if (!positionResult.ok) {
    return invalidPart(
      positionResult.error.code,
      offsetCharIndex(positionResult.error.charIndex, rawStartIndex),
      positionResult.error.message ?? "Invalid tuplet slot position.",
    );
  }

  if (positionResult.nextIndex !== slotText.length) {
    return invalidPart(
      "more_than_expected",
      rawStartIndex + positionResult.nextIndex,
      "Unexpected text after tuplet slot position.",
    );
  }

  return {
    ok: true,
    value: {
      hold,
      displayText: decideDisplayText(defaultTextResult.value, hold),
      modifiers: modifierResult.value,
      position: positionResult.value,
    },
    nextIndex: rawStartIndex + slotText.length,
  };
}

/**
 * tuplet slot의 필수 위치 토큰 `@n(midi_num)`을 파싱한다.
 * - 인수 : slotText : rest가 아닌 slot 문자열
 * - 인수 : startIndex : `@n(`가 시작되어야 하는 위치
 * - 반환값 : ParseTupletPositionResult : 위치 토큰 파싱 결과
 */
function parseTupletPosition(
  slotText: string,
  startIndex: number,
): ParseTupletPositionResult {
  if (!slotText.startsWith(TUPLET_POSITION_TOKEN, startIndex)) {
    return invalidPart(
      "tuplet_position_required",
      startIndex,
      "Tuplet note slot requires @n(midi_num).",
    );
  }

  const argsResult = readModifierArgs(slotText, startIndex, TUPLET_POSITION_TOKEN);

  if (!argsResult.ok) {
    return argsResult;
  }

  const midiNum = Number.parseInt(argsResult.value, 10);

  if (!/^[0-9]+$/.test(argsResult.value)) {
    return invalidPart("invalid_number", startIndex, "Tuplet position must be an integer.");
  }

  if (midiNum < 0 || midiNum > 127) {
    return invalidPart("invalid_midi_range", startIndex, "Tuplet position MIDI number must be between 0 and 127.");
  }

  return {
    ok: true,
    value: {
      midiNum,
    },
    nextIndex: argsResult.nextIndex,
  };
}

// ============================================================
// Modifier part parsers
// ============================================================

/**
 * gliss modifier를 파싱한다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : startIndex : `@g(` 시작 위치
 * - 반환값 : ParseModifierPartResult<ParsedGliss> : gliss 파싱 결과
 */
function parseGliss(
  rawText: string,
  startIndex: number,
): ParseModifierPartResult<ParsedGliss> {
  const argsResult = readModifierArgs(rawText, startIndex, "@g(");

  if (!argsResult.ok) {
    return argsResult;
  }

  const args = argsResult.value.split(",");

  if (args.length !== 2 || args[0] === "" || args[1] === "") {
    return invalidPart("missing_argument", startIndex, "Gliss modifier requires id and kind arguments.");
  }

  const id = args[0];
  const glissKind = args[1];

  if (!isGlissId(id)) {
    return invalidPart("invalid_gliss_id", startIndex, "Gliss id must be one lowercase alphabet letter.");
  }

  if (!isGlissKind(glissKind)) {
    return invalidPart("invalid_gliss_kind", startIndex, "Gliss kind must be S, M, or E.");
  }

  return {
    ok: true,
    value: {
      id,
      glissKind,
    },
    nextIndex: argsResult.nextIndex,
  };
}

/**
 * tremolo modifier를 파싱한다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : startIndex : `@t(` 시작 위치
 * - 반환값 : ParseModifierPartResult<ParsedTrem> : tremolo 파싱 결과
 */
function parseTrem(
  rawText: string,
  startIndex: number,
): ParseModifierPartResult<ParsedTrem> {
  const argsResult = readModifierArgs(rawText, startIndex, "@t(");

  if (!argsResult.ok) {
    return argsResult;
  }

  const divNum = Number.parseInt(argsResult.value, 10);

  if (!/^[0-9]+$/.test(argsResult.value) || !isTremDivision(divNum)) {
    return invalidPart("invalid_trem_division", startIndex, "Tremolo division must be 2, 3, or 4.");
  }

  return {
    ok: true,
    value: {
      divNum,
    },
    nextIndex: argsResult.nextIndex,
  };
}

/**
 * absolute pitch modifier를 파싱한다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : startIndex : `@p(` 시작 위치
 * - 반환값 : ParseModifierPartResult<ParsedAbsolutePitch> : absolute pitch 파싱 결과
 */
function parseAbsolutePitch(
  rawText: string,
  startIndex: number,
): ParseModifierPartResult<ParsedAbsolutePitch> {
  const argsResult = readModifierArgs(rawText, startIndex, "@p(");

  if (!argsResult.ok) {
    return argsResult;
  }

  const midiNum = Number.parseInt(argsResult.value, 10);

  if (!/^[0-9]+$/.test(argsResult.value)) {
    return invalidPart("invalid_number", startIndex, "Absolute pitch must be an integer.");
  }

  if (midiNum < 0 || midiNum > 127) {
    return invalidPart("invalid_midi_range", startIndex, "MIDI number must be between 0 and 127.");
  }

  return {
    ok: true,
    value: {
      midiNum,
    },
    nextIndex: argsResult.nextIndex,
  };
}

/**
 * micro pitch modifier를 파싱한다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : startIndex : `@m(` 시작 위치
 * - 반환값 : ParseModifierPartResult<ParsedMicroPitch> : micro pitch 파싱 결과
 */
function parseMicroPitch(
  rawText: string,
  startIndex: number,
): ParseModifierPartResult<ParsedMicroPitch> {
  const argsResult = readModifierArgs(rawText, startIndex, "@m(");

  if (!argsResult.ok) {
    return argsResult;
  }

  if (!/^-?[0-9]+(?:\.[0-9])?$/.test(argsResult.value)) {
    return invalidPart("invalid_number", startIndex, "Micro pitch must have at most one fractional digit.");
  }

  const centNum = Number.parseFloat(argsResult.value);

  if (centNum < -100 || centNum > 100) {
    return invalidPart("invalid_cent_range", startIndex, "Micro pitch cent value must be between -100 and 100.");
  }

  return {
    ok: true,
    value: {
      centNum,
    },
    nextIndex: argsResult.nextIndex,
  };
}

/**
 * modifier 괄호 내부 인수 문자열을 읽는다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : startIndex : modifier 시작 위치
 * - 인수 : token : `@g(` 같은 modifier 시작 토큰
 * - 반환값 : ParseModifierPartResult<string> : 괄호 내부 문자열과 다음 위치 또는 오류
 */
function readModifierArgs(
  rawText: string,
  startIndex: number,
  token: ModifierToken | TupletPositionToken,
): ParseModifierPartResult<string> {
  const argsStart = startIndex + token.length;
  const closeIndex = rawText.indexOf(")", argsStart);

  if (closeIndex === -1) {
    return invalidPart("unterminated_paren", startIndex, "Modifier parenthesis is not closed.");
  }

  const value = rawText.slice(argsStart, closeIndex);

  if (value.length === 0) {
    return invalidPart("missing_argument", argsStart, "Modifier argument must not be empty.");
  }

  return {
    ok: true,
    value,
    nextIndex: closeIndex + 1,
  };
}

/**
 * canonical order 처리 뒤 남은 modifier 오류를 분류한다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : index : 남은 토큰 시작 위치
 * - 인수 : seenModifiers : 이미 파싱한 modifier 종류 집합
 * - 반환값 : ParseError : unknown/order/duplicate modifier 오류
 */
function classifyRemainingModifierError(
  rawText: string,
  index: number,
  seenModifiers: Set<ModifierKind>,
): ParseError {
  const modifierKind = getKnownModifierKindAt(rawText, index);

  if (modifierKind === null) {
    return createParseError(
      rawText[index] === "@" ? "unknown_modifier" : "more_than_expected",
      index,
      "Unexpected text after note cell body.",
    );
  }

  if (seenModifiers.has(modifierKind)) {
    return createParseError(
      "duplicate_modifier",
      index,
      "Duplicate modifier is not allowed.",
    );
  }

  return createParseError(
    "modifier_order",
    index,
    "Modifier order must be @g, @t, @p, @m.",
  );
}

// ============================================================
// Structural scan helpers
// ============================================================

/**
 * 여는 괄호에 대응하는 닫는 괄호 위치를 찾는다.
 * - 인수 : rawText : 괄호를 포함한 원본 문자열
 * - 인수 : openIndex : 여는 괄호 위치
 * - 반환값 : number : 대응 닫는 괄호 위치. 찾지 못하면 -1
 */
function findMatchingParen(rawText: string, openIndex: number): number {
  let depth = 0;
  let index = openIndex + 1;

  // modifier 인수 괄호가 body 안에 있을 수 있으므로 중첩 깊이를 추적한다.
  while (index < rawText.length) {
    const char = rawText[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      if (depth === 0) {
        return index;
      }

      depth -= 1;
    }

    index += 1;
  }

  return -1;
}

/**
 * tuplet body를 최상위 `|` 기준으로 slot 배열로 분리한다.
 * - 인수 : body : tuplet head 괄호 내부 문자열
 * - 인수 : bodyStartIndex : 전체 rawText 기준 body 시작 위치
 * - 반환값 : SplitTupletSlotsResult : slot 문자열 목록과 각 slot 시작 위치
 */
function splitTupletSlots(body: string, bodyStartIndex: number): SplitTupletSlotsResult {
  const slots: string[] = [];
  const startIndexes: number[] = [];
  let depth = 0;
  let slotStart = 0;
  let index = 0;

  // modifier 괄호 내부의 문자는 slot 구분자가 아니므로 최상위 `|`만 분리 기준으로 삼는다.
  while (index < body.length) {
    const char = body[index];

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === ")") {
      if (depth === 0) {
        return {
          ok: false,
          error: createParseError(
            "more_than_expected",
            bodyStartIndex + index,
            "Unexpected closing parenthesis in tuplet body.",
          ),
        };
      }

      depth -= 1;
      index += 1;
      continue;
    }

    if (char === "|" && depth === 0) {
      slots.push(body.slice(slotStart, index));
      startIndexes.push(bodyStartIndex + slotStart);
      slotStart = index + 1;
    }

    index += 1;
  }

  if (depth !== 0) {
    return {
      ok: false,
      error: createParseError(
        "unterminated_paren",
        bodyStartIndex + slotStart,
        "Parenthesis inside tuplet body is not closed.",
      ),
    };
  }

  slots.push(body.slice(slotStart));
  startIndexes.push(bodyStartIndex + slotStart);

  return {
    ok: true,
    value: {
      slots,
      startIndexes,
    },
    nextIndex: bodyStartIndex + body.length,
  };
}

// ============================================================
// Text and escape helpers
// ============================================================

/**
 * 일반 note 셀의 defaultText 구간을 읽는다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : startIndex : defaultText 읽기를 시작할 문자 위치
 * - 반환값 : ScanTextResult : defaultText와 다음 파싱 위치 또는 오류
 */
function scanDefaultText(
  rawText: string,
  startIndex: number,
): ScanTextResult {
  let index = startIndex;
  let value = "";

  // modifier 시작 전까지 문자를 읽으며 escape 복원과 예약문자 충돌 검사를 수행한다.
  while (index < rawText.length) {
    const char = rawText[index];

    // @는 modifier 시작점이므로 defaultText 스캔을 멈추고 상위 parser로 넘긴다.
    if (char === "@") {
      break;
    }

    // backslash는 다음 문자를 일반 표시 문자로 복원하는 escape 시작점이다.
    if (char === "\\") {
      const escapeResult = readEscapedChar(rawText, index);

      if (!escapeResult.ok) {
        return {
          ok: false,
          error: createParseError(
            "invalid_escape",
            escapeResult.charIndex,
            "Invalid escape sequence in note cell.",
          ),
        };
      }

      value += escapeResult.value;
      index = escapeResult.nextIndex;
      continue;
    }

    // unescaped 예약문자는 defaultText에 직접 들어올 수 없다.
    if (RESERVED_NOTE_CHARS.has(char)) {
      return {
        ok: false,
        error: createParseError(
          "unexpected_reserved_char",
          index,
          `Unexpected reserved character: ${char}.`,
        ),
      };
    }

    value += char;
    index += 1;
  }

  return {
    ok: true,
    value,
    nextIndex: index,
  };
}

/**
 * mute 셀 표시 문자열의 escape를 복원한다.
 * - 인수 : text : escape를 복원할 문자열
 * - 인수 : offset : 원본 rawText 기준 위치 보정을 위한 시작 offset
 * - 인수 : rejectReserved : 예약문자 충돌까지 검사할지 여부
 * - 반환값 : UnescapeResult : 복원된 문자열 또는 escape 오류
 */
function unescapeText(
  text: string,
  offset: number,
  rejectReserved: boolean,
): UnescapeResult {
  let index = 0;
  let value = "";

  // 표시 문자열 전체를 순회하며 허용된 escape만 복원한다.
  while (index < text.length) {
    const char = text[index];

    if (char === "\\") {
      const escapeResult = readEscapedChar(text, index);

      if (!escapeResult.ok) {
        return {
          ok: false,
          charIndex: offset + escapeResult.charIndex,
        };
      }

      value += escapeResult.value;
      index = escapeResult.nextIndex;
      continue;
    }

    // 현재 mute 호출에서는 false이며, note 쪽 재사용 가능성을 위해 옵션으로 남겨둔다.
    if (rejectReserved && RESERVED_NOTE_CHARS.has(char)) {
      return {
        ok: false,
        charIndex: offset + index,
      };
    }

    value += char;
    index += 1;
  }

  return {
    ok: true,
    value,
  };
}

/**
 * backslash 위치에서 escape된 문자 하나를 읽는다.
 * - 인수 : text : escape를 포함한 문자열
 * - 인수 : backslashIndex : backslash가 위치한 인덱스
 * - 반환값 : ReadEscapedCharResult : 복원 문자와 다음 위치 또는 오류 위치
 */
function readEscapedChar(
  text: string,
  backslashIndex: number,
): ReadEscapedCharResult {
  const escapedIndex = backslashIndex + 1;
  const escapedChar = text[escapedIndex];

  // backslash가 문자열 마지막이면 escape할 대상이 없다.
  if (escapedChar === undefined) {
    return {
      ok: false,
      charIndex: backslashIndex,
    };
  }

  // 명세에서 허용한 예약문자만 escape 대상으로 인정한다.
  if (!ESCAPABLE_CHARS.has(escapedChar)) {
    return {
      ok: false,
      charIndex: escapedIndex,
    };
  }

  return {
    ok: true,
    value: escapedChar,
    nextIndex: escapedIndex + 1,
  };
}

// ============================================================
// Predicate, value, and error helpers
// ============================================================

/**
 * rawText가 tuplet head 후보인지 확인한다.
 * - 인수 : rawText : 노트 영역 셀 원본 문자열
 * - 반환값 : boolean : `/n(` 패턴으로 시작하는지 여부
 */
function isPletHeadCandidate(rawText: string): boolean {
  return /^\/[0-9]+\(/.test(rawText);
}

/**
 * 문자가 hold 토큰인지 확인한다.
 * - 인수 : value : 검사할 문자 후보
 * - 반환값 : value is HoldKind : "-" 또는 "~" 여부
 */
function isHoldKind(value: string | undefined): value is HoldKind {
  return value === "-" || value === "~";
}

/**
 * note 셀의 표시 문자열을 결정한다.
 * - 인수 : defaultText : escape 복원이 끝난 defaultText
 * - 인수 : hold : 셀 앞 hold 토큰
 * - 반환값 : string : renderer가 기본 표시값으로 사용할 문자열
 */
function decideDisplayText(defaultText: string, hold: HoldKind | null): string {
  if (defaultText.length > 0) {
    return defaultText;
  }

  if (hold === "-") {
    return "-";
  }

  return "";
}

/**
 * 아직 modifier가 없는 기본 ParsedModifiers 객체를 생성한다.
 * - 반환값 : ParsedModifiers : 모든 modifier가 null인 기본 객체
 */
function createEmptyModifiers(): ParsedModifiers {
  return {
    gliss: null,
    trem: null,
    absolutePitch: null,
    microPitch: null,
  };
}

/**
 * ParsedModifiers 안에 실제 modifier 값이 하나라도 있는지 확인한다.
 * - 인수 : modifiers : 일반 note 셀의 modifier 묶음
 * - 반환값 : boolean : gliss/trem/absolutePitch/microPitch 중 하나 이상 존재하는지 여부
 */
function hasAnyModifier(modifiers: ParsedModifiers): boolean {
  return (
    modifiers.gliss !== null ||
    modifiers.trem !== null ||
    modifiers.absolutePitch !== null ||
    modifiers.microPitch !== null
  );
}

/**
 * modifier 하위 parser의 실패 결과를 생성한다.
 * - 인수 : code : note parser 오류 코드
 * - 인수 : charIndex : 오류 위치. 특정하기 어려우면 null
 * - 인수 : message : 사람이 읽는 보조 오류 메시지
 * - 반환값 : ParseModifierPartResult<T> : 하위 parser 실패 결과
 */
function invalidPart<T>(
  code: ParseErrorCode,
  charIndex: number | null,
  message: string,
): ParseModifierPartResult<T> {
  return {
    ok: false,
    error: createParseError(code, charIndex, message),
  };
}

/**
 * 문자열 값이 gliss kind 리터럴 중 하나인지 확인한다.
 * - 인수 : value : modifier 인수에서 읽은 문자열
 * - 반환값 : value is ParsedGliss["glissKind"] : S/M/E 여부
 */
function isGlissKind(value: string): value is ParsedGliss["glissKind"] {
  return value === "S" || value === "M" || value === "E";
}

/**
 * 문자열 값이 gliss id로 허용되는지 확인한다.
 * - 인수 : value : modifier 인수에서 읽은 문자열
 * - 반환값 : boolean : 소문자 알파벳 한 글자인지 여부
 */
function isGlissId(value: string): boolean {
  return /^[a-z]$/.test(value);
}

/**
 * 숫자 값이 tremolo 분할 수로 허용되는지 확인한다.
 * - 인수 : value : modifier 인수에서 읽은 정수
 * - 반환값 : value is ParsedTrem["divNum"] : 2/3/4 여부
 */
function isTremDivision(value: number): value is ParsedTrem["divNum"] {
  return value === 2 || value === 3 || value === 4;
}

/**
 * 특정 위치에서 시작하는 알려진 modifier 종류를 확인한다.
 * - 인수 : rawText : 일반 note 셀 원본 문자열
 * - 인수 : index : 검사할 문자 위치
 * - 반환값 : ModifierKind | null : 알려진 modifier 종류 또는 null
 */
function getKnownModifierKindAt(rawText: string, index: number): ModifierKind | null {
  if (rawText.startsWith("@g(", index)) {
    return "gliss";
  }

  if (rawText.startsWith("@t(", index)) {
    return "trem";
  }

  if (rawText.startsWith("@p(", index)) {
    return "absolutePitch";
  }

  if (rawText.startsWith("@m(", index)) {
    return "microPitch";
  }

  return null;
}

/**
 * 문자열 안에 nested tuplet head 후보가 있는지 확인한다.
 * - 인수 : text : tuplet slot 문자열
 * - 반환값 : boolean : `/n(` 패턴 포함 여부
 */
function containsPletHeadCandidate(text: string): boolean {
  return /\/[0-9]+\(/.test(text);
}

/**
 * slot 내부 상대 오류 위치를 전체 rawText 기준 위치로 보정한다.
 * - 인수 : charIndex : slot 내부 오류 위치. 특정하기 어려우면 null
 * - 인수 : offset : 전체 rawText 기준 slot 시작 위치
 * - 반환값 : number | null : 보정된 오류 위치
 */
function offsetCharIndex(charIndex: number | null, offset: number): number | null {
  if (charIndex === null) {
    return null;
  }

  return offset + charIndex;
}

/**
 * note parser 실패 결과를 생성한다.
 * - 인수 : rawText : 노트 영역 셀 원본 문자열
 * - 인수 : code : note parser 오류 코드
 * - 인수 : charIndex : 오류 위치. 특정하기 어려우면 null
 * - 인수 : message : 사람이 읽는 보조 오류 메시지
 * - 반환값 : ParsedCell : invalid note 셀 결과
 */
function invalidCell(
  rawText: string,
  code: ParseErrorCode,
  charIndex: number | null,
  message: string,
): ParsedCell {
  return {
    kind: "invalid",
    rawText,
    error: createParseError(code, charIndex, message),
  };
}

/**
 * note parser 오류 객체를 생성한다.
 * - 인수 : code : note parser 오류 코드
 * - 인수 : charIndex : 오류 위치. 특정하기 어려우면 null
 * - 인수 : message : 사람이 읽는 보조 오류 메시지
 * - 반환값 : ParseError : note parser 오류 객체
 */
function createParseError(
  code: ParseErrorCode,
  charIndex: number | null,
  message: string,
): ParseError {
  return {
    code,
    charIndex,
    message,
  };
}

// ============================================================
// Local result types
// ============================================================

/**
 * 문자열 스캔 성공 또는 실패 결과.
 * - 정상 스캔 시 : 문자열 값과 다음 인덱스
 * - 비정상 스캔 시 : ParseError
 */
type ScanTextResult =
  | {
      ok: true;
      value: string;
      nextIndex: number;
    }
  | {
      ok: false;
      error: ParseError;
    };

/**
 * escape 복원 성공 또는 실패 결과.
 * - 정상 복원 시 : 복원된 문자열
 * - 비정상 복원 시 : 오류 위치
 */
type UnescapeResult =
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      charIndex: number;
    };

/**
 * escape 문자 하나 읽기 성공 또는 실패 결과.
 * - 정상 읽기 시 : 복원 문자와 다음 인덱스
 * - 비정상 읽기 시 : 오류 위치
 */
type ReadEscapedCharResult =
  | {
      ok: true;
      value: string;
      nextIndex: number;
    }
  | {
      ok: false;
      charIndex: number;
    };

/**
 * tuplet body slot 분리 결과.
 */
type SplitTupletSlotsResult = ParsePartResult<{
  slots: string[];
  startIndexes: number[];
}>;

/**
 * tuplet slot 하나의 파싱 결과.
 */
type ParsePletSlotResult = ParsePartResult<ParsedPletSlot>;

/**
 * tuplet slot 내부 note 파싱 결과.
 */
type ParsePletSlotNoteResult = ParsePartResult<ParsedPletSlotNote>;

/**
 * tuplet slot 위치 토큰 파싱 결과.
 */
type ParseTupletPositionResult = ParsePartResult<ParsedTupletPosition>;

/**
 * 일반 note modifier 종류.
 * parser는 이 순서를 기준으로 canonical order와 duplicate 여부를 판정한다.
 */
type ModifierKind = "gliss" | "trem" | "absolutePitch" | "microPitch";

/**
 * 현재 parser가 인식하는 modifier 시작 토큰.
 */
type ModifierToken = (typeof KNOWN_MODIFIER_TOKENS)[number];

/**
 * tuplet slot 위치 토큰.
 */
type TupletPositionToken = typeof TUPLET_POSITION_TOKEN;

/**
 * 일반 note modifier 묶음 파싱 결과.
 */
type ParseModifiersResult = ParsePartResult<ParsedModifiers>;

/**
 * modifier 하위 parser의 공통 반환 형태.
 */
type ParseModifierPartResult<T> = ParsePartResult<T>;
