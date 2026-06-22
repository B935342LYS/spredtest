/**
 * tuplet edit draft와 finalize용 rawText 합성 경계를 정의한다.
 * 실제 slot 입력 UI는 후속 단계에서 이 모듈에 연결한다.
 */

import { MAX_CELL_RAW_TEXT_LENGTH } from "../../core/score/score_limits";

/**
 * tuplet slot 하나의 edit draft.
 * - 인수 : 없음
 * - 반환값 : finalize 전 slot 입력 상태
 */
export type TupletSlotDraft = {
  slotIndex: number;
  text: string;
};

/**
 * tuplet 전체 edit draft.
 * - 인수 : 없음
 * - 반환값 : `/n(...)` rawText 생성 전 임시 상태
 */
export type TupletEditDraft = {
  divNum: number;
  slots: TupletSlotDraft[];
  activeSlotIndex: number | null;
};

/**
 * tuplet draft를 rawText로 합성한 결과.
 * - 인수 : 없음
 * - 반환값 : finalize 가능 여부와 rawText 또는 blocked reason
 */
export type TupletRawTextResult =
  | {
      kind: "rawText";
      rawText: string;
    }
  | {
      kind: "notReady";
      message: string;
    };

/**
 * tuplet draft를 `/n(...)` rawText로 합성한다.
 * - 인수 : draft : slot 입력을 포함한 tuplet draft
 * - 반환값 : rawText 또는 아직 finalize할 수 없는 이유
 */
export function composeTupletRawText(draft: TupletEditDraft): TupletRawTextResult {
  if (!Number.isInteger(draft.divNum) || draft.divNum < 2) {
    return {
      kind: "notReady",
      message: "Tuplet division must be an integer greater than or equal to 2.",
    };
  }

  const slots = Array.from({ length: draft.divNum }, (_, slotIndex) => {
    const slot = draft.slots.find((candidate) => candidate.slotIndex === slotIndex);

    return slot?.text ?? "";
  });

  if (slots.length !== draft.divNum) {
    return {
      kind: "notReady",
      message: "Tuplet slot count must match division number.",
    };
  }

  const rawText = `/${draft.divNum}(${slots.join("|")})`;

  if (rawText.length > MAX_CELL_RAW_TEXT_LENGTH) {
    return {
      kind: "notReady",
      message: `Tuplet rawText must be ${MAX_CELL_RAW_TEXT_LENGTH} characters or fewer.`,
    };
  }

  // slot 내부 문법은 note parser가 최종 검증하므로 여기서는 tuplet head wrapper만 합성한다.
  return {
    kind: "rawText",
    rawText,
  };
}
