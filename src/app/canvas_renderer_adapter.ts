/**
 * core score RuntimeDocument를 renderer-owned CanvasRenderInput으로 변환한다.
 */

import type { GlobalKind, RuntimeDocument } from "../core/score/types";
import type {
  CanvasRenderInput,
  CanvasSourceRow,
} from "../renderer/canvas_types";

const GLOBAL_LABEL_BY_KIND: Record<GlobalKind, string> = {
  bpm: "BPM",
  beatsPerBar: "BeatsPerBar",
  stepsPerBeat: "StepsPerBeat",
  dynamics: "Dynamics",
};

/**
 * RuntimeDocument의 layout row를 renderer source row로 변환한다.
 * - 인수 : document : score와 index가 묶인 런타임 문서
 * - 반환값 : renderer가 core 타입 없이 소비할 수 있는 CanvasRenderInput
 */
export function createCanvasRenderInput(
  document: RuntimeDocument,
): CanvasRenderInput {
 
  // rows에 layout의 row definition을 순회하며 각 row의 type에 따라 renderer source row로 변환한다.
  const rows: CanvasSourceRow[] =
    document.score.layout.rowDefinitions.map((row) => {
      // row type이 global인 경우 
      if (row.type === "global") {
        return {
          rowId: row.rowId,
          kind: "global",
          label: GLOBAL_LABEL_BY_KIND[row.kind],
          height: row.height,
        };
      }
      // row type이 note인 경우
      if (row.type === "note") {
        return {
          rowId: row.rowId,
          kind: "note",
          label: row.displayLabel,
          midi: row.midi,
          height: row.height,
        };
      }
      // row type이 gap인 경우. 갭 행은 빈 공간을 표시하는 용도이므로 표시용 문자열이 필요하지 않다.
      return {
        rowId: row.rowId,
        kind: "gap",
        label: "",
        height: row.height,
      };
    });

  // 만들어진 rows 배열과 열의 개수, 너비를 묶어서 반환한다. 모든 열은 동일한 너비를 가진다.
  return {
    rows,
    columnCount: document.score.globalLines.columnCount,
    baseColumnWidthPx: document.score.layout.baseColumnWidthPx,
  };
}
