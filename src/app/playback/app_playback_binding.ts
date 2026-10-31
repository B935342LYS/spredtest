/**
 * playback 버튼, seek input, audio option event를 app playback runtime에 연결한다.
 */

import { createGameInputHistory } from "../game/game_input_history";
import type {
  AppDom,
  AppState,
} from "../app_types";
import { syncLeftStatus, syncUiControls } from "../app_ui_sync";
import type { AppPlaybackRuntime } from "./app_playback";
import {
  createPlaybackLoopStateFromApp,
  createPracticeRangeStateFromApp,
} from "./app_playback";
import type { AppNotePreviewRuntime } from "./app_note_preview";
import type { YoutubePlaybackControl } from "../youtube/youtube_binding";
import {
  createEmptyGameScoreSummary,
  isGameModeLocked,
  type GameEffectBonusResult,
  type GamePitchFrame,
  type GameScoreSummary,
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
  judgeTremAttackBonus,
  judgeVibWindowBonus,
  shouldLockFailedGlissBonusTarget,
  type GameEffectBonusTarget,
  type GameTremRuntimeState,
} from "../game/game_effect_judge";
import {
  clearGameJudgeOverlay,
  showGameEffectBonusOverlay,
  showGameJudgeOverlay,
} from "../game/game_judge_overlay";
import { openPracticeResultDialogForState, syncGameModeUi } from "../game/game_ui";
import { saveGameDisplayOffsetMsToLocalStorage } from "../../infra/game_preferences";
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
  const inputHistory = createGameInputHistory();
  let consumedTimingOnsetIds = new Set<number>();
  let judgedTimingEventIds = new Set<string>();
  let attackSatisfiedEventIds = new Set<string>();
  let effectBonusTargets: GameEffectBonusTarget[] = [];
  let judgedEffectIntervalIds = new Set<string>();
  let failedEffectTargetIds = new Set<string>();
  let tremRuntimeByTargetId = new Map<string, GameTremRuntimeState>();
  let countdownAudioContext: AudioContext | null = null;
  let syncPauseGeneration = 0;
  let countdownGeneration = 0;

  /**
   * practice timing 판정용 runtime 상태를 새 세션 기준으로 비운다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const resetPracticeTimingState = (): void => {
    inputHistory.reset();
    consumedTimingOnsetIds = new Set<number>();
    judgedTimingEventIds = new Set<string>();
    attackSatisfiedEventIds = new Set<string>();
    effectBonusTargets = [];
    judgedEffectIntervalIds = new Set<string>();
    failedEffectTargetIds = new Set<string>();
    tremRuntimeByTargetId = new Map<string, GameTremRuntimeState>();
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

    inputHistory.recordFrame(
      state.gameMode.pitchFrame,
      applyGameSyncOffsetSeconds(scoreSeconds, state.gameSyncOffsetMs),
    );
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

    // gliss는 interval마다, vib는 effect segment마다, trem은 attack streak마다 검사해 성공 시 bonus를 더한다.
    for (const target of effectBonusTargets) {
      if (failedEffectTargetIds.has(target.targetId)) {
        continue;
      }

      if (target.kind === "trem") {
        const bonus = judgeTremAttackBonus(
          target,
          inputHistory.getOnsets(),
          getTremRuntimeState(target.targetId),
          judgeScoreSeconds,
          trackDifficulty,
          state.gameMode.pitchFrame,
        );

        if (bonus === null) {
          continue;
        }

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
            inputHistory.getEffectFrames(),
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
          inputHistory.getEffectFrames(),
        )
        : judgeVibWindowBonus(
          target,
          inputHistory.getEffectFrames(),
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
   * trem target의 runtime streak 상태를 가져오거나 새로 만든다.
   * - 인수 : targetId : trem target 식별자
   * - 반환값 : target별 trem streak 상태
   */
  const getTremRuntimeState = (targetId: string): GameTremRuntimeState => {
    const existing = tremRuntimeByTargetId.get(targetId);

    if (existing !== undefined) {
      return existing;
    }

    const created: GameTremRuntimeState = {
      acceptedOnsetIds: new Set<number>(),
      lastAcceptedScoreSeconds: null,
      streakCount: 0,
      rewardedOnsetIds: new Set<number>(),
      rewardedSyntheticHitIds: new Set<string>(),
    };

    tremRuntimeByTargetId.set(targetId, created);

    return created;
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

    if (target.kind === "trem") {
      return null;
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

      const practiceRange = createPracticeRangeStateFromApp(state, session.getPlaybackRuntime());
      const hasReachedPracticeRangeEnd = practiceRange.enabled &&
        judgeScoreSeconds >= practiceRange.endSeconds - 1e-6;

      const hasRemainingTarget = hasRemainingGameJudgeTarget(
        state.analysis,
        state.activeTrackIds,
        mapper,
        judgeScoreSeconds,
      );

      if (
        hasReachedPracticeRangeEnd ||
        (!hasRemainingTarget && !hasPendingEffectBonusTarget(judgeScoreSeconds))
      ) {
        finishPracticePlayback(state);
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
          onsetCandidates: inputHistory.getOnsets(),
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

  /**
   * practice playback을 finished 상태로 바꾸고 result dialog를 연다.
   * - 인수 : state : 현재 playing 상태를 가진 앱 상태
   * - 반환값 : finished 처리를 수행했으면 true
   */
  const finishPracticePlayback = (state: AppState): boolean => {
    if (state.gameMode.kind !== "playing") {
      return false;
    }

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

    return true;
  };

  /**
   * controller가 자연 종료된 뒤에도 practice result 처리를 보장한다.
   * - 인수 : state : RAF에서 읽은 현재 앱 상태
   * - 인수 : playbackRuntime : 현재 playback runtime
   * - 반환값 : result 처리를 수행했으면 true
   */
  const finishPracticeAfterNaturalPlaybackEnd = (
    state: AppState,
    playbackRuntime: AppPlaybackRuntime,
  ): boolean => {
    if (state.gameMode.kind !== "playing") {
      return false;
    }

    const currentScoreSeconds = playbackRuntime.controller.getCurrentScoreSeconds();
    const durationSeconds = playbackRuntime.timeMapper.getDurationSeconds();

    if (currentScoreSeconds < durationSeconds - 1e-6) {
      return false;
    }

    return finishPracticePlayback(state);
  };

  /**
   * 이전 카운트다운의 대기와 비프음을 무효화한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const invalidatePracticeCountdown = (): void => {
    countdownGeneration += 1;
    if (countdownAudioContext !== null) {
      void countdownAudioContext.close();
      countdownAudioContext = null;
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
      invalidatePracticeCountdown();
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

  /**
   * 화면 보정값을 세션 상태에 저장하고 현재 위치를 즉시 다시 표시한다.
   * - 인수 : offsetMs : 요청한 화면 보정 ms 값
   * - 반환값 : 없음
   */
  const setDisplayOffset = (offsetMs: number): void => {
    const state = session.getState();
    const nextState = { ...state, gameDisplayOffsetMs: saveGameDisplayOffsetMsToLocalStorage(offsetMs) };
    session.setState(nextState);
    syncGameModeUi(dom, nextState);
    // 자동 스크롤의 seek 억제 경로를 사용하여 화면 조절이 실제 재생 위치를 바꾸지 않게 한다.
    if (isGameModeLocked(nextState.gameMode)) {
      const runtime = session.getPlaybackRuntime();
      scrollScoreAreaToSeconds(nextState, runtime, runtime.controller.getCurrentScoreSeconds());
    }
  };
  dom.practiceDisplayMinusButton.addEventListener("click", () => setDisplayOffset(session.getState().gameDisplayOffsetMs - 10));
  dom.practiceDisplayPlusButton.addEventListener("click", () => setDisplayOffset(session.getState().gameDisplayOffsetMs + 10));
  // 1ms 버튼도 화면 갱신과 사용자 설정 저장을 함께 수행한다.
  dom.practiceDisplayFineMinusButton.addEventListener("click", () => setDisplayOffset(session.getState().gameDisplayOffsetMs - 1));
  dom.practiceDisplayFinePlusButton.addEventListener("click", () => setDisplayOffset(session.getState().gameDisplayOffsetMs + 1));
  dom.practiceDisplayResetButton.addEventListener("click", () => setDisplayOffset(0));
  dom.practiceModeButton.addEventListener("click", () => {
    // game binding이 Practice를 종료한 뒤 일반 재생의 보정 없는 위치로 복귀한다.
    const state = session.getState();
    if (state.gameMode.kind === "off") {
      invalidatePracticeCountdown();
      const runtime = session.getPlaybackRuntime();
      scrollScoreAreaToSeconds(state, runtime, runtime.controller.getCurrentScoreSeconds());
    }
  });

  /**
   * Sync 진입 시 악보만 일시정지하고 재생 위치와 점수·입력 상태를 보존한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const pausePlaybackForSync = (): void => {
    const state = session.getState();
    const runtime = session.getPlaybackRuntime();
    runtime.controller.pause();
    session.youtubeControl?.pause();
    stopPlaybackAnimation(false);
    // countdown 대기는 세대 번호로 무효화한다. 닫기 뒤에는 사용자가 Play를 눌러야 한다.
    if (state.gameMode.kind === "playing" || state.gameMode.kind === "countdown") {
      session.setState({
        ...state,
        gameMode: { ...state.gameMode, kind: state.gameMode.kind === "countdown" ? "ready" : "paused" },
      });
    }
    invalidatePracticeCountdown();
    syncUiControls(dom, session.getState());
    syncPlaybackUi(dom, session.getState(), runtime);
  };
  // capture 단계에서 정지시켜 game binding이 설정창을 열기 전에 악보 소리를 차단한다.
  dom.gameSyncButton.addEventListener("click", () => {
    syncPauseGeneration += 1;
    pausePlaybackForSync();
  }, { capture: true });

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

    if (state.busy.kind !== "idle" || state.outputSyncError !== undefined || isGameModeLocked(state.gameMode)) {
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
    invalidatePracticeCountdown();
    const countdownRequest = countdownGeneration;
    const runtime = session.getPlaybackRuntime();
    const generation = syncPauseGeneration;
    for (const count of [3, 2, 1]) {
      const currentState = session.getState();

      // ready/countdown으로 돌아와도 종료·재시작 이전의 실행은 다시 진행하지 않는다.
      if (countdownRequest !== countdownGeneration || session.getPlaybackRuntime() !== runtime ||
        generation !== syncPauseGeneration || dom.practiceSyncDialog.open ||
        (currentState.gameMode.kind !== "ready" && currentState.gameMode.kind !== "countdown")) {
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

    if (countdownRequest !== countdownGeneration || session.getPlaybackRuntime() !== runtime ||
      generation !== syncPauseGeneration || dom.practiceSyncDialog.open || currentState.gameMode.kind !== "countdown") {
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
      state.busy.kind !== "idle" || state.outputSyncError !== undefined ||
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
        nextState.busy.kind !== "idle" || nextState.outputSyncError !== undefined ||
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
        measurePerf("playbackRaf.finishPracticeAfterNaturalEnd", () =>
          finishPracticeAfterNaturalPlaybackEnd(state, playbackRuntime)
        );
        measurePerf("playbackRaf.syncPlaybackUiStopped", () =>
          syncPlaybackUi(dom, session.getState(), playbackRuntime)
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
    if (dom.practiceSyncDialog.open) return;
    const perfSession = beginPerfSession("playback.toggle");
    const state = session.getState();
    const playbackRuntime = session.getPlaybackRuntime();

    try {
      if (state.busy.kind !== "idle" || state.outputSyncError !== undefined) {
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
        state.gameMode.kind === "playing"
          ? { enabled: false as const }
          : createPlaybackLoopStateFromApp(state, playbackRuntime)
      );
      const practiceRange = state.gameMode.kind === "playing"
        ? createPracticeRangeStateFromApp(state, playbackRuntime)
        : { enabled: false as const };
      const playStartSeconds = playbackState.kind === "paused"
        ? measurePerf("playbackToggle.getPausedCurrentSeconds", () =>
            playbackRuntime.controller.getCurrentScoreSeconds()
          )
        : practiceRange.enabled
          ? practiceRange.startSeconds
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

      const playGeneration = syncPauseGeneration;
      const playRequest = measurePerfAsync("playbackToggle.controllerPlayFromSeconds", () =>
        playbackRuntime.controller.playFromSeconds(playStartSeconds, loopState)
      );

      playRequest
        .then(() => {
          // 비동기 오디오 준비 중 Sync를 열었다 닫아도 이전 play 요청이 뒤늦게 재생되지 않게 한다.
          if (session.getPlaybackRuntime() !== playbackRuntime) {
            playbackRuntime.controller.stop();
            return;
          }
          if (playGeneration !== syncPauseGeneration || dom.practiceSyncDialog.open ||
              session.getState().outputSyncError !== undefined) {
            pausePlaybackForSync();
            return;
          }
          if (!playbackRuntime.controller.isPlaying()) return;
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
              session.youtubeControl?.playAtCurrentScoreTime(playbackState.kind === "paused")
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
        // 이전 runtime 또는 Sync 진입 이전의 요청은 현재 화면에 오류를 표시하지 않는다.
        if (session.getPlaybackRuntime() !== playbackRuntime || playGeneration !== syncPauseGeneration) return;
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
    // 대화상자와 버튼·메뉴의 기본 Space 조작을 전역 재생 단축키가 가로채지 않게 한다.
    if (
      event.code !== "Space" || event.defaultPrevented ||
      document.querySelector("dialog[open]") !== null ||
      isEditableKeyboardTarget(event.target) ||
      (event.target instanceof Element && event.target.closest("button, summary, a[href]") !== null)
    ) {
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
    if (state.busy.kind !== "idle") return;
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
    if (state.busy.kind !== "idle" || state.outputSyncError !== undefined) return;
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
    if (session.getState().busy.kind !== "idle") return;
    if (session.getState().outputSyncError !== undefined) return;
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
