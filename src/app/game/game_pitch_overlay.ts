/**
 * 게임 모드 pitch frame을 score 영역의 DOM overlay로 표시한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import type {
  AnalyzedEvent,
  NoteEvent,
} from "../../core/analyze/types";
import type { TickTimeMapper } from "../../audio/audio_types";
import {
  createTickTimeMapper,
  numberToTimeFraction,
  timeFractionToNumber,
} from "../../audio/tick_time_mapper";
import { xToColumn } from "../../renderer/canvas_coordinate";
import type { CanvasLayoutRow } from "../../renderer/canvas_types";
import {
  createGamePitchCorrectionState,
  resolvePitchClassCandidateMidiWithHysteresis,
  type GamePitchClassTarget,
} from "./game_pitch_math";

const TARGET_LOOKAHEAD_SECONDS = 0.1;

let cachedTimingTimeline: AppState["analysis"]["timingTimeline"] | null = null;
let cachedTimeMapper: TickTimeMapper | null = null;
let pitchCorrectionState = createGamePitchCorrectionState();

/**
 * 현재 game mode pitch frame을 score canvas 위 초록색 dot으로 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 없음
 */
export function syncGamePitchOverlay(dom: AppDom, state: AppState): void {
  dom.gamePitchOverlay.replaceChildren();

  const frame = getVisiblePitchFrame(state);

  if (
    frame === null ||
    !frame.isVoiced ||
    frame.midi === null ||
    frame.centOffset === null ||
    state.layout === null
  ) {
    if (state.gameMode.kind === "off" || frame === null) {
      pitchCorrectionState = createGamePitchCorrectionState();
    }
    return;
  }

  const currentTick = xToColumn(dom.scoreArea.scrollLeft, state.layout);
  const targetLookupTick = resolveLookaheadTargetTick(state, currentTick);
  const targetPitches = collectActiveTargetPitches(state, targetLookupTick);
  const displayPitchMidi = resolvePitchClassCandidateMidiWithHysteresis(
    frame.midi,
    frame.centOffset,
    targetPitches,
    frame.capturedAtMs,
    pitchCorrectionState,
  );
  const y = resolvePitchY(state.layout.rows, displayPitchMidi);

  if (y === null) {
    return;
  }

  const dot = document.createElement("div");

  dot.className = "game-pitch-dot";
  dot.style.left = `${dom.scoreArea.scrollLeft}px`;
  dot.style.top = `${y}px`;
  dot.title = `${frame.frequencyHz?.toFixed(1) ?? "--"} Hz`;
  dom.gamePitchOverlay.append(dot);
}

/**
 * 현재 game mode 상태에서 화면에 표시할 pitch frame을 꺼낸다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 표시 가능한 pitch frame 또는 null
 */
function getVisiblePitchFrame(state: AppState) {
  if (
    state.gameMode.kind === "ready" ||
    state.gameMode.kind === "countdown" ||
    state.gameMode.kind === "playing" ||
    state.gameMode.kind === "paused" ||
    state.gameMode.kind === "finished"
  ) {
    return state.gameMode.pitchFrame;
  }

  return null;
}

/**
 * 현재 재생 기준 tick에 걸친 active track note target pitch를 모은다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : currentTick : playback 기준선이 가리키는 score tick
 * - 반환값 : pitch class 후보 선택에 사용할 target pitch 목록
 */
function collectActiveTargetPitches(
  state: AppState,
  currentTick: number,
): GamePitchClassTarget[] {
  if (!Number.isFinite(currentTick) || state.activeTrackIds.length === 0) {
    return [];
  }

  const activeTrackIdSet = new Set(state.activeTrackIds);
  const targets: GamePitchClassTarget[] = [];

  // active track의 현재 tick note만 후보로 두어 다른 옥타브 입력이 target 주변에 표시되도록 한다.
  for (const trackResult of state.analysis.trackResults) {
    if (!activeTrackIdSet.has(trackResult.trackId)) {
      continue;
    }

    for (const event of trackResult.events) {
      if (!isNoteEvent(event) || !containsTick(event, currentTick)) {
        continue;
      }

      targets.push({
        midi: event.sound.midi,
        centOffset: event.sound.centOffset,
      });
    }
  }

  return targets;
}

