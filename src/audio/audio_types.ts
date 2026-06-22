/**
 * src/audio/audio_types.ts
 * analyzer 결과를 Web Audio 또는 Tone.js backend가 소비할 재생 schedule 계약으로 변환하기 위한 타입을 정의한다.
 */

import type {
  AnalysisResult,
  AnalyzedTimeSegment,
  TimeFraction,
} from "../core/analyze/types";
import type { TrackId } from "../core/score/types";

/** audio schedule 생성에 필요한 analyzer 결과와 track 선택 정보. */
export type AudioBuildInput = {
  analysis: AnalysisResult;
  activeTrackIds: TrackId[];
};

/** timing timeline을 초 단위 score time으로 변환하는 조회 인터페이스. */
export type TickTimeMapper = {
  tickToSeconds(tick: TimeFraction): number;
  secondsToTick(seconds: number): TimeFraction;
  getDurationSeconds(): number;
};

/** TickTimeMapper 내부에서 사용할 수 있도록 정규화한 tempo segment. */
export type TempoMapSegment = {
  source: AnalyzedTimeSegment;
  startTickNumber: number;
  endTickNumber: number;
  startSeconds: number;
  endSeconds: number;
  startBpm: number;
  endBpm: number;
  bpmCurve: "instant" | "linear";
  stepsPerBeat: number;
};

/** lookahead scheduler가 시간 범위로 schedule event를 조회하기 위한 큐 인터페이스. */
export type AudioEventQueue = {
  getEventsStartingInRange(startSeconds: number, endSeconds: number): AudioScheduleEvent[];
  getEventsOverlappingRange(startSeconds: number, endSeconds: number): AudioScheduleEvent[];
  getEventCount(): number;
};

/** audio backend가 재생할 수 있도록 초 단위로 정규화된 전체 schedule. */
export type AudioSchedule = {
  durationSeconds: number;
  events: AudioScheduleEvent[];
};

/** audio schedule event 공통 필드. */
export type AudioScheduleEventBase = {
  eventId: string;
  trackId: TrackId;
  startTick: TimeFraction;
  endTick: TimeFraction;
  startSeconds: number;
  endSeconds: number;
  velocity: number;
  automation: AudioAutomationEvent[];
  sourceEventKind: "note" | "gliss" | "glissChain";
};

/** analyzer의 NoteEvent에서 파생된 단일 발음 예약 정보. */
export type AudioNoteScheduleEvent = AudioScheduleEventBase & {
  sourceEventKind: "note";
  midi: number;
  centOffset: number;
  effects: AudioScheduleEffect[];
};

/** analyzer의 GlissEvent에서 파생된 fallback gliss 발음 예약 정보. */
export type AudioGlissScheduleEvent = AudioScheduleEventBase & {
  sourceEventKind: "gliss";
  startMidi: number;
  startCentOffset: number;
  endMidi: number;
  endCentOffset: number;
  curve: "linear";
  crossfadeSeconds: number;
  effects: AudioScheduleEffect[];
};

/** 연결된 GlissEvent 체인 내부의 개별 pitch ramp 세그먼트. */
export type AudioGlissChainSegment = {
  startSeconds: number;
  endSeconds: number;
  startMidi: number;
  startCentOffset: number;
  endMidi: number;
  endCentOffset: number;
  curve: "linear";
};

/** 연결된 GlissEvent 여러 개를 하나의 oscillator로 잇는 발음 예약 정보. */
export type AudioGlissChainScheduleEvent = AudioScheduleEventBase & {
  sourceEventKind: "glissChain";
  segments: AudioGlissChainSegment[];
  fadeSeconds: number;
  effects: AudioScheduleEffect[];
};

/** audio backend가 예약할 수 있는 발음 이벤트. */
export type AudioScheduleEvent =
  | AudioNoteScheduleEvent
  | AudioGlissScheduleEvent
  | AudioGlissChainScheduleEvent;

/** NoteEffectSegment에서 audio backend로 넘기는 구간 효과 정보. */
export type AudioScheduleEffect =
  | {
      kind: "vibrato";
      startSeconds: number;
      endSeconds: number;
    }
  | {
      kind: "tremolo";
      startSeconds: number;
      endSeconds: number;
      durationTicks: number;
      division: number;
    };

/** GlissEvent나 dynamics timeline에서 파생될 AudioParam 자동화 후보. */
export type AudioAutomationEvent =
  | {
      kind: "pitchRamp";
      startSeconds: number;
      endSeconds: number;
      startMidi: number;
      startCentOffset: number;
      endMidi: number;
      endCentOffset: number;
      curve: "linear";
    }
  | {
      kind: "gainRamp";
      startSeconds: number;
      endSeconds: number;
      startValue: number;
      endValue: number;
      curve: "instant" | "linear";
    }
  | {
      kind: "gainScale";
      startSeconds: number;
      endSeconds: number;
      startValue: number;
      endValue: number;
      curve: "instant" | "linear";
    };

/** score time 구간 반복 상태. buffer loop가 아니라 scheduler loop를 뜻한다. */
export type PlaybackLoopState =
  | {
      enabled: false;
    }
  | {
      enabled: true;
      startSeconds: number;
      endSeconds: number;
    };

/** playback controller가 보관하는 재생 상태. */
export type PlaybackState =
  | {
      kind: "stopped";
      seekScoreSeconds: number;
      loop: PlaybackLoopState;
    }
  | {
      kind: "playing";
      audioStartedAt: number;
      scoreStartedAt: number;
      loop: PlaybackLoopState;
    }
  | {
      kind: "paused";
      pausedAtScoreSeconds: number;
      loop: PlaybackLoopState;
    };

/** lookahead scheduler 동작을 조정하는 옵션. */
export type AudioSchedulerOptions = {
  lookaheadSeconds: number;
  schedulerIntervalMs: number;
  noteReleaseSeconds: number;
};

/** 실제 음원 구현체가 따라야 할 최소 backend 계약. */
export type AudioBackend = {
  ensureStarted(): Promise<void>;
  scheduleEvent(event: AudioScheduleEvent, offsetSeconds: number): void;
  getCurrentTime(): number;
  stopAll(): void;
  dispose(): void;
};

/** lookahead window 단위로 AudioBackend 예약을 수행하는 scheduler 계약. */
export type AudioLookaheadScheduler = {
  scheduleLookahead(
    currentScoreSeconds: number,
    loop: PlaybackLoopState,
    loopCycleIndex?: number,
  ): number;
  resetScheduledEvents(): void;
  getScheduledEventCount(): number;
};
