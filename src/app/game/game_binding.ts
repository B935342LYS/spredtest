/**
 * practice mode 버튼과 게임 모드 skeleton 상태를 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import { syncLeftStatus, syncUiControls } from "../app_ui_sync";
import { syncGamePitchOverlay } from "./game_pitch_overlay";
import { createGamePitchInputRuntime, type GamePitchInputRuntime } from "./game_pitch_input";
import { createEmptyGameScoreSummary, type GamePitchFrame } from "./game_types";

/** 게임 모드 binding이 app 상태를 읽고 갱신하기 위한 session 입력. */
export type GameBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  render(): void;
};

/**
 * 현재 브라우저에서 마이크 권한 요청 API를 사용할 수 있는지 확인한다.
 * - 인수 : 없음
 * - 반환값 : getUserMedia 사용 가능 여부
 */
function canRequestMicrophone(): boolean {
  return navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === "function";
}

/**
 * 마이크 stream의 모든 track을 중지한다.
 * - 인수 : stream : 중지할 MediaStream 또는 null
 * - 반환값 : 없음
 */
function stopMicrophoneStream(stream: MediaStream | null): void {
  if (stream === null) {
    return;
  }

  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/**
 * 게임 모드 DOM event를 app 상태에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 render callback 묶음
 * - 반환값 : 없음
 */
export function bindGameModeControls(
  dom: AppDom,
  session: GameBindingSession,
): void {
  let microphoneStream: MediaStream | null = null;
  let pitchInputRuntime: GamePitchInputRuntime | null = null;
  let requestId = 0;

  const updatePitchFrame = (frame: GamePitchFrame): void => {
    const state = session.getState();

    if (
      state.gameMode.kind !== "ready" &&
      state.gameMode.kind !== "countdown" &&
      state.gameMode.kind !== "playing" &&
      state.gameMode.kind !== "paused" &&
      state.gameMode.kind !== "finished"
    ) {
      return;
    }

    session.setState({
      ...state,
      gameMode: {
        ...state.gameMode,
        pitchFrame: frame,
      },
    });
    syncGamePitchOverlay(dom, session.getState());
  };

  const exitPracticeMode = (): void => {
    const state = session.getState();

    requestId += 1;
    pitchInputRuntime?.dispose();
    pitchInputRuntime = null;
    stopMicrophoneStream(microphoneStream);
    microphoneStream = null;
    session.setState({
      ...state,
      gameMode: { kind: "off" },
      statusMessage: {
        level: "info",
        text: "Practice mode exited.",
      },
    });
    syncLeftStatus(dom, session.getState());
    syncUiControls(dom, session.getState());
  };

  dom.gameRulesButton.addEventListener("click", () => {
    dom.practiceRulesDialog.showModal();
  });

  dom.practiceModeButton.addEventListener("click", () => {
    const state = session.getState();

    if (state.gameMode.kind !== "off") {
      exitPracticeMode();
      return;
    }

    const currentRequestId = requestId + 1;

    if (state.busy.kind !== "idle") {
      return;
    }

    if (!canRequestMicrophone()) {
      session.setState({
        ...state,
        gameMode: {
          kind: "error",
          message: "Microphone input is not available in this browser.",
        },
        statusMessage: {
          level: "error",
          text: "Microphone input is not available in this browser.",
        },
      });
      session.render();
      return;
    }

    requestId = currentRequestId;
    session.setState({
      ...state,
      mode: { kind: "view" },
      loop: {
        ...state.loop,
        enabled: false,
        pickMode: null,
      },
      rangeSelection: null,
      pastePreview: {
        anchorCol: null,
      },
      gameMode: {
        kind: "preparing",
        message: "Requesting microphone...",
      },
      statusMessage: {
        level: "info",
        text: "Requesting microphone permission...",
      },
    });
    session.render();

    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    })
      .then((stream) => {
        if (requestId !== currentRequestId || session.getState().gameMode.kind === "off") {
          stopMicrophoneStream(stream);
          return;
        }

        microphoneStream = stream;
        pitchInputRuntime?.dispose();
        pitchInputRuntime = createGamePitchInputRuntime(
          stream,
          () => session.getState().layout,
          updatePitchFrame,
        );
        const currentState = session.getState();

        session.setState({
          ...currentState,
          gameMode: {
            kind: "ready",
            summary: createEmptyGameScoreSummary(),
            pitchFrame: null,
          },
          statusMessage: {
            level: "info",
            text: "Practice mode is ready.",
          },
        });
        session.render();
      })
      .catch((error: unknown) => {
        if (requestId !== currentRequestId || session.getState().gameMode.kind === "off") {
          return;
        }

        const currentState = session.getState();
        const message = error instanceof Error
          ? error.message
          : "Microphone permission was not granted.";

        stopMicrophoneStream(microphoneStream);
        pitchInputRuntime?.dispose();
        pitchInputRuntime = null;
        microphoneStream = null;
        session.setState({
          ...currentState,
          gameMode: {
            kind: "error",
            message,
          },
          statusMessage: {
            level: "error",
            text: message,
          },
        });
        session.render();
      });
  });
}
