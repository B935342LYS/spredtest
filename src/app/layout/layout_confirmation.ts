/** Layout Editor와 toolbar 프리셋이 공유하는 셀 삭제 확인 경계. */
import type { ScoreFile } from "../../core/score/types";
import { formatPitchName } from "../pitch_label";
import { calculateLayoutCellDeletionSummary } from "./layout_apply";
import type { LayoutDraftBundle } from "./layout_types";

/**
 * 모든 트랙의 삭제 대상을 다시 집계하여 행별 안내와 함께 적용 동의를 요청한다.
 * - 인수 : score : 적용 전 현재 악보
 * - 인수 : draft : 적용할 최종 레이아웃
 * - 인수 : confirm : 확인창을 표시하고 사용자 응답을 반환하는 함수
 * - 인수 : label : 적용할 레이아웃의 표시 이름
 * - 반환값 : 삭제가 없거나 사용자가 승인하면 true. 악보와 draft는 수정하지 않는다.
 */
export function confirmLayoutCellDeletion(
  score: ScoreFile,
  draft: LayoutDraftBundle,
  confirm: (message: string) => boolean,
  label = "This layout change",
): boolean {
  const summary = calculateLayoutCellDeletionSummary(score, draft);
  if (summary.totalCount === 0) return true;

  // ID 문자열을 해석하지 않고 원본 행 정의에서 string과 실제 음정을 읽는다.
  const rowsById = new Map(score.layout.rowDefinitions.map((row) => [row.rowId, row]));
  const details = Object.entries(summary.countByRowId).map(([rowId, count]) => {
    const row = rowsById.get(rowId);
    const pitch = row?.type === "note"
      ? ` (${row.stringId}, ${formatPitchName(row.midi, "sharp")}, MIDI ${row.midi})`
      : "";
    return `${rowId}${pitch}: ${count} cell(s)`;
  });
  return confirm(`${label} will delete ${summary.totalCount} track cell(s).\n${details.join("\n")}\nContinue?`);
}
