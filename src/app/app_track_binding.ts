/**
 * track layer toggle UI를 AppState와 playback runtime 갱신 흐름에 연결한다.
 */

import type { TrackId } from "../core/score/types";
import { isTrackId, TRACK_UI_ORDER } from "../track/track_control";
import { applyActiveTrackIdsToState } from "./app_runtime";
import type { AppDom, AppState } from "./app_types";
import { isGameModeTrackChangeLocked } from "./game/game_types";
import { syncLeftStatus, syncTrackToggleButtons } from "./app_ui_sync";
import type { AppPlaybackRuntime } from "./playback/app_playback";

/** track binding이 app 상태와 playback runtime에 접근하기 위한 session 입력. */
export type TrackBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  render(): void;
  getPlaybackRuntime(): AppPlaybackRuntime;
  resetPlaybackForCurrentState(): void;
  resetPlaybackForCurrentStatePausedAt(scoreSeconds: number): void;
};

/**
 * Track 메뉴의 active toggle을 app 상태에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 playback reset callback 묶음
 * - 반환값 : 없음
 */
export function bindTrackControls(
  dom: AppDom,
  session: TrackBindingSession,
): void {
  for (const button of dom.trackToggleButtons) {
    button.addEventListener("click", () => {
      const trackId = readButtonTrackId(button);

      if (trackId === null) {
        return;
      }

      const playbackState = session.getPlaybackRuntime().controller.getState();

      if (isGameModeTrackChangeLocked(session.getState().gameMode)) {
        session.setState({
          ...session.getState(),
          statusMessage: {
            level: "warning",
            text: "Stop practice playback before changing active tracks.",
          },
        });
        syncLeftStatus(dom, session.getState());
        syncTrackToggleButtons(dom, session.getState());
        return;
      }

      if (playbackState.kind === "playing") {
        session.setState({
          ...session.getState(),
          statusMessage: {
            level: "warning",
            text: "Pause or stop playback before changing active tracks.",
          },
        });
        syncLeftStatus(dom, session.getState());
        syncTrackToggleButtons(dom, session.getState(), true);
        return;
      }

      const nextActiveTrackIds = toggleActiveTrackId(
        session.getState().activeTrackIds,
        trackId,
      );

      session.setState(applyActiveTrackIdsToState(
        session.getState(),
        nextActiveTrackIds,
      ));
      session.render();
      if (playbackState.kind === "paused") {
        session.resetPlaybackForCurrentStatePausedAt(playbackState.pausedAtScoreSeconds);
      } else {
        session.resetPlaybackForCurrentState();
      }
    });
  }
}

/**
 * 현재 active track 목록에서 하나의 track을 on/off한다.
 * - 인수 : activeTrackIds : 현재 active track 목록
 * - 인수 : trackId : 토글할 track id
 * - 반환값 : UI 표시 순서로 정렬된 다음 active track 목록
 */
export function toggleActiveTrackId(
  activeTrackIds: readonly TrackId[],
  trackId: TrackId,
): TrackId[] {
  const activeSet = new Set(activeTrackIds);

  if (activeSet.has(trackId)) {
    activeSet.delete(trackId);
  } else {
    activeSet.add(trackId);
  }

  // active 0개를 허용하되, 표시와 저장 순서는 UI 고정 순서로 정규화한다.
  return TRACK_UI_ORDER.filter((candidate) => activeSet.has(candidate));
}

/**
 * track toggle button의 data-track-id를 TrackId로 좁힌다.
 * - 인수 : button : track toggle DOM 버튼
 * - 반환값 : 유효한 TrackId 또는 null
 */
function readButtonTrackId(button: HTMLButtonElement): TrackId | null {
  const trackId = button.dataset.trackId;

  if (trackId === undefined || !isTrackId(trackId)) {
    return null;
  }

  return trackId;
}
