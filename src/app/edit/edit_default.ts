/**
 * 일반 note cell edit 입력을 parser가 읽을 수 있는 rawText 조각으로 합성한다.
 * defaultText와 후속 modifier 조합은 이 모듈에 모은다.
 */

import {
  AUTO_HARMONIC_2OCTAVE_ABSOLUTE_PITCH,
  AUTO_HARMONIC_2OCTAVE_OUT_OF_RANGE,
} from "../pitch_label";

const DEFAULT_TEXT_ESCAPE_CHARS = new Set(["\\", "/", "@", "|", "(", ")", "-", "~"]);
const COMMENT_TEXT_ESCAPE_CHARS = new Set(["\\", "/", "@", "|", "(", ")", "-", "~"]);

/** Default 영역 입력 모드. */
export type DefaultEditMode =
  | "autoSharp"
  | "autoFlat"
  | "custom"
  | "comment"
  | "eraser";

/** 일반 note cell의 앞쪽 hold token. */
export type HoldEditToken = "" | "-" | "~";

/** gliss modifier의 UI 입력 상태. */
export type GlissEditInput = {
  kind: "" | "S" | "M" | "E" | "holdStart";
  id: string;
};

/**
 * 일반 note cell의 Default 영역 입력 상태.
 * - 인수 : 없음
 * - 반환값 : defaultText와 후속 modifier 조합에 사용할 입력 상태
 */
export type DefaultNoteEditInput = {
  mode: DefaultEditMode;
  customText: string;
  autoText: string;
  hold: HoldEditToken;
  gliss: GlissEditInput;
  tremDivision: "" | "2" | "3" | "4";
  absolutePitch: string;
  microPitch: string;
};

/**
 * defaultText 입력창 표시 문자열을 note rawText에 저장 가능한 escaped 문자열로 바꾼다.
 * - 인수 : text : 사용자가 입력창에서 보는 표시 문자열
 * - 반환값 : parser가 defaultText로 복원할 수 있는 escaped rawText
 */
export function escapeDefaultTextForNoteRawText(text: string): string {
  let escapedText = "";

  // defaultText 전체를 순회하며 parser 예약문자만 backslash escape로 저장한다.
  for (const char of text) {
    escapedText += DEFAULT_TEXT_ESCAPE_CHARS.has(char) ? `\\${char}` : char;
  }

  return escapedText;
}

/**
 * comment 입력창 표시 문자열을 mute cell rawText에 저장 가능한 escaped 문자열로 바꾼다.
 * - 인수 : text : 사용자가 입력창에서 보는 comment 문자열
 * - 반환값 : parser가 mute displayText로 복원할 수 있는 escaped rawText
 */
export function escapeCommentTextForMuteRawText(text: string): string {
  let escapedText = "";

  // mute 내부도 허용 escape 문자만 명시적으로 저장해 rawText 판별 토큰과 충돌하지 않게 한다.
  for (const char of text) {
    escapedText += COMMENT_TEXT_ESCAPE_CHARS.has(char) ? `\\${char}` : char;
  }

  return escapedText;
}

/**
 * Default 입력창 값이 삭제 명령으로 취급될 수 있는지 확인한다.
 * - 인수 : text : 사용자가 입력창에서 보는 표시 문자열
 * - 반환값 : 비어 있거나 공백뿐이면 true
 */
