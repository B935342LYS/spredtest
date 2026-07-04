/**
 * score pointer 편집 중 반복 클릭 cycle과 drag edit 목록 생성을 담당한다.
 */

import type {
  ScoreHit,
  ScoreSelection,
} from "../app_types";
import type { ScoreTextEdit } from "./edit_apply";

/** 같은 cell 반복 클릭에서 current -> hold -> vib hold 순환을 추적하는 상태. */
export type RepeatedClickCycleState = {
  targetKey: string;
  baseRawText: string;
  nextStep: 0 | 1 | 2;
};

/** pointer drag 편집 중 누적 edit와 마지막 hit를 보관하는 상태. */
export type DragEditState = {
  pointerId: number;
  button: 0 | 2;
  startClientX: number;
  startClientY: number;
  startHit: ScoreHit | null;
  lockedRowKind: ScoreHit["rowKind"] | null;
  lastHit: ScoreHit | null;
  canDrag: boolean;
  isDragging: boolean;
  edits: Map<string, ScoreTextEdit>;
};

/** drag edit helper가 selection과 rawText 합성을 app 상태에서 위임받기 위한 입력. */
export type DragEditCreateInput = {
  getSelectionForHit: (hit: ScoreHit) => ScoreSelection;
  composeDragRawTextForHit: (
    hit: ScoreHit,
    button: 0 | 2,
  ) =>
    | {
        kind: "apply";
        rawText: string;
      }
    | {
        kind: "blocked";
        message: string;
      };
};

/**
 * score edit target을 중복 검사 key로 만든다.
 * - 인수 : selection : track까지 포함된 score 선택 좌표
 * - 반환값 : track,row,col을 합친 key
 */
export function getEditTargetKey(selection: ScoreSelection): string {
  return `${selection.trackId}|${selection.rowId}|${selection.col}`;
}

/**
 * ScoreTextEdit의 selection에서 중복 검사 key를 만든다.
 * - 인수 : edit : rawText 편집 명령
 * - 반환값 : track,row,col을 합친 key
 */
export function getScoreTextEditKey(edit: ScoreTextEdit): string {
  return getEditTargetKey(edit.selection);
}

/**
 * rawText 끝에 붙은 pitch modifier suffix를 추출한다.
 * - 인수 : rawText : note cell rawText
 * - 반환값 : @p/@m suffix 문자열
 */
export function extractPitchModifierSuffix(rawText: string): string {
  const pitchTokenSuffix = rawText.match(/(?:@(?:p|m)\([^)]*\))+$/);

  return pitchTokenSuffix?.[0] ?? "";
}

/**
 * 기존 cell rawText를 기준으로 drag 입력 rawText를 current/hold/vib hold로 순환한다.
 * - 인수 : existingRawText : 현재 cell에 저장된 rawText
 * - 인수 : baseRawText : edit panel에서 합성한 기본 rawText
 * - 반환값 : 이번 drag 위치에 적용할 rawText
 */
export function cycleRawTextFromExistingCell(
  existingRawText: string,
  baseRawText: string,
): string {
  const normalized = existingRawText.trim();
  const pitchModifierSuffix = extractPitchModifierSuffix(baseRawText);

  if (normalized.length === 0) {
    return baseRawText;
  }

  if (normalized.startsWith("-")) {
    return `~${pitchModifierSuffix}`;
  }

  if (normalized.startsWith("~")) {
    return baseRawText;
  }

  return `-${pitchModifierSuffix}`;
}

/**
 * 같은 cell 반복 클릭 cycle 상태를 한 단계 전진하고 적용 rawText를 반환한다.
 * - 인수 : cycleState : 현재 반복 클릭 cycle 상태
 * - 인수 : hit : 클릭한 score 좌표
 * - 인수 : baseRawText : edit panel에서 합성한 기본 rawText
 * - 인수 : existingRawText : 현재 cell에 저장된 rawText
 * - 인수 : getSelectionForHit : hit를 active track selection으로 바꾸는 함수
 * - 반환값 : 다음 cycle 상태와 이번 클릭에 적용할 rawText
 */
export function advanceRepeatedClickCycle(
  cycleState: RepeatedClickCycleState | null,
  hit: ScoreHit,
  baseRawText: string,
  existingRawText: string,
  getSelectionForHit: (hit: ScoreHit) => ScoreSelection,
): {
  cycleState: RepeatedClickCycleState;
  rawText: string;
} {
  const selection = getSelectionForHit(hit);
  const targetKey = getEditTargetKey(selection);
  const pitchModifierSuffix = extractPitchModifierSuffix(baseRawText);

  if (
    cycleState === null ||
    cycleState.targetKey !== targetKey ||
    cycleState.baseRawText !== baseRawText
  ) {
    const rawText = cycleRawTextFromExistingCell(existingRawText, baseRawText);

    return {
      cycleState: {
        targetKey,
        baseRawText,
        nextStep: getNextRepeatedClickStep(rawText, baseRawText),
      },
      rawText,
    };
  }

  if (cycleState.nextStep === 1) {
    return {
      cycleState: {
        ...cycleState,
        nextStep: 2,
      },
      rawText: `-${pitchModifierSuffix}`,
    };
  }

  if (cycleState.nextStep === 2) {
    return {
      cycleState: {
        ...cycleState,
        nextStep: 0,
      },
      rawText: `~${pitchModifierSuffix}`,
    };
  }

  return {
    cycleState: {
      ...cycleState,
      nextStep: 1,
    },
    rawText: baseRawText,
  };
}

