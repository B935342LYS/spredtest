/**
 * global number row 편집 입력을 rawText로 변환하는 helper이다.
 */

import type {
  AppDom,
  AppState,
  NumberEditRamp,
  ScoreHit,
} from "../app_types";

/**
 * number ramp 버튼 그룹에서 현재 선택된 ramp 토큰 종류를 읽는다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 선택된 NumberEditRamp 값
 */
export function getSelectedNumberRamp(dom: AppDom): NumberEditRamp {
  const selectedButton = dom.numberRampButtons.find(
    (button) => button.getAttribute("aria-pressed") === "true",
  );
  const ramp = selectedButton?.dataset.ramp;

  if (ramp === "start" || ramp === "end" || ramp === "endStart") {
    return ramp;
  }

  return "none";
}

/**
 * number ramp 버튼 그룹의 선택 상태를 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : ramp : 선택할 ramp 종류
 * - 반환값 : 없음
 */
export function setSelectedNumberRamp(dom: AppDom, ramp: NumberEditRamp): void {
  dom.numberRampButtons.forEach((button) => {
    const isSelected = button.dataset.ramp === ramp;

    button.setAttribute("aria-pressed", String(isSelected));
    button.classList.toggle("on", isSelected);
    button.classList.toggle("off", !isSelected);
  });
}

/**
 * ramp 종류를 global parser가 읽는 suffix token으로 변환한다.
 * - 인수 : ramp : number UI에서 선택된 ramp 종류
 * - 반환값 : rawText 뒤에 붙일 ramp token
 */
export function getNumberRampToken(ramp: NumberEditRamp): string {
  if (ramp === "start") {
    return "<";
  }

  if (ramp === "end") {
    return ">";
  }

  if (ramp === "endStart") {
    return "><";
  }

  return "";
}

/**
 * number UI 입력값을 전역 number 셀에 사용할 수 있는 숫자 문자열로 정규화한다.
 * - 인수 : value : number input에 들어온 원본 문자열
 * - 반환값 : 숫자와 첫 번째 소수점만 남긴 문자열
 */
export function normalizeNumberRawInput(value: string): string {
  const numericText = value.replace(/[^\d.]/g, "");
  const dotIndex = numericText.indexOf(".");

  if (dotIndex < 0) {
    return numericText;
  }

  // BPM은 실수 입력을 허용하므로 첫 번째 소수점은 유지하고, 이후 소수점만 제거한다.
  return `${numericText.slice(0, dotIndex + 1)}${numericText.slice(dotIndex + 1).replace(/\./g, "")}`;
}

/**
 * number UI 입력값을 클릭한 global row에 적용할 rawText로 만든다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 인수 : hit : 사용자가 선택한 score 좌표
 * - 반환값 : 적용할 rawText 또는 blocked reason
 */
export function composeNumberRawTextForHit(
  dom: AppDom,
  state: AppState,
  hit: ScoreHit,
):
  | {
      kind: "apply";
      rawText: string;
    }
  | {
      kind: "blocked";
      message: string;
    } {
  if (hit.rowKind !== "global") {
    return {
      kind: "blocked",
      message: "Number input can only edit global rows.",
    };
  }

  const numberText = dom.numberRawInput.value.trim();

  if (numberText.length === 0) {
    return {
      kind: "blocked",
      message: "Number input is empty.",
    };
  }

  const row = state.document.indexes.rowById.get(hit.rowId);

  if (row?.type !== "global") {
    return {
      kind: "blocked",
      message: "Selected row is not a global row.",
    };
  }

  const ramp = getSelectedNumberRamp(dom);

  if (
    ramp !== "none" &&
    row.kind !== "bpm" &&
    row.kind !== "dynamics"
  ) {
    return {
      kind: "blocked",
      message: `${row.kind} does not allow tempo mark tokens.`,
    };
  }

  return {
    kind: "apply",
    rawText: `${numberText}${getNumberRampToken(ramp)}`,
  };
}