export function isEmptyDefaultText(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * 일반 note cell modifier 입력이 하나라도 있는지 확인한다.
 * - 인수 : input : Default 영역과 modifier 영역 입력 상태
 * - 반환값 : modifier rawText를 만들 입력이 있으면 true
 */
export function hasDefaultNoteModifiers(input: DefaultNoteEditInput): boolean {
  return (
    input.hold !== "" ||
    input.gliss.kind !== "" ||
    input.tremDivision !== "" ||
    hasEffectiveAbsolutePitch(input.absolutePitch) ||
    hasEffectiveMicroPitch(input.microPitch)
  );
}

/**
 * gliss id 입력이 parser 허용 범위를 만족하는지 확인한다.
 * - 인수 : id : gliss id 입력값
 * - 반환값 : 소문자 알파벳 한 글자이면 true
 */
export function isValidGlissId(id: string): boolean {
  return /^[a-z]$/.test(id);
}

/**
 * absolute pitch 입력이 parser 허용 범위를 만족하는지 확인한다.
 * - 인수 : value : absolute pitch MIDI 입력값
 * - 반환값 : 0부터 127까지의 정수이면 true
 */
export function isValidAbsolutePitch(value: string): boolean {
  if (value.trim() === "") {
    return true;
  }

  if (!/^[0-9]+$/.test(value.trim())) {
    return false;
  }

  const midiNum = Number.parseInt(value, 10);

  return midiNum >= 0 && midiNum <= 127;
}

/**
 * micro pitch 입력이 parser 허용 범위를 만족하는지 확인한다.
 * - 인수 : value : micro pitch cent 입력값
 * - 반환값 : -100부터 100까지, 소수점 이하 1자리 이내이면 true
 */
export function isValidMicroPitch(value: string): boolean {
  if (value.trim() === "") {
    return true;
  }

  if (!/^-?[0-9]+(?:\.[0-9])?$/.test(value.trim())) {
    return false;
  }

  const centNum = Number.parseFloat(value);

  return centNum >= -100 && centNum <= 100;
}

/**
 * absolute pitch 입력이 실제 modifier token을 만들어야 하는지 확인한다.
 * - 인수 : value : absolute pitch MIDI 입력값
 * - 반환값 : 빈 값 또는 0이면 false
 */
export function hasEffectiveAbsolutePitch(value: string): boolean {
  if (value.trim() === "") {
    return false;
  }

  if (
    value === AUTO_HARMONIC_2OCTAVE_ABSOLUTE_PITCH ||
    value === AUTO_HARMONIC_2OCTAVE_OUT_OF_RANGE
  ) {
    return false;
  }

  return Number.parseInt(value, 10) !== 0;
}

/**
 * micro pitch 입력이 실제 modifier token을 만들어야 하는지 확인한다.
 * - 인수 : value : micro pitch cent 입력값
 * - 반환값 : 빈 값 또는 0이면 false
 */
export function hasEffectiveMicroPitch(value: string): boolean {
  if (value.trim() === "") {
    return false;
  }

  return Number.parseFloat(value) !== 0;
}

/**
 * Default 입력 상태가 저장 가능한 rawText로 합성될 수 있는지 확인한다.
 * - 인수 : input : Default 영역과 modifier 영역 입력 상태
 * - 반환값 : blocked reason 또는 null
 */
export function validateDefaultNoteEditInput(input: DefaultNoteEditInput): string | null {
  if (input.mode === "comment" || input.mode === "eraser") {
    return null;
  }

  if (
    (input.mode === "autoSharp" || input.mode === "autoFlat") &&
    input.autoText.trim() === ""
  ) {
    return "AUTO sharp/flat requires a note row selection.";
  }

  if (input.gliss.kind !== "" && !isValidGlissId(input.gliss.id)) {
    return "Gliss id must be one lowercase alphabet letter.";
  }

  if (input.gliss.kind === "holdStart") {
    return null;
  }

  if (input.absolutePitch === AUTO_HARMONIC_2OCTAVE_ABSOLUTE_PITCH) {
    return "AUTO◇ requires a note row selection.";
  }

  if (input.absolutePitch === AUTO_HARMONIC_2OCTAVE_OUT_OF_RANGE) {
    return "AUTO◇ pitch exceeds MIDI range.";
  }

  if (!isValidAbsolutePitch(input.absolutePitch)) {
    return "absolutePitch must be an integer MIDI number from 0 to 127.";
  }

  if (!isValidMicroPitch(input.microPitch)) {
    return "microPitch must be -100..100 with at most one fractional digit.";
  }

  if (input.hold === "~" && input.tremDivision !== "") {
    return "Vibrato hold '~' and tremolo cannot be used together.";
  }

  return null;
}

/**
 * 일반 note cell의 Default 입력 상태를 최종 rawText로 합성한다.
 * - 인수 : input : Default 영역 입력 상태
 * - 반환값 : parser가 note cell로 읽을 수 있는 rawText
 */
export function composeDefaultNoteRawText(input: DefaultNoteEditInput): string {
  if (input.mode === "comment") {
    return `//${escapeCommentTextForMuteRawText(input.customText)}`;
  }

  if (input.gliss.kind === "holdStart") {
    return `-@g(${input.gliss.id},S)`;
  }

  const tokens: string[] = [];
  const defaultText = input.mode === "custom"
    ? input.customText
    : input.autoText;

  // parser canonical order와 동일하게 hold, defaultText, gliss, trem, absolutePitch, microPitch 순서로 합성한다.
  tokens.push(input.hold);
  tokens.push(escapeDefaultTextForNoteRawText(defaultText));

  if (input.gliss.kind !== "") {
    tokens.push(`@g(${input.gliss.id},${input.gliss.kind})`);
  }

  if (input.tremDivision !== "") {
    tokens.push(`@t(${input.tremDivision})`);
  }

  if (hasEffectiveAbsolutePitch(input.absolutePitch)) {
    tokens.push(`@p(${input.absolutePitch.trim()})`);
  }

  if (hasEffectiveMicroPitch(input.microPitch)) {
    tokens.push(`@m(${input.microPitch.trim()})`);
  }

  return tokens.join("");
}
