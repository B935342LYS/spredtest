/**
 * app shell의 보기 조작, fullscreen, details dialog 값을 다루는 helper이다.
 */

import type { MusicData } from "../core/score/types";
import { MAX_SCORE_COMMENT_LENGTH } from "../core/score/score_limits";
import type {
  AppDom,
  AppState,
  UiStatusMessage,
} from "./app_types";

const DEFAULT_MIN_ZOOM_PERCENT = 50;
const COMPACT_MIN_ZOOM_PERCENT = 20;
const ZOOM_PERCENT_FRACTION_DIGITS = 3;

/**
 * zoom input 값을 허용 범위 안의 percent 값으로 설정한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : zoomPercent : 적용할 zoom percent
 * - 인수 : minZoomPercent : 선택적으로 강제할 최소 zoom percent
 * - 반환값 : 없음
 */
export function setZoomPercent(
  dom: AppDom,
  zoomPercent: number,
  minZoomPercent?: number,
): void {
  const min = Number(dom.zoomInput.min);
  const max = Number(dom.zoomInput.max);
  const normalizedMin = minZoomPercent ?? (Number.isFinite(min) ? min : 1);
  const normalizedZoomPercent = Number.isFinite(zoomPercent)
    ? zoomPercent
    : normalizedMin;
  const boundedZoom = Math.min(
    Math.max(normalizedZoomPercent, normalizedMin),
    Number.isFinite(max) ? max : 200,
  );

  dom.zoomInput.value = formatZoomPercentValue(boundedZoom);
}

/**
 * zoom percent를 input value에 넣을 소수 문자열로 정규화한다.
 * - 인수 : zoomPercent : input value로 저장할 zoom percent
 * - 반환값 : 불필요한 0을 제거한 percent 문자열
 */
function formatZoomPercentValue(zoomPercent: number): string {
  return zoomPercent
    .toFixed(ZOOM_PERCENT_FRACTION_DIGITS)
    .replace(/\.?0+$/, "");
}

/**
 * score area가 사용할 수 있는 세로 높이를 현재 app shell 배치에서 계산한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : CSS pixel 기준 fit height 목표 높이
 */
export function getScoreAreaFitTargetHeight(dom: AppDom): number {
  const scoreAreaRect = dom.scoreArea.getBoundingClientRect();
  const scoreViewerRect = dom.scoreViewer.getBoundingClientRect();
  const statusArea = dom.appShell.querySelector<HTMLElement>(".status-area");

  if (statusArea !== null) {
    const statusRect = statusArea.getBoundingClientRect();
    const availableHeight = statusRect.top - scoreAreaRect.top;
    const visibleScoreAreaHeight = dom.scoreArea.clientHeight;

    // score 영역의 바닥 기준은 status footer의 실제 윗면으로 삼는다.
    if (Number.isFinite(availableHeight) && availableHeight > 0) {
      // clientHeight는 가로 스크롤바가 차지한 내부 높이를 제외하므로 fit 후 세로 overflow를 막는다.
      if (Number.isFinite(visibleScoreAreaHeight) && visibleScoreAreaHeight > 0) {
        return Math.min(availableHeight, visibleScoreAreaHeight);
      }

      return availableHeight;
    }
  }

  return Math.max(
    0,
    ...[
      scoreViewerRect.height,
      dom.scoreArea.clientHeight,
    ].filter((height) => Number.isFinite(height) && height > 0),
  );
}

/**
 * score 전체 높이가 현재 viewport 높이에 맞도록 zoom 값을 계산한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 성공 여부와 사용자 상태 메시지
 */
export function fitScoreHeightZoom(
  dom: AppDom,
  state: AppState,
): UiStatusMessage {
  const baseStageHeight = state.renderInput.rows.reduce(
    (sum, row) => sum + Math.max(0, row.height),
    0,
  );
  const targetHeight = getScoreAreaFitTargetHeight(dom);

  if (baseStageHeight <= 0 || targetHeight <= 0) {
    return {
      level: "warning",
      text: "Fit Height needs a visible score area.",
    };
  }

  const minZoomPercent = getFitHeightMinZoomPercent();
  const fitZoomPercent = (targetHeight / baseStageHeight) * 100;

  dom.zoomInput.min = String(minZoomPercent);
  setZoomPercent(dom, fitZoomPercent, minZoomPercent);

  return {
    level: "info",
    text: `Fit Height: ${dom.zoomInput.value}%`,
  };
}