/**
 * 이번 클릭으로 적용한 rawText 다음에 이어질 반복 클릭 단계를 계산한다.
 * - 인수 : appliedRawText : 이번 클릭으로 적용한 rawText
 * - 인수 : baseRawText : edit panel에서 합성한 기본 rawText
 * - 반환값 : 다음 클릭에서 적용할 cycle 단계
 */
function getNextRepeatedClickStep(
  appliedRawText: string,
  baseRawText: string,
): RepeatedClickCycleState["nextStep"] {
  const pitchModifierSuffix = extractPitchModifierSuffix(baseRawText);

  if (appliedRawText === `-${pitchModifierSuffix}`) {
    return 2;
  }

  if (appliedRawText === `~${pitchModifierSuffix}`) {
    return 0;
  }

  return 1;
}

/**
 * pointer 이동량이 drag 시작 기준을 넘었는지 확인한다.
 * - 인수 : dragState : 현재 pointer drag 상태
 * - 인수 : event : pointermove event
 * - 인수 : startDistancePx : drag로 볼 최소 이동 거리
 * - 반환값 : drag를 시작해야 하면 true
 */
export function shouldStartDragEdit(
  dragState: DragEditState | null,
  event: PointerEvent,
  startDistancePx: number,
): boolean {
  if (dragState === null || dragState.isDragging || !dragState.canDrag) {
    return false;
  }

  const deltaX = event.clientX - dragState.startClientX;
  const deltaY = event.clientY - dragState.startClientY;

  return Math.hypot(deltaX, deltaY) >= startDistancePx;
}

/**
 * 단일 hit에 대응하는 drag edit를 만든다.
 * - 인수 : dragState : 현재 pointer drag 상태
 * - 인수 : hit : 추가할 score 좌표
 * - 인수 : input : selection/rawText 생성을 위한 app 의존 함수 묶음
 * - 반환값 : 새 edit 또는 이미 처리/blocked된 경우 null
 */
export function createDragEditForHit(
  dragState: DragEditState,
  hit: ScoreHit,
  input: DragEditCreateInput,
): ScoreTextEdit | null {
  const selection = input.getSelectionForHit(hit);
  const editKey = getEditTargetKey(selection);

  if (dragState.edits.has(editKey)) {
    return null;
  }

  const rawTextResult = input.composeDragRawTextForHit(hit, dragState.button);

  if (rawTextResult.kind === "blocked") {
    return null;
  }

  return {
    selection,
    rawText: rawTextResult.rawText,
  };
}

/**
 * drag 이동 중 누락된 중간 column까지 보간해 edit 목록을 추가한다.
 * - 인수 : dragState : 현재 pointer drag 상태
 * - 인수 : hit : 현재 pointer가 가리키는 score 좌표
 * - 인수 : input : selection/rawText 생성을 위한 app 의존 함수 묶음
 * - 반환값 : 이번 hit로 새로 추가된 edit 목록
 */
export function addDragEditForHit(
  dragState: DragEditState,
  hit: ScoreHit,
  input: DragEditCreateInput,
): ScoreTextEdit[] {
  const edits: ScoreTextEdit[] = [];

  if (
    dragState.lockedRowKind !== null &&
    hit.rowKind !== dragState.lockedRowKind
  ) {
    return edits;
  }

  if (dragState.lockedRowKind === null) {
    dragState.lockedRowKind = hit.rowKind;
  }

  // 같은 행에서 빠르게 이동해 중간 열 hit가 누락된 경우 이전 열과 현재 열 사이를 채운다.
  if (dragState.lastHit !== null && dragState.lastHit.rowId === hit.rowId) {
    const startCol = Math.min(dragState.lastHit.col, hit.col);
    const endCol = Math.max(dragState.lastHit.col, hit.col);

    for (let col = startCol; col <= endCol; col += 1) {
      const interpolatedEdit = createDragEditForHit(dragState, {
        ...hit,
        col,
      }, input);

      if (interpolatedEdit !== null) {
        dragState.edits.set(getScoreTextEditKey(interpolatedEdit), interpolatedEdit);
        edits.push(interpolatedEdit);
      }
    }
  } else {
    const edit = createDragEditForHit(dragState, hit, input);

    if (edit !== null) {
      dragState.edits.set(getScoreTextEditKey(edit), edit);
      edits.push(edit);
    }
  }

  dragState.lastHit = hit;

  return edits;
}
