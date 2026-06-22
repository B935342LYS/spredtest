/**
 * pitch 입력 UI의 표시 문자열과 AUTO defaultText 생성을 담당한다.
 */

import type { RowId } from "../core/score/types";
import type { AppState } from "./app_types";
import type { DefaultNoteEditInput } from "./edit/edit_default";

/**
 * MIDI note number를 계이름 문자열로 변환한다.
 * - 인수 : midi : MIDI note number
 * - 인수 : accidental : sharp 또는 flat 표기 정책
 * - 반환값 : 계이름과 octave를 포함한 표시 문자열
 */
export function formatPitchName(midi: number, accidental: "sharp" | "flat"): string {
  const sharpNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const flatNames = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
  const names = accidental === "sharp" ? sharpNames : flatNames;
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;

  return `${names[pitchClass]}${octave}`;
}

/**
 * AUTO 모드에서 사용할 defaultText를 note row와 pitch modifier 입력으로 만든다.
 * - 인수 : input : 현재 Default/Pitch 입력 상태
 * - 인수 : rowMidi : 클릭 또는 선택된 note row의 MIDI note number
 * - 반환값 : 계이름과 microPitch 방향 기호를 포함한 defaultText
 */
export function buildAutoDefaultText(input: DefaultNoteEditInput, rowMidi: number): string {
  const accidental = input.mode === "autoFlat" ? "flat" : "sharp";
  const baseMidi = input.absolutePitch.trim() === ""
    ? rowMidi
    : Number.parseInt(input.absolutePitch, 10);
  const microPitch = input.microPitch.trim() === ""
    ? 0
    : Number.parseFloat(input.microPitch);
  const suffix = microPitch > 0 ? "+" : microPitch < 0 ? "-" : "";

  return `${formatPitchName(baseMidi, accidental)}${suffix}`;
}

/**
 * 현재 입력 상태에 note row 문맥을 반영해 AUTO defaultText를 채운다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : input : 현재 Default/Pitch 입력 상태
 * - 인수 : rowId : AUTO 기준으로 사용할 rowId
 * - 반환값 : AUTO defaultText가 반영된 입력 상태
 */
export function resolveAutoDefaultText(
  state: AppState,
  input: DefaultNoteEditInput,
  rowId: RowId | null,
): DefaultNoteEditInput {
  if (input.mode !== "autoSharp" && input.mode !== "autoFlat") {
    return input;
  }

  if (rowId === null) {
    return {
      ...input,
      autoText: "",
    };
  }

  const row = state.document.indexes.rowById.get(rowId);

  if (row?.type !== "note") {
    return {
      ...input,
      autoText: "",
    };
  }

  return {
    ...input,
    autoText: buildAutoDefaultText(input, row.midi),
  };
}

/**
 * absolutePitch select에 MIDI note 선택지를 채운다.
 * - 인수 : select : absolutePitch 선택 DOM 요소
 * - 반환값 : 없음
 */
export function populateAbsolutePitchOptions(select: HTMLSelectElement): void {
  for (let midi = 127; midi >= 1; midi -= 1) {
    const option = document.createElement("option");

    option.value = String(midi);
    option.textContent = formatPitchName(midi, "sharp");
    select.appendChild(option);
  }
}

/**
 * microPitch 직접 입력값을 parser 허용 형식인 소수점 이하 1자리 이내로 정리한다.
 * - 인수 : value : 사용자가 입력한 microPitch 문자열
 * - 반환값 : 불필요한 문자와 두 번째 이하 소수 자릿수를 제거한 문자열
 */
export function normalizeMicroPitchInput(value: string): string {
  const signedText = value.replace(/[^\d.-]/g, "");
  const sign = signedText.startsWith("-") ? "-" : "";
  const withoutExtraSigns = signedText.replace(/-/g, "");
  const dotIndex = withoutExtraSigns.indexOf(".");

  if (dotIndex === -1) {
    return `${sign}${withoutExtraSigns}`;
  }

  const integerPart = withoutExtraSigns.slice(0, dotIndex);
  const fractionPart = withoutExtraSigns
    .slice(dotIndex + 1)
    .replace(/\./g, "")
    .slice(0, 1);

  return `${sign}${integerPart}.${fractionPart}`;
}
