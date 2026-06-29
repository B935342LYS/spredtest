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
  type GameEffectBonusResult,
  type GamePitchFrame,
  type GameScoreSummary,
  type GameTimingOnsetCandidate,
} from "../game/game_types";
import {
  applyGameEffectBonus,
  applyGameSyncOffsetSeconds,
  applyGameScoringSample,
  collectGameJudgeTargetsAtSeconds,
  hasRemainingGameJudgeTarget,
  judgeGameScoringSample,
  normalizeGameTrackDifficulty,
} from "../game/game_judge";
import {
  collectGameEffectBonusTargets,
  getGlissIntervalIndexAtSeconds,
  judgeGlissIntervalBonus,
  judgeVibWindowBonus,
  shouldLockFailedGlissBonusTarget,
  type GameEffectFrame,
  type GameEffectBonusTarget,
} from "../game/game_effect_judge";
import {
  clearGameJudgeOverlay,
  showGameEffectBonusOverlay,
  showGameJudgeOverlay,
} from "../game/game_judge_overlay";
import { openPracticeResultDialogForState, syncGameModeUi } from "../game/game_ui";
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

const TIMING_ONSET_MIN_INTERVAL_SECONDS = 0.06;
const TIMING_ONSET_KEEP_SECONDS = 0.75;
const TIMING_PITCH_CHANGE_THRESHOLD_CENT = 80;
const EFFECT_FRAME_KEEP_SECONDS = 1.2;
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
  let lastTimingFrame: GamePitchFrame | null = null;
  let lastProcessedTimingFrameAtMs: number | null = null;
  let timingOnsetCandidates: GameTimingOnsetCandidate[] = [];
  let consumedTimingOnsetIds = new Set<number>();
  let judgedTimingEventIds = new Set<string>();
  let attackSatisfiedEventIds = new Set<string>();
  let nextTimingOnsetId = 1;
  let effectBonusTargets: GameEffectBonusTarget[] = [];
  let effectFrames: GameEffectFrame[] = [];
  let lastProcessedEffectFrameAtMs: number | null = null;
  let judgedEffectIntervalIds = new Set<string>();
  let failedEffectTargetIds = new Set<string>();
  let countdownAudioContext: AudioContext | null = null;

  /**
   * practice timing 판정용 runtime 상태를 새 세션 기준으로 비운다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const resetPracticeTimingState = (): void => {
    lastTimingFrame = null;
    lastProcessedTimingFrameAtMs = null;
    timingOnsetCandidates = [];
    consumedTimingOnsetIds = new Set<number>();
    judgedTimingEventIds = new Set<string>();
    attackSatisfiedEventIds = new Set<string>();
    nextTimingOnsetId = 1;
    effectBonusTargets = [];
    effectFrames = [];
    lastProcessedEffectFrameAtMs = null;
    judgedEffectIntervalIds = new Set<string>();
    failedEffectTargetIds = new Set<string>();
  };

  /**
   * 최신 pitch frame에서 timing onset 후보를 추출한다.
   * - 인수 : scoreSeconds : playback controller가 보고한 현재 score time
   * - 반환값 : 없음
   */
  const updatePracticeTimingInput = (scoreSeconds: number): void => {
    const state = session.getState();

    if (state.gameMode.kind !== "playing") {
      return;
    }

    const frame = state.gameMode.pitchFrame;

    if (
      frame === null ||
      lastProcessedTimingFrameAtMs === frame.capturedAtMs
    ) {
      return;
    }

    lastProcessedTimingFrameAtMs = frame.capturedAtMs;

    const judgeScoreSeconds = applyGameSyncOffsetSeconds(scoreSeconds, state.gameSyncOffsetMs);

    appendPracticeEffectFrame(frame, judgeScoreSeconds);

    if (frame.isVoiced && frame.midi !== null && frame.centOffset !== null) {
      const shouldCreateOnset = isTimingOnsetFrame(lastTimingFrame, frame) &&
        canAppendTimingOnset(judgeScoreSeconds, timingOnsetCandidates);

      if (shouldCreateOnset) {
        timingOnsetCandidates.push({
          id: nextTimingOnsetId,
          scoreSeconds: judgeScoreSeconds,
          midi: frame.midi,
          centOffset: frame.centOffset,
        });
        nextTimingOnsetId += 1;
      }
    }

    lastTimingFrame = frame;
    timingOnsetCandidates = pruneTimingOnsets(judgeScoreSeconds, timingOnsetCandidates);
  };

  /**
   * practice effect bonus target 중 현재 gliss interval을 판정해 성공 bonus를 누적한다.
   * - 인수 : judgeScoreSeconds : Sync 보정이 적용된 현재 score time
   * - 반환값 : 없음
   */
  const updatePracticeEffectBonus = (judgeScoreSeconds: number): GameEffectBonusResult | null => {
    const state = session.getState();
    let lastBonus: GameEffectBonusResult | null = null;

    if (state.gameMode.kind !== "playing") {
      return null;
    }

    const trackDifficulty = normalizeGameTrackDifficulty(state.document.score.musicData.scoreDifficulty);

    // gliss는 interval마다, vib는 effect segment마다 한 번씩 검사해 성공 시 bonus를 더한다.
    for (const target of effectBonusTargets) {
      if (failedEffectTargetIds.has(target.targetId)) {
        continue;
      }

      const bonusId = getEffectBonusJudgeId(target, judgeScoreSeconds);

      if (bonusId === null || judgedEffectIntervalIds.has(bonusId)) {
        continue;
      }

      if (target.kind === "gliss") {
        const intervalIndex = getGlissIntervalIndexAtSeconds(target, judgeScoreSeconds) ?? -1;

        if (
          shouldLockFailedGlissBonusTarget(
            target,
            state.gameMode.pitchFrame,
            judgeScoreSeconds,
            intervalIndex,
            effectFrames,
          )
        ) {
          failedEffectTargetIds.add(target.targetId);
          continue;
        }
      }

      const bonus = target.kind === "gliss"
        ? judgeGlissIntervalBonus(
          target,
          state.gameMode.pitchFrame,
          judgeScoreSeconds,
          getGlissIntervalIndexAtSeconds(target, judgeScoreSeconds) ?? -1,
          trackDifficulty,
          effectFrames,
        )
        : judgeVibWindowBonus(
          target,
          effectFrames,
          judgeScoreSeconds,
          trackDifficulty,
        );

      if (bonus === null) {
        continue;
      }

      judgedEffectIntervalIds.add(bonusId);

      const currentState = session.getState();

      if (currentState.gameMode.kind !== "playing") {
        return lastBonus;
      }

      const nextSummary = applyGameEffectBonus(currentState.gameMode.summary, bonus);
      const nextState = {
        ...currentState,
        gameMode: {
          kind: "playing" as const,
          summary: nextSummary,
          pitchFrame: currentState.gameMode.pitchFrame,
        },
      };

      session.setState(nextState);
      syncGameModeUi(dom, nextState);
      lastBonus = bonus;
    }

    return lastBonus;
  };

  /**
   * practice effect 판정용 최근 pitch frame 창을 갱신한다.
   * - 인수 : frame : 현재 game mode pitch frame
   * - 인수 : judgeScoreSeconds : Sync 보정이 적용된 현재 score time
   * - 반환값 : 없음
   */
  const appendPracticeEffectFrame = (
    frame: GamePitchFrame | null,
    judgeScoreSeconds: number,
  ): void => {
    if (frame === null || lastProcessedEffectFrameAtMs === frame.capturedAtMs) {
      return;
    }

    lastProcessedEffectFrameAtMs = frame.capturedAtMs;
    effectFrames.push({
      scoreSeconds: judgeScoreSeconds,
      frame,
    });
    effectFrames = effectFrames.filter((entry) =>
      judgeScoreSeconds - entry.scoreSeconds <= EFFECT_FRAME_KEEP_SECONDS
    );
  };

  /**
   * effect target의 중복 판정 방지 id를 만든다.
   * - 인수 : target : 판정할 effect bonus 대상
   * - 인수 : judgeScoreSeconds : Sync 보정이 적용된 현재 score time
   * - 반환값 : 현재 판정해야 할 id, 아니면 null
   */
  const getEffectBonusJudgeId = (
    target: GameEffectBonusTarget,
    judgeScoreSeconds: number,
  ): string | null => {
    if (target.kind === "vib") {
      if (judgeScoreSeconds < target.startSeconds || judgeScoreSeconds > target.endSeconds) {
        return null;
      }

      return target.targetId;
    }

    const intervalIndex = getGlissIntervalIndexAtSeconds(target, judgeScoreSeconds);

    return intervalIndex === null ? null : `${target.targetId}:${intervalIndex}`;
  };

  /**
   * 아직 지나지 않은 effect bonus target 구간이 있는지 확인한다.
   * - 인수 : judgeScoreSeconds : Sync 보정이 적용된 현재 score time
   * - 반환값 : 현재 이후 남은 gliss target 구간이 있으면 true
   */
  const hasPendingEffectBonusTarget = (judgeScoreSeconds: number): boolean =>
    effectBonusTargets.some((target) => {
      if (target.kind === "gliss") {
        return getGlissIntervalIndexAtSeconds(target, judgeScoreSeconds) !== null ||
          judgeScoreSeconds <= target.endSeconds;
      }

      return judgeScoreSeconds <= target.endSeconds;
    });

  /**
   * practice mode의 최신 pitch frame을 현재 score time에 맞춰 점수로 누적한다.
   * - 인수 : scoreSeconds : playback controller가 보고한 현재 score time
   * - 반환값 : 없음
   */
  const updatePracticeScoring = (scoreSeconds: number): void => {
    let state = session.getState();

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
      const judgeScoreSeconds = applyGameSyncOffsetSeconds(scoreSeconds, state.gameSyncOffsetMs);
      const mapper = createTickTimeMapper(state.analysis.timingTimeline);
      const effectBonus = updatePracticeEffectBonus(judgeScoreSeconds);
      state = session.getState();

      if (state.gameMode.kind !== "playing") {
        return;
      }

      const hasRemainingTarget = hasRemainingGameJudgeTarget(
        state.analysis,
        state.activeTrackIds,
        mapper,
        judgeScoreSeconds,
      );

      if (!hasRemainingTarget && !hasPendingEffectBonusTarget(judgeScoreSeconds)) {
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
        openPracticeResultDialogForState(dom, nextState);
        return;
      }

      const targets = collectGameJudgeTargetsAtSeconds(
        state.analysis,
        state.activeTrackIds,
        mapper,
        judgeScoreSeconds,
      );
      const sample = judgeGameScoringSample(
        state.gameMode.pitchFrame,
        targets,
        judgeScoreSeconds,
        normalizeGameTrackDifficulty(state.document.score.musicData.scoreDifficulty),
        {
          onsetCandidates: timingOnsetCandidates,
          judgedEventIds: judgedTimingEventIds,
          consumedOnsetIds: consumedTimingOnsetIds,
          attackSatisfiedEventIds,
        },
        state.practiceJudgeMode,
      );

      if (sample === null) {
        if (effectBonus !== null) {
          showGameEffectBonusOverlay(dom, session.getState(), effectBonus);
        }
        return;
      }

      if (sample.timingOnsetId !== null) {
        consumedTimingOnsetIds.add(sample.timingOnsetId);
      }

      if (sample.timingJudgedEventId !== null) {
        judgedTimingEventIds.add(sample.timingJudgedEventId);
        attackSatisfiedEventIds.add(sample.timingJudgedEventId);
      }

      if (!sample.scoreEligible) {
        if (effectBonus !== null) {
          showGameEffectBonusOverlay(dom, session.getState(), effectBonus);
        }
        return;
      }

      const nextSummary = applyGameScoringSample(state.gameMode.summary, sample, state.practiceJudgeMode);
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

      if (effectBonus !== null) {
        showGameEffectBonusOverlay(dom, nextState, effectBonus);
      }
    } catch {
      return;
    }
  };

  const stopPlaybackAnimation = (resetPracticeState = true): void => {
    if (playbackRafId !== null) {
      cancelAnimationFrame(playbackRafId);
      playbackRafId = null;
    }
    lastPlaybackScoreSeconds = null;
    lastGameScoringSeconds = null;
    if (resetPracticeState) {
      resetPracticeTimingState();
    }
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
    resetPracticeTimingState();
    effectBonusTargets = collectGameEffectBonusTargets(
      currentState.analysis,
      currentState.activeTrackIds,
      createTickTimeMapper(currentState.analysis.timingTimeline),
    );
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
      measurePerf("playbackRaf.updatePracticeTimingInput", () =>
        updatePracticeTimingInput(currentScoreSeconds)
      );
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
        measurePerf("playbackToggle.stopAnimation", () =>
          stopPlaybackAnimation(state.gameMode.kind !== "playing")
        );
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
            measurePerf("playbackAfterPlay.stopAnimation", () => stopPlaybackAnimation(false));
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
 * pitch frame이 timing onset 후보로 볼 수 있는 변화인지 확인한다.
 * - 인수 : previousFrame : 직전에 처리한 pitch frame
 * - 인수 : currentFrame : 새로 처리할 pitch frame
 * - 반환값 : 무음에서 유음으로 바뀌었거나 pitch class가 충분히 바뀌었으면 true
 */
function isTimingOnsetFrame(
  previousFrame: GamePitchFrame | null,
  currentFrame: GamePitchFrame,
): boolean {
  if (
    !currentFrame.isVoiced ||
    currentFrame.midi === null ||
    currentFrame.centOffset === null
  ) {
    return false;
  }

  if (
    previousFrame === null ||
    !previousFrame.isVoiced ||
    previousFrame.midi === null ||
    previousFrame.centOffset === null
  ) {
    return true;
  }

  const previousCent = previousFrame.midi * 100 + previousFrame.centOffset;
  const currentCent = currentFrame.midi * 100 + currentFrame.centOffset;

  return calculatePitchClassErrorCent(previousCent, currentCent) >= TIMING_PITCH_CHANGE_THRESHOLD_CENT;
}

/**
 * 마지막 onset 후보와 충분히 떨어져 새 onset 후보를 추가할 수 있는지 확인한다.
 * - 인수 : onsetScoreSeconds : 새 onset 후보의 score time
 * - 인수 : candidates : 현재 저장된 onset 후보 목록
 * - 반환값 : 후보가 없거나 최소 간격 이상 떨어져 있으면 true
 */
function canAppendTimingOnset(
  onsetScoreSeconds: number,
  candidates: readonly GameTimingOnsetCandidate[],
): boolean {
  const lastCandidate = candidates[candidates.length - 1];

  if (lastCandidate === undefined) {
    return true;
  }

  return onsetScoreSeconds - lastCandidate.scoreSeconds >= TIMING_ONSET_MIN_INTERVAL_SECONDS;
}

/**
 * 현재 score time에서 더 이상 매칭하지 않을 오래된 onset 후보를 제거한다.
 * - 인수 : currentScoreSeconds : 현재 판정용 score time
 * - 인수 : candidates : 현재 onset 후보 목록
 * - 반환값 : 유지할 onset 후보 목록
 */
function pruneTimingOnsets(
  currentScoreSeconds: number,
  candidates: readonly GameTimingOnsetCandidate[],
): GameTimingOnsetCandidate[] {
  return candidates.filter((candidate) =>
    Math.abs(currentScoreSeconds - candidate.scoreSeconds) <= TIMING_ONSET_KEEP_SECONDS
  );
}

/**
 * 두 cent pitch 사이의 pitch class 기준 최소 오차를 계산한다.
 * - 인수 : inputCent : 입력 pitch의 절대 cent 값
 * - 인수 : targetCent : 비교할 pitch의 절대 cent 값
 * - 반환값 : 0 이상 600 이하의 pitch class 오차 cent
 */
function calculatePitchClassErrorCent(inputCent: number, targetCent: number): number {
  const wrapped = Math.abs(inputCent - targetCent) % 1200;

  return Math.min(wrapped, 1200 - wrapped);
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