/**
 * fit height가 사용할 최소 zoom percent를 현재 viewport 조건에 맞춰 고른다.
 * - 인수 : 없음
 * - 반환값 : 세로가 좁은 모바일형 화면이면 더 낮은 최소 zoom, 아니면 기본 최소 zoom
 */
function getFitHeightMinZoomPercent(): number {
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 900px) and (max-height: 760px)").matches
  ) {
    return COMPACT_MIN_ZOOM_PERCENT;
  }

  return DEFAULT_MIN_ZOOM_PERCENT;
}

/**
 * fullscreen 상태에 맞춰 버튼 문구를 동기화한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
export function syncFullscreenButton(dom: AppDom): void {
  dom.fullscreenButton.textContent =
    document.fullscreenElement === dom.appShell ? "Exit Fullscreen" : "Fullscreen";
}

/**
 * HTML number input에서 정수 값을 읽고 실패하면 fallback을 반환한다.
 * - 인수 : input : 읽을 number input
 * - 인수 : fallback : 숫자로 해석할 수 없을 때 사용할 값
 * - 반환값 : 정수 입력값 또는 fallback
 */
export function readIntegerInput(input: HTMLInputElement, fallback: number): number {
  const value = Number.parseInt(input.value, 10);

  return Number.isFinite(value) ? value : fallback;
}

/**
 * details dialog 입력칸을 현재 musicData 값으로 채운다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : musicData : 현재 ScoreFile metadata
 * - 반환값 : 없음
 */
export function populateDetailsDialog(dom: AppDom, musicData: MusicData): void {
  // Details dialog는 편집 가능한 metadata와 읽기 전용 timestamp를 함께 현재 score 값으로 채운다.
  dom.detailsTitleInput.value = musicData.musicTitle;
  dom.detailsArtistInput.value = musicData.musicArtist;
  dom.detailsGenreInput.value = musicData.musicGenre;
  dom.detailsWriterInput.value = musicData.scoreWriter;
  dom.detailsCommentInput.value = musicData.comment;
  dom.detailsCreatedAtInput.value = musicData.createdAt;
  dom.detailsUpdatedAtInput.value = musicData.updatedAt;
  dom.detailsBasicDifficultyInput.value = String(musicData.scoreDifficulty.basic);
  dom.detailsOptionalDifficultyInput.value = String(musicData.scoreDifficulty.optional);
  dom.detailsExtraDifficultyInput.value = String(musicData.scoreDifficulty.extra);
}

/**
 * details dialog 입력값을 MusicData 교체값으로 읽는다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : currentMusicData : 유지할 기존 metadata 기본값
 * - 반환값 : details dialog 입력값이 반영된 MusicData
 */
export function readDetailsDialogMusicData(
  dom: AppDom,
  currentMusicData: MusicData,
): MusicData {
  return {
    ...currentMusicData,
    musicTitle: dom.detailsTitleInput.value,
    musicArtist: dom.detailsArtistInput.value,
    musicGenre: dom.detailsGenreInput.value,
    scoreWriter: dom.detailsWriterInput.value,
    comment: dom.detailsCommentInput.value.slice(0, MAX_SCORE_COMMENT_LENGTH),
    scoreDifficulty: {
      basic: readIntegerInput(
        dom.detailsBasicDifficultyInput,
        currentMusicData.scoreDifficulty.basic,
      ),
      optional: readIntegerInput(
        dom.detailsOptionalDifficultyInput,
        currentMusicData.scoreDifficulty.optional,
      ),
      extra: readIntegerInput(
        dom.detailsExtraDifficultyInput,
        currentMusicData.scoreDifficulty.extra,
      ),
    },
  };
}

/**
 * app shell fullscreen을 전환한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : onError : fullscreen API 실패 시 호출할 오류 handler
 * - 반환값 : 없음
 */
export function toggleFullscreen(
  dom: AppDom,
  onError: (message: string) => void,
): void {
  if (document.fullscreenElement === dom.appShell) {
    document.exitFullscreen()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown fullscreen error.";

        onError(message);
      });
    return;
  }

  dom.appShell.requestFullscreen()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown fullscreen error.";

      onError(message);
    });
}