/**
 * 현재 playback 기준 tick에서 target 후보 조회용 lookahead tick을 계산한다.
 * - 인수 : state : 현재 앱 상태
 * - 인수 : currentTick : playback 기준선이 가리키는 score tick
 * - 반환값 : tempo map 기준으로 100ms 앞선 score tick. 변환 실패 시 원래 tick
 */
function resolveLookaheadTargetTick(state: AppState, currentTick: number): number {
  if (!Number.isFinite(currentTick) || state.analysis.timingTimeline.length === 0) {
    return currentTick;
  }

  try {
    const timeMapper = getCachedTimeMapper(state);
    const currentSeconds = timeMapper.tickToSeconds(numberToTimeFraction(currentTick));
    const lookaheadTick = timeMapper.secondsToTick(currentSeconds + TARGET_LOOKAHEAD_SECONDS);

    return timeFractionToNumber(lookaheadTick);
  } catch {
    return currentTick;
  }
}

/**
 * overlay frame마다 TickTimeMapper를 다시 만들지 않도록 timingTimeline 참조 기준 cache를 쓴다.
 * - 인수 : state : 현재 앱 상태
 * - 반환값 : 현재 analysis timingTimeline에 대응하는 TickTimeMapper
 */
function getCachedTimeMapper(state: AppState): TickTimeMapper {
  if (cachedTimingTimeline !== state.analysis.timingTimeline || cachedTimeMapper === null) {
    cachedTimingTimeline = state.analysis.timingTimeline;
    cachedTimeMapper = createTickTimeMapper(state.analysis.timingTimeline);
  }

  return cachedTimeMapper;
}

/**
 * analyzer event를 NoteEvent로 좁힌다.
 * - 인수 : event : 검사할 analyzer event
 * - 반환값 : NoteEvent이면 true
 */
function isNoteEvent(event: AnalyzedEvent): event is NoteEvent {
  return event.eventKind === "note";
}

/**
 * NoteEvent의 배타적 tick 범위가 현재 tick을 포함하는지 확인한다.
 * - 인수 : event : 검사할 note event
 * - 인수 : currentTick : 현재 playback 기준 tick
 * - 반환값 : event가 현재 tick에 걸쳐 있으면 true
 */
function containsTick(event: NoteEvent, currentTick: number): boolean {
  const startTick = timeFractionToNumber(event.time.startTick);
  const endTick = timeFractionToNumber(event.time.endTick);

  return currentTick >= startTick && currentTick < endTick;
}

/**
 * MIDI pitch를 현재 layout의 y 좌표로 변환한다.
 * - 인수 : rows : 현재 renderer layout row 목록
 * - 인수 : pitchMidi : cent offset을 포함한 실수 MIDI pitch
 * - 반환값 : score stage CSS pixel y 좌표
 */
function resolvePitchY(rows: readonly CanvasLayoutRow[], pitchMidi: number): number | null {
  const noteRows = rows
    .filter((row) => row.kind === "note" && row.midi !== undefined)
    .map((row) => ({
      midi: row.midi ?? 0,
      centerY: row.y + row.height / 2,
    }))
    .sort((a, b) => a.midi - b.midi);

  if (noteRows.length === 0) {
    return null;
  }

  const first = noteRows[0];
  const last = noteRows[noteRows.length - 1];

  if (first === undefined || last === undefined) {
    return null;
  }

  if (pitchMidi <= first.midi) {
    return first.centerY;
  }

  if (pitchMidi >= last.midi) {
    return last.centerY;
  }

  for (let index = 0; index < noteRows.length - 1; index += 1) {
    const lower = noteRows[index];
    const upper = noteRows[index + 1];

    if (lower === undefined || upper === undefined) {
      continue;
    }

    if (lower.midi <= pitchMidi && pitchMidi <= upper.midi) {
      const ratio = (pitchMidi - lower.midi) / Math.max(1e-6, upper.midi - lower.midi);

      return lower.centerY + (upper.centerY - lower.centerY) * ratio;
    }
  }

  return null;
}
