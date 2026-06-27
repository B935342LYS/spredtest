/**
 * playback 버튼, seek input, audio option event를 app playback runtime에 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import { syncLeftStatus, syncUiControls } from "../app_ui_sync";
import type { AppPlaybackRuntime } from "./app_playback";
import { createPlaybackLoopStateFromApp } from "./app_playback";
import type { AppNotePreviewRuntime } from "./app_note_preview";
import type { YoutubePlaybackControl } from "../youtube/youtube_binding";
import {
  createEmptyGameScoreSummary,
  isGameModeLocked,
  type GameScoreSummary,
} from "../game/game_types";
import { createGamePitchCorrectionState } from "../game/game_pitch_math";
import {
  applyGameScoringSample,
  collectGameJudgeTargetsAtSeconds,
  hasRemainingGameJudgeTarget,
  judgeGameScoringSample,
  normalizeGameTrackDifficulty,
} from "../game/game_judge";
import {
  clearGameJudgeOverlay,
  showGameJudgeOverlay,
} from "../game/game_judge_overlay";
import { openPracticeResultDialog, syncGameModeUi } from "../game/game_ui";
import {
  scrollLeftToScoreSeconds,
  scrollToScoreSeconds,
  syncPlaybackStatus,
  syncPlaybackUi,
  syncSeekUi,
} from "./app_playback_ui";
import { createTickTimeMapper } from "../../audio/tick_time_mapper";
import {
  beginPerfSession,
  endPerfSession,
  measurePerf,
  measurePerfAsync,
} from "../../infra/perf_profiler";

/** playback binding이 app 상태와 runtime을 조회하기 위한 session 입력. */
export type PlaybackBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  getPlaybackRuntime(): AppPlaybackRuntime;
  getNotePreviewRuntime(): AppNotePreviewRuntime;
  youtubeControl?: YoutubePlaybackControl;
  resetPlaybackForCurrentState(): void;
  resetPlaybackForCurrentStatePreservingPosition(): void;
  resetNotePreviewForCurrentDom(): void;
};

/** playback binding이 외부 reset 흐름에 제공하는 control 객체. */
export type PlaybackBindingControl = {
  stopPlaybackAnimation(): void;
};

/**
 * playback 관련 DOM event를 app playback runtime에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태와 playback runtime callback 묶음
 * - 반환값 : 외부 reset에서 사용할 animation control
 */
