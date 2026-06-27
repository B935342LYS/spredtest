/**
 * practice mode 버튼과 게임 모드 skeleton 상태를 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import { syncLeftStatus, syncUiControls } from "../app_ui_sync";
import { saveGameSyncOffsetMsToLocalStorage } from "../../infra/game_preferences";
import { syncGameModeUi } from "./game_ui";
import { syncGamePitchOverlay } from "./game_pitch_overlay";
import { createGamePitchInputRuntime, type GamePitchInputRuntime } from "./game_pitch_input";
import {
  DEFAULT_GAME_SYNC_OFFSET_MS,
  GAME_SYNC_OFFSET_STEP_MS,
  createEmptyGameScoreSummary,
  type GamePitchFrame,
} from "./game_types";

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
 * 음악 pitch detection에 맞춘 마이크 입력 제약을 만든다.
 * - 인수 : 없음
 * - 반환값 : getUserMedia에 전달할 audio constraint
 */
function createMusicInputAudioConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 1 },
  };
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
  let syncAudioContext: AudioContext | null = null;
  let syncBeepIntervalId: number | null = null;
  let lastSyncBeatAtMs: number | null = null;
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
    syncGameModeUi(dom, session.getState());
    updateSyncMarker(frame);
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

  /**
   * Sync 값을 갱신하고 practice UI에 반영한다.
   * - 인수 : nextOffsetMs : 다음 Sync ms 값
   * - 반환값 : 없음
   */
  const setSyncOffset = (nextOffsetMs: number): void => {
    const state = session.getState();

    session.setState({
      ...state,
      gameSyncOffsetMs: saveGameSyncOffsetMsToLocalStorage(nextOffsetMs),
    });
    syncGameModeUi(dom, session.getState());
  };

  /**
   * Sync calibration beep loop를 중지한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const stopSyncBeepLoop = (): void => {
    if (syncBeepIntervalId !== null) {
      window.clearInterval(syncBeepIntervalId);
      syncBeepIntervalId = null;
    }

    dom.practiceSyncStartButton.textContent = "Start";
  };

  /**
   * Sync calibration용 짧은 beep와 기준선 flash를 실행한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const playSyncBeep = (): void => {
    const AudioContextConstructor = window.AudioContext;

    lastSyncBeatAtMs = performance.now();
    dom.practiceSyncBeat.classList.add("flash");
    window.setTimeout(() => {
      dom.practiceSyncBeat.classList.remove("flash");
    }, 120);

    if (AudioContextConstructor === undefined) {
      return;
    }

    syncAudioContext ??= new AudioContextConstructor();

    const audioContext = syncAudioContext;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;

    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.12);
  };

  /**
   * Sync calibration beep loop를 시작하거나 중지한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const toggleSyncBeepLoop = (): void => {
    if (syncBeepIntervalId !== null) {
      stopSyncBeepLoop();
      return;
    }

    playSyncBeep();
    syncBeepIntervalId = window.setInterval(playSyncBeep, 800);
    dom.practiceSyncStartButton.textContent = "Stop";
  };

  /**
   * 최신 pitch frame을 Sync calibration meter에 표시한다.
   * - 인수 : frame : 최신 pitch frame
   * - 반환값 : 없음
   */
  const updateSyncMarker = (frame: GamePitchFrame): void => {
    if (!dom.practiceSyncDialog.open || lastSyncBeatAtMs === null || !frame.isVoiced) {
      return;
    }

    const adjustedDeltaMs = frame.capturedAtMs - lastSyncBeatAtMs - session.getState().gameSyncOffsetMs;
    const clampedDeltaMs = Math.min(Math.max(adjustedDeltaMs, -400), 400);
    const leftPercent = 50 + (clampedDeltaMs / 400) * 45;

    dom.practiceSyncMarker.style.left = `${leftPercent}%`;
    dom.practiceSyncMarker.classList.add("visible");
  };

  dom.gameRulesButton.addEventListener("click", () => {
    dom.practiceRulesDialog.showModal();
  });

  dom.gameSyncButton.addEventListener("click", () => {
    syncGameModeUi(dom, session.getState());
    dom.practiceSyncDialog.showModal();
  });

  dom.practiceSyncCloseButton.addEventListener("click", () => {
    stopSyncBeepLoop();
    dom.practiceSyncDialog.close();
  });

  dom.practiceSyncDialog.addEventListener("close", () => {
    stopSyncBeepLoop();
  });

  dom.practiceSyncStartButton.addEventListener("click", toggleSyncBeepLoop);

  dom.practiceSyncMinusButton.addEventListener("click", () => {
    setSyncOffset(session.getState().gameSyncOffsetMs - GAME_SYNC_OFFSET_STEP_MS);
  });

  dom.practiceSyncPlusButton.addEventListener("click", () => {
    setSyncOffset(session.getState().gameSyncOffsetMs + GAME_SYNC_OFFSET_STEP_MS);
  });

  dom.practiceSyncResetButton.addEventListener("click", () => {
    setSyncOffset(DEFAULT_GAME_SYNC_OFFSET_MS);
    dom.practiceSyncMarker.classList.remove("visible");
  });

  dom.practiceSyncApplyButton.addEventListener("click", () => {
    stopSyncBeepLoop();
    dom.practiceSyncDialog.close();
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
      audio: createMusicInputAudioConstraints(),
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
