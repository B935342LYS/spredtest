/** YouTube 입력 확정·패널 상태·영상 요청 수명을 playback과 연결한다. */
import { MAX_YOUTUBE_LOCAL_OFFSET_MS, saveYoutubeLocalOffsetMs } from "../../infra/youtube_preferences";
import type { AppPlaybackRuntime } from "../playback/app_playback";
import type { AppDom, AppState } from "../app_types";
import { syncLeftStatus } from "../app_ui_sync";
import { applyYoutubeSyncEditToState } from "../app_runtime";
import { clampYoutubeOffsetMs, MAX_YOUTUBE_OFFSET_MS, MIN_YOUTUBE_OFFSET_MS, YOUTUBE_OFFSET_STEP_MS } from "../../core/score/score_limits";
import { createYoutubePlayer } from "./youtube_player";
import { isYoutubeBeforeVideoStart, scoreSecondsToYoutubeSeconds, secondsUntilYoutubeStart,
  shouldResyncYoutubeDrift, canResumeYoutubeWithoutSeek, getEffectiveYoutubeOffsetMs } from "./youtube_sync";
import type { YoutubeModeState, YoutubePlayerHandle } from "./youtube_types";
import { parseYoutubeVideoId } from "./youtube_url";

const DRIFT_CHECK_INTERVAL_MS = 1000;
const SEEK_COOLDOWN_MS = 500;
type YoutubeSeekOptions = { forceSeek?: boolean };
/** YouTube binding이 참조하는 현재 앱 상태와 재생 runtime. */
export type YoutubeBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  getPlaybackRuntime(): AppPlaybackRuntime;
};
/** 기존 playback binding에 제공하는 YouTube follower 제어 계약. */
export type YoutubePlaybackControl = {
  syncInputsFromScore(): void;
  playAtCurrentScoreTime(resumeFromPause?: boolean): void;
  pause(): void;
  stop(): void;
  seekToCurrentScoreTime(): void;
  dispose(): void;
};

/**
 * YouTube 패널과 현재 악보 시계를 연결한다.
 * - 인수 : dom : 패널과 앱 상태 표시 요소
 * - 인수 : session : 현재 상태·재생 runtime 접근자
 * - 인수 : createPlayer : 기본 player 생성기; 테스트에서는 지연 가능한 대역 사용
 * - 반환값 : 기존 playback에서 사용할 follower 제어 객체
 */