export function bindPlaybackControls(
  dom: AppDom,
  session: PlaybackBindingSession,
): PlaybackBindingControl {
  let playbackRafId: number | null = null;
  let scrollSeekRafId: number | null = null;
  let suppressScrollSeek = false;
  let lastPlaybackScoreSeconds: number | null = null;
  let lastGameScoringSeconds: number | null = null;
  let gameScoringCorrectionState = createGamePitchCorrectionState();
  let countdownAudioContext: AudioContext | null = null;

  /**
   * practice mode의 최신 pitch frame을 현재 score time에 맞춰 점수로 누적한다.
   * - 인수 : scoreSeconds : playback controller가 보고한 현재 score time
   * - 반환값 : 없음
   */
  const updatePracticeScoring = (scoreSeconds: number): void => {
    const state = session.getState();

    if (state.gameMode.kind !== "playing") {
      return;
    }

    if (
      lastGameScoringSeconds !== null &&
      scoreSeconds - lastGameScoringSeconds < 0.1
    ) {
      return;
    }

    lastGameScoringSeconds = scoreSeconds;

    try {
      const mapper = createTickTimeMapper(state.analysis.timingTimeline);
      const hasRemainingTarget = hasRemainingGameJudgeTarget(
        state.analysis,
        state.activeTrackIds,
        mapper,
        scoreSeconds,
      );

      if (!hasRemainingTarget) {
        clearGameJudgeOverlay(dom);

        const nextState = {
          ...state,
          gameMode: {
            kind: "finished" as const,
            summary: state.gameMode.summary,
            pitchFrame: state.gameMode.pitchFrame,
          },
          statusMessage: {
            level: "info" as const,
            text: "Practice finished.",
          },
        };

        session.setState(nextState);
        syncGameModeUi(dom, nextState);
        syncLeftStatus(dom, nextState);
        openPracticeResultDialog(dom, nextState.gameMode.summary);
        return;
      }

      const targets = collectGameJudgeTargetsAtSeconds(
        state.analysis,
        state.activeTrackIds,
        mapper,
        scoreSeconds,
      );
      const sample = judgeGameScoringSample(
        state.gameMode.pitchFrame,
        targets,
        scoreSeconds,
        normalizeGameTrackDifficulty(state.document.score.musicData.scoreDifficulty),
        { state: gameScoringCorrectionState },
      );

      if (sample === null) {
        return;
      }

      const nextSummary = applyGameScoringSample(state.gameMode.summary, sample);
      const nextState = {
        ...state,
        gameMode: {
          kind: "playing" as const,
          summary: nextSummary,
          pitchFrame: state.gameMode.pitchFrame,
        },
      };

      session.setState(nextState);
      syncGameModeUi(dom, nextState);
      showGameJudgeOverlay(dom, nextState, sample, nextSummary.currentCombo);
    } catch {
      return;
    }
  };

  const stopPlaybackAnimation = (): void => {
    if (playbackRafId !== null) {
      cancelAnimationFrame(playbackRafId);
      playbackRafId = null;
    }
    lastPlaybackScoreSeconds = null;
    lastGameScoringSeconds = null;
    gameScoringCorrectionState = createGamePitchCorrectionState();
    clearGameJudgeOverlay(dom);
  };

  const scrollScoreAreaToSeconds = (
    state: AppState,
    playbackRuntime: AppPlaybackRuntime,
    scoreSeconds: number,
  ): void => {
    measurePerf("playbackUi.setSuppressScrollSeek", () => {
      suppressScrollSeek = true;
    });
    measurePerf("playbackUi.scrollToScoreSeconds", () =>
      scrollToScoreSeconds(dom, state, playbackRuntime, scoreSeconds)
    );
    measurePerf("playbackUi.requestUnsuppressScrollSeek", () =>
      requestAnimationFrame(() => {
        suppressScrollSeek = false;
      })
    );
  };

  const pausePlaybackForManualSeek = (
    playbackRuntime: AppPlaybackRuntime,
  ): void => {
    if (!playbackRuntime.controller.isPlaying()) {
      return;
    }

    suppressScrollSeek = false;
    playbackRuntime.controller.pause();
    session.youtubeControl?.pause();
    stopPlaybackAnimation();
  };

  const pausePlaybackForScoreAreaInteraction = (): void => {
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();

    if (state.busy.kind !== "idle" || isGameModeLocked(state.gameMode)) {
      return;
    }

    pausePlaybackForManualSeek(playbackRuntime);
    syncPlaybackUi(dom, state, playbackRuntime);
  };

  const resetPlaybackForAudioOptionChange = (): void => {
    const playbackState = session.getPlaybackRuntime().controller.getState();

    // 음색/볼륨 변경은 backend 재생성이 필요하므로, 재생 위치를 tick 기준으로 보존해 새 controller에 이식한다.
    if (playbackState.kind === "playing") {
      session.youtubeControl?.pause();
      session.resetPlaybackForCurrentStatePreservingPosition();
    } else if (playbackState.kind === "paused") {
      session.resetPlaybackForCurrentStatePreservingPosition();
    } else {
      session.resetPlaybackForCurrentState();
    }

    session.resetNotePreviewForCurrentDom();
  };

  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });

  /**
   * practice countdown 숫자에 맞춰 짧은 beep를 재생한다.
   * - 인수 : count : 현재 countdown 숫자
   * - 반환값 : 없음
   */
  const playCountdownBeep = (count: number): void => {
    const AudioContextConstructor = window.AudioContext;

    if (AudioContextConstructor === undefined) {
      return;
    }

    countdownAudioContext ??= new AudioContextConstructor();

    const audioContext = countdownAudioContext;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;
    const frequency = count === 1 ? 1046.5 : 783.99;

    if (audioContext.state === "suspended") {
      void audioContext.resume();
    }

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.18);
  };

  /**
   * practice playback을 시작하기 전에 3-2-1 countdown을 표시하고 실제 재생으로 넘긴다.
   * - 인수 : summary : countdown 동안 유지할 현재 게임 점수 집계
   * - 반환값 : 없음
   */
  const startPracticeCountdown = async (summary: GameScoreSummary): Promise<void> => {
    for (const count of [3, 2, 1]) {
      const currentState = session.getState();

      if (currentState.gameMode.kind !== "ready" && currentState.gameMode.kind !== "countdown") {
        return;
      }

      session.setState({
        ...currentState,
        gameMode: {
          kind: "countdown",
          count,
          summary,
          pitchFrame: currentState.gameMode.kind === "ready" || currentState.gameMode.kind === "countdown"
            ? currentState.gameMode.pitchFrame
            : null,
        },
        statusMessage: {
          level: "info",
          text: `Practice starts in ${count}...`,
        },
      });
      syncLeftStatus(dom, session.getState());
      syncUiControls(dom, session.getState());
      playCountdownBeep(count);
      await wait(1000);
    }

    const currentState = session.getState();

    if (currentState.gameMode.kind !== "countdown") {
      return;
    }

    lastGameScoringSeconds = null;
    gameScoringCorrectionState = createGamePitchCorrectionState();
    clearGameJudgeOverlay(dom);
    session.setState({
      ...currentState,
      gameMode: {
        kind: "playing",
        summary,
        pitchFrame: currentState.gameMode.pitchFrame,
      },
      statusMessage: {
        level: "info",
        text: "Practice playback started.",
      },
    });
    syncLeftStatus(dom, session.getState());
    syncUiControls(dom, session.getState());
    togglePlayback();
  };

  const updateMasterVolumeFromInput = (): void => {
    const masterVolume = readVolumeInput(dom.volumeInput);

    session.getPlaybackRuntime().backend.setMasterVolume(masterVolume);
    session.getNotePreviewRuntime().setMasterVolume(masterVolume);
  };

  const syncSeekFromUserScroll = (): void => {
    const state = session.getState();

    if (
      suppressScrollSeek ||
      state.busy.kind !== "idle" ||
      isGameModeLocked(state.gameMode) ||
      state.layout === null
    ) {
      return;
    }

    if (scrollSeekRafId !== null) {
      return;
    }

    scrollSeekRafId = requestAnimationFrame(() => {
      scrollSeekRafId = null;

      const nextState = session.getState();
      const nextPlaybackRuntime = session.getPlaybackRuntime();

      if (
        suppressScrollSeek ||
        nextState.busy.kind !== "idle" ||
        isGameModeLocked(nextState.gameMode) ||
        nextState.layout === null
      ) {
        return;
      }

      pausePlaybackForManualSeek(nextPlaybackRuntime);

      const scoreSeconds = scrollLeftToScoreSeconds(dom, nextState, nextPlaybackRuntime);

      syncSeekUi(dom, nextState, nextPlaybackRuntime, scoreSeconds);
      nextPlaybackRuntime.controller.seekToSeconds(
        scoreSeconds,
        createPlaybackLoopStateFromApp(nextState, nextPlaybackRuntime),
      )
        .then(() => {
          session.youtubeControl?.seekToCurrentScoreTime();
        })
        .catch((error: unknown) => {
          const currentState = session.getState();
          const message = error instanceof Error ? error.message : "Unknown scroll seek error.";

          session.setState({
            ...currentState,
            statusMessage: {
              level: "error",
              text: message,
            },
          });
          syncPlaybackStatus(dom, "error");
          syncLeftStatus(dom, session.getState());
        });
    });
  };

  const updatePlaybackScroll = (): void => {
    const perfSession = beginPerfSession("playback.raf.updateScroll");

    try {
      const state = measurePerf("playbackRaf.getState", () => session.getState());
      const playbackRuntime = measurePerf("playbackRaf.getPlaybackRuntime", () =>
        session.getPlaybackRuntime()
      );

      if (!playbackRuntime.controller.isPlaying() || state.layout === null) {
        playbackRafId = null;
        measurePerf("playbackRaf.syncPlaybackUiStopped", () =>
          syncPlaybackUi(dom, state, playbackRuntime)
        );
        return;
      }

      const currentScoreSeconds = measurePerf("playbackRaf.getCurrentScoreSeconds", () =>
        playbackRuntime.controller.getCurrentScoreSeconds()
      );

      if (
        lastPlaybackScoreSeconds !== null &&
        currentScoreSeconds + 1e-6 < lastPlaybackScoreSeconds
      ) {
        measurePerf("playbackRaf.youtubeSeekOnLoopWrap", () =>
          session.youtubeControl?.seekToCurrentScoreTime()
        );
      }

      lastPlaybackScoreSeconds = currentScoreSeconds;
      measurePerf("playbackRaf.updatePracticeScoring", () =>
        updatePracticeScoring(currentScoreSeconds)
      );

      // score canvas의 왼쪽 edge를 재생 기준선으로 두고 RAF마다 부드럽게 따라가도록 한다.
      measurePerf("playbackRaf.scrollScoreAreaToSeconds", () =>
        scrollScoreAreaToSeconds(state, playbackRuntime, currentScoreSeconds)
      );
      measurePerf("playbackRaf.syncSeekUi", () =>
        syncSeekUi(dom, state, playbackRuntime, currentScoreSeconds)
      );
      playbackRafId = measurePerf("playbackRaf.requestNextFrame", () =>
        requestAnimationFrame(updatePlaybackScroll)
      );
    } finally {
      endPerfSession(perfSession, { minTotalMs: 4 });
    }
  };

  dom.scoreArea.addEventListener("scroll", syncSeekFromUserScroll);
  dom.scoreArea.addEventListener("pointerdown", pausePlaybackForScoreAreaInteraction, {
    capture: true,
  });
  dom.scoreArea.addEventListener("wheel", pausePlaybackForScoreAreaInteraction, {
    capture: true,
    passive: true,
  });
  dom.scoreArea.addEventListener("touchstart", pausePlaybackForScoreAreaInteraction, {
    capture: true,
    passive: true,
  });

  const togglePlayback = (): void => {
    const perfSession = beginPerfSession("playback.toggle");
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();

    try {
      if (state.busy.kind !== "idle") {
        return;
      }

      const playbackState = measurePerf("playbackToggle.getControllerState", () =>
        playbackRuntime.controller.getState()
      );

      if (playbackState.kind === "playing") {
        measurePerf("playbackToggle.pauseController", () => playbackRuntime.controller.pause());
        measurePerf("playbackToggle.pauseYoutube", () => session.youtubeControl?.pause());
        measurePerf("playbackToggle.stopAnimation", () => stopPlaybackAnimation());
        if (state.gameMode.kind === "playing") {
          session.setState({
            ...state,
            gameMode: {
              kind: "paused",
              summary: state.gameMode.summary,
              pitchFrame: state.gameMode.pitchFrame,
            },
            statusMessage: {
              level: "info",
              text: "Practice playback paused.",
            },
          });
          syncUiControls(dom, session.getState());
        }
        measurePerf("playbackToggle.syncPlaybackUi", () =>
          syncPlaybackUi(dom, session.getState(), playbackRuntime)
        );
        measurePerf("playbackToggle.scrollToCurrentSeconds", () =>
          scrollScoreAreaToSeconds(
            session.getState(),
            playbackRuntime,
            playbackRuntime.controller.getCurrentScoreSeconds(),
          )
        );
        return;
      }

      if (state.gameMode.kind === "ready") {
        lastGameScoringSeconds = null;
        void startPracticeCountdown(state.gameMode.summary);
        return;
      }

      if (state.gameMode.kind === "countdown") {
        return;
      }

      const loopState = measurePerf("playbackToggle.createLoopState", () =>
        createPlaybackLoopStateFromApp(state, playbackRuntime)
      );
      const playStartSeconds = playbackState.kind === "paused"
        ? measurePerf("playbackToggle.getPausedCurrentSeconds", () =>
            playbackRuntime.controller.getCurrentScoreSeconds()
          )
        : Number(dom.seekInput.value);

      if (state.gameMode.kind === "paused") {
        session.setState({
          ...state,
          gameMode: {
            kind: "playing",
            summary: state.gameMode.summary,
            pitchFrame: state.gameMode.pitchFrame,
          },
        });
      }

      const playRequest = measurePerfAsync("playbackToggle.controllerPlayFromSeconds", () =>
        playbackRuntime.controller.playFromSeconds(playStartSeconds, loopState)
      );

      playRequest
        .then(() => {
          const thenPerfSession = beginPerfSession("playback.toggle.afterPlay");

          try {
        const nextState = session.getState();
        const nextPlaybackRuntime = session.getPlaybackRuntime();

            measurePerf("playbackAfterPlay.syncPlaybackUi", () =>
              syncPlaybackUi(dom, nextState, nextPlaybackRuntime)
            );
            measurePerf("playbackAfterPlay.scrollToCurrentSeconds", () =>
              scrollScoreAreaToSeconds(
                nextState,
                nextPlaybackRuntime,
                nextPlaybackRuntime.controller.getCurrentScoreSeconds(),
              )
            );
            measurePerf("playbackAfterPlay.youtubePlay", () =>
              session.youtubeControl?.playAtCurrentScoreTime()
            );
            lastPlaybackScoreSeconds = measurePerf("playbackAfterPlay.getCurrentSeconds", () =>
              nextPlaybackRuntime.controller.getCurrentScoreSeconds()
            );
            measurePerf("playbackAfterPlay.stopAnimation", () => stopPlaybackAnimation());
            playbackRafId = measurePerf("playbackAfterPlay.requestFrame", () =>
              requestAnimationFrame(updatePlaybackScroll)
            );
          } finally {
            endPerfSession(thenPerfSession);
          }
        })
        .catch((error: unknown) => {
        const currentState = session.getState();
        const message = error instanceof Error ? error.message : "Unknown playback error.";

        session.setState({
          ...currentState,
          statusMessage: {
            level: "error",
            text: message,
          },
        });
        syncPlaybackStatus(dom, "error");
        syncLeftStatus(dom, session.getState());
      });
    } finally {
      endPerfSession(perfSession);
    }
  };

  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || isEditableKeyboardTarget(event.target)) {
      return;
    }

    event.preventDefault();

    if (event.repeat) {
      return;
    }

    togglePlayback();
  });

  dom.playButton.addEventListener("click", togglePlayback);

  dom.stopButton.addEventListener("click", () => {
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();

    stopPlaybackAnimation();
    lastGameScoringSeconds = null;
    playbackRuntime.controller.stop();
    session.youtubeControl?.stop();
    if (isGameModeLocked(state.gameMode)) {
      session.setState({
        ...state,
        gameMode: {
          kind: "ready",
          summary: createEmptyGameScoreSummary(),
          pitchFrame: null,
        },
        statusMessage: {
          level: "info",
          text: "Practice score reset.",
        },
      });
      syncUiControls(dom, session.getState());
    }
    syncPlaybackUi(dom, session.getState(), playbackRuntime);
    scrollScoreAreaToSeconds(session.getState(), playbackRuntime, 0);
  });

  dom.seekInput.addEventListener("input", () => {
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();
    const scoreSeconds = Number(dom.seekInput.value);

    if (isGameModeLocked(state.gameMode)) {
      syncPlaybackUi(dom, state, playbackRuntime);
      return;
    }

    pausePlaybackForManualSeek(playbackRuntime);
    session.youtubeControl?.pause();
    syncSeekUi(dom, state, playbackRuntime, scoreSeconds);
    scrollScoreAreaToSeconds(state, playbackRuntime, scoreSeconds);
  });

  dom.seekInput.addEventListener("change", () => {
    if (isGameModeLocked(session.getState().gameMode)) {
      syncPlaybackUi(dom, session.getState(), session.getPlaybackRuntime());
      return;
    }

    const scoreSeconds = Number(dom.seekInput.value);
    const playbackRuntime = session.getPlaybackRuntime();

    playbackRuntime.controller.seekToSeconds(
      scoreSeconds,
      createPlaybackLoopStateFromApp(session.getState(), playbackRuntime),
    )
      .then(() => {
        const state = session.getState();
        const nextPlaybackRuntime = session.getPlaybackRuntime();

        syncPlaybackUi(dom, state, nextPlaybackRuntime);
        scrollScoreAreaToSeconds(
          state,
          nextPlaybackRuntime,
          nextPlaybackRuntime.controller.getCurrentScoreSeconds(),
        );
        session.youtubeControl?.seekToCurrentScoreTime();
        if (nextPlaybackRuntime.controller.isPlaying()) {
          stopPlaybackAnimation();
          playbackRafId = requestAnimationFrame(updatePlaybackScroll);
        }
      })
      .catch((error: unknown) => {
        const currentState = session.getState();
        const message = error instanceof Error ? error.message : "Unknown seek error.";

        session.setState({
          ...currentState,
          statusMessage: {
            level: "error",
            text: message,
          },
        });
        syncPlaybackStatus(dom, "error");
        syncLeftStatus(dom, session.getState());
      });
  });

  dom.volumeInput.addEventListener("input", updateMasterVolumeFromInput);
  dom.volumeInput.addEventListener("change", updateMasterVolumeFromInput);

  dom.waveSelect.addEventListener("change", () => {
    resetPlaybackForAudioOptionChange();
  });

  return {
    stopPlaybackAnimation,
  };
}

/**
 * Space 단축키가 텍스트 입력을 가로채면 안 되는 DOM target인지 확인한다.
 * - 인수 : target : keyboard event target
 * - 반환값 : 텍스트 입력/선택/편집 가능 영역 여부
 */
function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable;
}

/**
 * volume range input 값을 0 이상 1 이하의 master volume으로 읽는다.
 * - 인수 : input : volume range input
 * - 반환값 : backend에 전달할 master volume
 */
function readVolumeInput(input: HTMLInputElement): number {
  const volume = Number(input.value) / 100;

  if (!Number.isFinite(volume)) {
    return 0;
  }

  return Math.min(Math.max(volume, 0), 1);
}
