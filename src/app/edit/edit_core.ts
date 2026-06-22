/**
 * edit 입력 상태를 최종 score cell 적용 명령으로 합성하는 진입점이다.
 * DOM과 ScoreFile mutation은 직접 다루지 않는다.
 */

import {
  composeDefaultNoteRawText,
  hasDefaultNoteModifiers,
  isEmptyDefaultText,
  validateDefaultNoteEditInput,
  type DefaultNoteEditInput,
} from "./edit_default";
import {
  composeTupletRawText,
  type TupletEditDraft,
} from "./edit_tuplet";

/**
 * edit rawText 합성 요청.
 * - 인수 : 없음
 * - 반환값 : default note 또는 tuplet edit 입력 상태
 */
export type EditRawTextRequest =
  | {
      kind: "default";
      input: DefaultNoteEditInput;
    }
  | {
      kind: "tuplet";
      draft: TupletEditDraft;
    };

/**
 * edit 입력을 score cell에 적용할 최종 명령으로 좁힌 결과.
 * - 인수 : 없음
 * - 반환값 : rawText 적용, cell 삭제, 또는 아직 적용 불가한 상태
 */
export type EditRawTextResult =
  | {
      kind: "apply";
      rawText: string;
    }
  | {
      kind: "delete";
    }
  | {
      kind: "blocked";
      message: string;
    };

/**
 * 현재 edit 입력을 score cell 적용 명령으로 합성한다.
 * - 인수 : request : 현재 edit tool이 제공한 입력 상태
 * - 반환값 : rawText 적용, 삭제, 또는 blocked 결과
 */
export function composeEditRawText(request: EditRawTextRequest): EditRawTextResult {
  if (request.kind === "default") {
    const blockedMessage = validateDefaultNoteEditInput(request.input);

    if (blockedMessage !== null) {
      return {
        kind: "blocked",
        message: blockedMessage,
      };
    }

    if (request.input.mode === "eraser") {
      return { kind: "delete" };
    }

    // 빈 CUSTOM 입력은 modifier도 없을 때만 기존 cell 삭제 명령으로 취급한다.
    if (
      request.input.mode === "custom" &&
      isEmptyDefaultText(request.input.customText) &&
      !hasDefaultNoteModifiers(request.input)
    ) {
      return { kind: "delete" };
    }

    return {
      kind: "apply",
      rawText: composeDefaultNoteRawText(request.input),
    };
  }

  const tupletResult = composeTupletRawText(request.draft);

  if (tupletResult.kind === "notReady") {
    return {
      kind: "blocked",
      message: tupletResult.message,
    };
  }

  return {
    kind: "apply",
    rawText: tupletResult.rawText,
  };
}