export function bindYoutubeControls(
  dom: AppDom,
  session: YoutubeBindingSession,
  createPlayer: typeof createYoutubePlayer = createYoutubePlayer,
): YoutubePlaybackControl {
  let enabled = false;
  let disposed = false;
  let modeState: YoutubeModeState = { kind: "idle" };
  let inputError = "";
  let player: YoutubePlayerHandle | null = null;
  let requestGeneration = 0;
  let requestAbort: AbortController | null = null;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  let driftIntervalId: ReturnType<typeof setInterval> | null = null;
  let videoStartTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let isBeforeVideoStart = false;
  let lastSeekAtMs = 0;
  const listeners = new AbortController();
  const eventOptions = { signal: listeners.signal };
  syncYoutubeOffsetInputBounds();

  /** 합산 보정값을 조회한다. - 인수 : 없음 - 반환값 : 최신 곡·Local 합계 ms */
  function effectiveOffsetMs(): number {
    const state = session.getState();
    return getEffectiveYoutubeOffsetMs(state.document.score.musicData.youtube.offsetMs, state.youtubeLocalOffsetMs);
  }

  /**
   * 활성 여부·영상 상태·입력 오류를 독립적으로 표시한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function syncYoutubePanel(): void {
    dom.youtubeToggle.checked = enabled;
    dom.youtubeToggle.setAttribute("aria-expanded", String(enabled));
    if (!enabled && (dom.youtubeControls.contains(document.activeElement) || dom.youtubePlayerShell.contains(document.activeElement))) {
      dom.youtubeToggle.focus();
    }
    dom.youtubeControls.hidden = !enabled;
    const showVideo = enabled && (modeState.kind === "loading" || modeState.kind === "ready");
    dom.youtubePlayerShell.hidden = !showVideo;
    dom.youtubePlayerShell.dataset.state = enabled ? modeState.kind : "off";
    dom.youtubeVideoInput.setAttribute("aria-invalid", String(inputError !== ""));
    const text = inputError || (!enabled ? "Off" : modeState.kind === "error" ? modeState.message
      : modeState.kind === "loading" ? "Loading" : modeState.kind === "ready" ? "Ready" : "No video");
    dom.youtubeStatus.textContent = text;
    dom.youtubeStatus.title = text;
    dom.youtubeStatus.dataset.level = inputError ? "error" : enabled ? modeState.kind : "off";
  }

  /**
   * 이전 요청의 예약·준비·player를 무효화한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function cancelVideoRequest(): void {
    requestGeneration += 1;
    if (loadTimer !== null) clearTimeout(loadTimer);
    loadTimer = null;
    stopDriftCheck();
    clearVideoStartTimer();
    requestAbort?.abort();
    requestAbort = null;
    player?.dispose();
    player = null;
    isBeforeVideoStart = false;
    lastSeekAtMs = 0;
  }

  /**
   * 영상 오류에서 패널을 유지하고 현재 요청만 정리한다.
   * - 인수 : message : 표시할 오류
   * - 반환값 : 없음
   */
  function failVideo(message: string): void {
    cancelVideoRequest();
    modeState = { kind: "error", message };
    syncYoutubePanel();
    setAppStatus(message, "error");
  }

  /**
   * 준비된 영상을 최신 score 위치로 맞추고 현재 재생 상태를 따른다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function alignReadyVideo(): void {
    if (!enabled || player === null || modeState.kind !== "ready") return;
    const playing = session.getPlaybackRuntime().controller.isPlaying();
    if (!playing) player.pause();
    const canPlay = syncPlayerToCurrentScoreTime({ forceSeek: true });
    if (playing && canPlay) player?.play();
    if (playing) startDriftCheck();
  }

  /**
   * 저장된 ID를 새 player에 로드한다. 이전 요청은 현재 상태를 수정할 수 없다.
   * - 인수 : 없음
   * - 반환값 : 요청 처리 완료
   */
  async function loadSavedVideo(): Promise<void> {
    if (!enabled || disposed) return;
    cancelVideoRequest();
    const videoId = session.getState().document.score.musicData.youtube.videoId;
    if (videoId === "") { modeState = { kind: "idle" }; syncYoutubePanel(); return; }
    if (parseYoutubeVideoId(videoId) === null) { failVideo("Invalid saved YouTube ID."); return; }
    const generation = requestGeneration;
    const abort = new AbortController();
    requestAbort = abort;
    modeState = { kind: "loading", videoId };
    syncYoutubePanel();
    /** 현재 요청의 소유권을 확인한다. - 인수 : 없음 - 반환값 : 아직 유효한지 여부 */
    const isCurrent = (): boolean => enabled && !disposed && generation === requestGeneration && !abort.signal.aborted;
    try {
      const created = await createPlayer(dom.youtubePlayer, videoId, (message) => {
        if (isCurrent()) failVideo(message);
      }, abort.signal);
      if (!isCurrent()) { created.dispose(); return; }
      player = created;
      const seconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();
      await created.loadVideo(videoId, scoreSecondsToYoutubeSeconds(seconds, effectiveOffsetMs()));
      if (!isCurrent()) return;
      modeState = { kind: "ready", videoId };
      syncYoutubePanel();
      // 로딩 중 offset·재생 위치·pause 변경은 최신 상태를 다시 읽어 적용한다.
      alignReadyVideo();
    } catch (error: unknown) {
      if (isCurrent()) failVideo(error instanceof Error ? error.message : "YouTube load failed.");
    }
  }

  /**
   * 같은 입력 확정/Reload 이벤트 안의 요청을 한 번으로 합친다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function queueVideoLoad(): void {
    if (!enabled || disposed) return;
    cancelVideoRequest();
    loadTimer = setTimeout(() => { loadTimer = null; void loadSavedVideo(); }, 0);
  }

  /**
   * 곡 메타데이터만 갱신하고 상태 문구를 표시한다.
   * - 인수 : videoId : 정규화된 영상 ID
   * - 인수 : offsetMs : 곡 보정값
   * - 반환값 : 실제 변경 여부
   */
  function saveMetadata(videoId: string, offsetMs: number): boolean {
    const state = session.getState();
    const next = applyYoutubeSyncEditToState(state, videoId, offsetMs);
    if (next === state) return false;
    session.setState(next);
    syncLeftStatus(dom, next);
    return true;
  }

  /** Video만 확정한다. - 인수 : 없음 - 반환값 : 없음 */
  function commitVideoInput(): void {
    if (!enabled || disposed) return;
    const raw = dom.youtubeVideoInput.value.trim();
    const videoId = raw === "" ? "" : parseYoutubeVideoId(raw);
    if (videoId === null) {
      inputError = "Invalid YouTube URL or ID.";
      syncYoutubePanel();
      setAppStatus(inputError, "error");
      return;
    }
    inputError = "";
    dom.youtubeVideoInput.value = videoId;
    const changed = saveMetadata(videoId, session.getState().document.score.musicData.youtube.offsetMs);
    if (videoId === "") {
      cancelVideoRequest();
      modeState = { kind: "idle" };
    } else if (changed) queueVideoLoad();
    syncYoutubePanel();
  }

  /** 곡 offset만 확정한다. - 인수 : 없음 - 반환값 : 없음 */
  function commitScoreOffset(): void {
    if (!enabled || disposed) return;
    const youtube = session.getState().document.score.musicData.youtube;
    const raw = dom.youtubeOffsetInput.value.trim();
    const value = Number(raw);
    const normalized = raw !== "" && Number.isFinite(value) ? clampYoutubeOffsetMs(value) : youtube.offsetMs;
    dom.youtubeOffsetInput.value = String(normalized);
    if (!saveMetadata(youtube.videoId, normalized)) return;
    clearVideoStartTimer();
    alignReadyVideo();
  }

  /** Local만 저장하고 재정렬한다. - 인수 : 없음 - 반환값 : 없음 */
  function commitLocalOffset(): void {
    if (!enabled || disposed) return;
    const state = session.getState();
    const raw = dom.youtubeLocalOffsetInput.value.trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value)) {
      dom.youtubeLocalOffsetInput.value = String(state.youtubeLocalOffsetMs);
      return;
    }
    const normalized = saveYoutubeLocalOffsetMs(value);
    dom.youtubeLocalOffsetInput.value = String(normalized);
    if (normalized === state.youtubeLocalOffsetMs) return;
    session.setState({ ...state, youtubeLocalOffsetMs: normalized });
    clearVideoStartTimer();
    alignReadyVideo();
  }

  /**
   * 초기화·악보 교체 때만 입력 전체와 활성 상태를 재설정한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function syncInputsFromScore(): void {
    enabled = false;
    cancelVideoRequest();
    modeState = { kind: "idle" };
    inputError = "";
    const state = session.getState();
    dom.youtubeVideoInput.value = state.document.score.musicData.youtube.videoId;
    dom.youtubeOffsetInput.value = String(state.document.score.musicData.youtube.offsetMs);
    dom.youtubeLocalOffsetInput.value = String(state.youtubeLocalOffsetMs);
    syncYoutubePanel();
  }

  // 모든 입력은 change/Enter에서만 확정하며 IME 조합 중 Enter는 무시한다.
  const commits = [
    [dom.youtubeVideoInput, commitVideoInput], [dom.youtubeOffsetInput, commitScoreOffset],
    [dom.youtubeLocalOffsetInput, commitLocalOffset],
  ] as const;
  for (const [input, commit] of commits) {
    input.addEventListener("change", commit, eventOptions);
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      commit();
    }, eventOptions);
  }
  dom.youtubeToggle.addEventListener("change", () => {
    enabled = dom.youtubeToggle.checked;
    if (enabled) queueVideoLoad();
    else { cancelVideoRequest(); modeState = { kind: "idle" }; }
    syncYoutubePanel();
  }, eventOptions);
  // 클릭 시 blur 확정과 Reload를 같은 이벤트 안에서 처리하여 이중 로드를 막는다.
  dom.youtubeReloadButton.addEventListener("pointerdown", (event) => {
    if (commits.some(([input]) => input === document.activeElement)) event.preventDefault();
  }, eventOptions);
  dom.youtubeReloadButton.addEventListener("click", () => {
    if (!enabled) return;
    for (const [input, commit] of commits) if (input === document.activeElement) commit();
    dom.youtubeReloadButton.focus();
    queueVideoLoad();
  }, eventOptions);
  syncInputsFromScore();

  return {
    syncInputsFromScore,
    /** score 위치에서 시작/재개한다. - 인수 : resumeFromPause : 일시정지 재개 - 반환값 : 없음 */
    playAtCurrentScoreTime(resumeFromPause = false): void {
      if (!enabled || player === null || modeState.kind !== "ready") return;
      const seconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();
      const canKeep = canResumeYoutubeWithoutSeek(resumeFromPause, seconds, player.getCurrentTime(), effectiveOffsetMs());
      if (canKeep) { clearVideoStartTimer(); isBeforeVideoStart = false; }
      const canPlay = canKeep || syncPlayerToScoreSeconds(seconds, { forceSeek: true });
      if (canPlay) player?.play();
      startDriftCheck();
    },
    /** 영상만 일시정지한다. - 인수 : 없음 - 반환값 : 없음 */
    pause(): void { stopDriftCheck(); clearVideoStartTimer(); player?.pause(); },
    /** 영상만 악보 0초로 정렬한다. - 인수 : 없음 - 반환값 : 없음 */
    stop(): void {
      stopDriftCheck(); clearVideoStartTimer();
      syncPlayerToScoreSeconds(0, { forceSeek: true }); player?.pause();
    },
    /** 현재 score 위치로 정렬한다. - 인수 : 없음 - 반환값 : 없음 */
    seekToCurrentScoreTime(): void { syncPlayerToCurrentScoreTime({ forceSeek: true }); },
    /** binding 이벤트와 player를 해제한다. - 인수 : 없음 - 반환값 : 없음 */
    dispose(): void {
      disposed = true; enabled = false;
      listeners.abort(); cancelVideoRequest(); modeState = { kind: "idle" }; syncYoutubePanel();
    },
  };

  /**
   * 현재 score time 기준으로 YouTube player를 seek한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function syncPlayerToCurrentScoreTime(options: YoutubeSeekOptions = {}): boolean {
    const scoreSeconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();

    return syncPlayerToScoreSeconds(scoreSeconds, options);
  }

  /**
   * 지정한 score time 기준으로 YouTube player를 seek한다.
   * - 인수 : scoreSeconds : 기준 score seconds
   * - 인수 : options : 명시적 사용자 seek인지 여부
   * - 반환값 : YouTube 영상을 지금 재생할 수 있는지 여부
   */
  function syncPlayerToScoreSeconds(
    scoreSeconds: number,
    options: YoutubeSeekOptions = {},
  ): boolean {
    const shouldForceSeek = options.forceSeek === true;

    if (!enabled || player === null || modeState.kind !== "ready") {
      return false;
    }

    // 합산 offset으로 영상 시작 전이면 0초에 한 번만 정렬하고 score playback만 진행한다.
    if (isYoutubeBeforeVideoStart(scoreSeconds, effectiveOffsetMs())) {
      if (!isBeforeVideoStart || shouldForceSeek) {
        player.seekTo(0);
        lastSeekAtMs = Date.now();
      }

      player.pause();
      scheduleVideoStartAtBoundary(scoreSeconds, effectiveOffsetMs());
      isBeforeVideoStart = true;
      return false;
    }

    const youtubeSeconds = scoreSecondsToYoutubeSeconds(scoreSeconds, effectiveOffsetMs());
    const isCrossingStartBoundary = isBeforeVideoStart;

    clearVideoStartTimer();
    isBeforeVideoStart = false;

    if (shouldForceSeek || isCrossingStartBoundary || canSeekNow()) {
      player.seekTo(youtubeSeconds);
      lastSeekAtMs = Date.now();
    }

    return true;
  }

  /**
   * 재생 중 drift를 주기적으로 확인한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function startDriftCheck(): void {
    stopDriftCheck();
    driftIntervalId = setInterval(() => {
      if (!enabled || player === null || modeState.kind !== "ready" || !session.getPlaybackRuntime().controller.isPlaying()) {
        stopDriftCheck();
        return;
      }

      const scoreSeconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();

      if (isYoutubeBeforeVideoStart(scoreSeconds, effectiveOffsetMs())) {
        syncPlayerToScoreSeconds(scoreSeconds);
        return;
      }

      if (isBeforeVideoStart) {
        const canPlayVideo = syncPlayerToScoreSeconds(scoreSeconds);

        if (canPlayVideo) {
          player.play();
        }

        return;
      }

      if (!canSeekNow()) {
        return;
      }

      if (shouldResyncYoutubeDrift(scoreSeconds, player.getCurrentTime(), effectiveOffsetMs())) {
        syncPlayerToScoreSeconds(scoreSeconds);
      }
    }, DRIFT_CHECK_INTERVAL_MS);
  }

  /**
   * 최근 seek 직후 YouTube iframe 반영 지연 중인지 확인한다.
   * - 인수 : 없음
   * - 반환값 : 새 seek를 보내도 되는지 여부
   */
  function canSeekNow(): boolean {
    return Date.now() - lastSeekAtMs >= SEEK_COOLDOWN_MS;
  }

  /**
   * YouTube offset input의 HTML 범위 속성을 저장 정책 상수와 동기화한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function syncYoutubeOffsetInputBounds(): void {
    dom.youtubeOffsetInput.min = String(MIN_YOUTUBE_OFFSET_MS);
    dom.youtubeOffsetInput.max = String(MAX_YOUTUBE_OFFSET_MS);
    dom.youtubeOffsetInput.step = String(YOUTUBE_OFFSET_STEP_MS);
    dom.youtubeLocalOffsetInput.min = String(-MAX_YOUTUBE_LOCAL_OFFSET_MS);
    dom.youtubeLocalOffsetInput.max = String(MAX_YOUTUBE_LOCAL_OFFSET_MS);
    dom.youtubeLocalOffsetInput.step = "1";
  }

  /**
   * drift 확인 interval을 중지한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function stopDriftCheck(): void {
    if (driftIntervalId !== null) {
      clearInterval(driftIntervalId);
      driftIntervalId = null;
    }
  }

  /**
   * 합산 offset으로 영상 시작 전 구간을 재생 중일 때 영상 0초 재생을 예약한다.
   * - 인수 : scoreSeconds : 예약 기준 score seconds
   * - 인수 : offsetMs : 곡 offset과 Local offset을 합산한 ms
   * - 반환값 : 없음
   */
  function scheduleVideoStartAtBoundary(scoreSeconds: number, offsetMs: number): void {
    clearVideoStartTimer();

    if (
      player === null ||
      !enabled ||
      modeState.kind !== "ready" ||
      !session.getPlaybackRuntime().controller.isPlaying()
    ) {
      return;
    }

    const delayMs = Math.max(0, Math.ceil(secondsUntilYoutubeStart(scoreSeconds, offsetMs) * 1000));

    videoStartTimeoutId = setTimeout(() => {
      videoStartTimeoutId = null;

      if (
        player === null ||
        !enabled ||
        modeState.kind !== "ready" ||
        !session.getPlaybackRuntime().controller.isPlaying()
      ) {
        return;
      }

      const currentScoreSeconds = session.getPlaybackRuntime().controller.getCurrentScoreSeconds();

      if (isYoutubeBeforeVideoStart(currentScoreSeconds, effectiveOffsetMs())) {
        scheduleVideoStartAtBoundary(currentScoreSeconds, effectiveOffsetMs());
        return;
      }

      // 영상 시작 경계에서는 drift interval에 맡기지 않고 영상 0초부터 직접 시작한다.
      player.seekTo(0);
      lastSeekAtMs = Date.now();
      isBeforeVideoStart = false;
      player.play();
    }, delayMs);
  }

  /**
   * 예약된 YouTube 시작 timer를 취소한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  function clearVideoStartTimer(): void {
    if (videoStartTimeoutId !== null) {
      clearTimeout(videoStartTimeoutId);
      videoStartTimeoutId = null;
    }
  }

  /**
   * 왼쪽 status line에 YouTube 조작 결과를 표시한다.
   * - 인수 : text : 표시할 메시지
   * - 인수 : level : 메시지 수준
   * - 반환값 : 없음
   */
  function setAppStatus(text: string, level: AppState["statusMessage"]["level"]): void {
    const state = session.getState();

    session.setState({
      ...state,
      statusMessage: {
        level,
        text,
      },
    });
    syncLeftStatus(dom, session.getState());
  }
}
