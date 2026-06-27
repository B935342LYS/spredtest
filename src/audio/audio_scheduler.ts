/**
 * src/audio/audio_scheduler.ts
 * AudioEventQueue와 AudioBackend 사이에서 lookahead 기반 예약을 수행한다.
 */

import type {
  AudioAutomationEvent,
  AudioBackend,
  AudioEventQueue,
  AudioGlissChainScheduleEvent,
  AudioGlissChainSegment,
  AudioGlissScheduleEvent,
  AudioLookaheadScheduler,
  AudioNoteScheduleEvent,
  AudioScheduleEvent,
  PlaybackLoopState,
} from "./audio_types";
import { measurePerf } from "../infra/perf_profiler";

/** lookahead scheduler 생성 입력. */
export type AudioLookaheadSchedulerInput = {
  queue: AudioEventQueue;
  backend: AudioBackend;
  lookaheadSeconds: number;
};

type LookaheadQueryWindow = {
  queryStartSeconds: number;
  queryEndSeconds: number;
  offsetBaseSeconds: number;
  cycleOffset: number;
  hardClipEndSeconds: number | null;
};

/**
 * AudioEventQueue에서 가까운 미래 이벤트를 조회해 backend에 예약하는 scheduler를 만든다.
 * - 인수 : input : event queue, backend, lookahead 설정
 * - 반환값 : AudioLookaheadScheduler : playback controller가 호출할 scheduler
 */
export function createAudioLookaheadScheduler(
  input: AudioLookaheadSchedulerInput,
): AudioLookaheadScheduler {
  validateLookaheadSeconds(input.lookaheadSeconds);

  const scheduledKeys = new Set<string>();

  return {
    scheduleLookahead(
      currentScoreSeconds: number,
      loop: PlaybackLoopState,
      loopCycleIndex = 0,
    ): number {
      validateCurrentScoreSeconds(currentScoreSeconds);
      measurePerf("audioScheduler.pruneScheduledKeysForLoop", () =>
        pruneScheduledKeysForLoop(scheduledKeys, loop, loopCycleIndex)
      );

      const windows = measurePerf("audioScheduler.createLookaheadQueryWindows", () =>
        createLookaheadQueryWindows(
          currentScoreSeconds,
          input.lookaheadSeconds,
          loop,
        )
      );
      let scheduledCount = 0;

      // lookahead window를 순회하며 아직 예약하지 않은 event만 backend에 넘긴다.
      for (const window of windows) {
        const overlappingEvents = measurePerf("audioScheduler.queryOverlappingEvents", () =>
          input.queue.getEventsOverlappingRange(
            window.queryStartSeconds,
            window.queryStartSeconds,
          )
        );
        scheduledCount += measurePerf("audioScheduler.scheduleOverlappingEvents", () => {
          let count = 0;

          for (const event of overlappingEvents) {
          const originalScheduledKey = createScheduledEventKey(
            event,
            loopCycleIndex + window.cycleOffset,
          );
          const scheduledKey = createResumedEventKey(
            event,
            loopCycleIndex + window.cycleOffset,
          );

          if (scheduledKeys.has(originalScheduledKey) || scheduledKeys.has(scheduledKey)) {
            continue;
          }

          const resumedEvent = createResumedScheduleEvent(event, window.queryStartSeconds);

          if (resumedEvent === null) {
            continue;
          }

          const clippedEvent = clipScheduleEventToHardEnd(
            resumedEvent,
            window.hardClipEndSeconds,
          );

          if (clippedEvent === null) {
            continue;
          }

          input.backend.scheduleEvent(
            clippedEvent,
            window.offsetBaseSeconds + clippedEvent.startSeconds,
          );
          scheduledKeys.add(scheduledKey);
          count += 1;
        }

          return count;
        });

        const events = measurePerf("audioScheduler.queryStartingEvents", () =>
          input.queue.getEventsStartingInRange(
            window.queryStartSeconds,
            window.queryEndSeconds,
          )
        );

        scheduledCount += measurePerf("audioScheduler.scheduleStartingEvents", () => {
          let count = 0;

          for (const event of events) {
          const scheduledKey = createScheduledEventKey(event, loopCycleIndex + window.cycleOffset);

          if (scheduledKeys.has(scheduledKey)) {
            continue;
          }

          const clippedEvent = clipScheduleEventToHardEnd(
            event,
            window.hardClipEndSeconds,
          );

          if (clippedEvent === null) {
            continue;
          }

          const offsetSeconds = clippedEvent.startSeconds + window.offsetBaseSeconds;

          if (offsetSeconds < 0) {
            continue;
          }

          input.backend.scheduleEvent(clippedEvent, offsetSeconds);
          scheduledKeys.add(scheduledKey);
          count += 1;
        }

          return count;
        });
      }

      return scheduledCount;
    },
    resetScheduledEvents(): void {
      scheduledKeys.clear();
    },
    getScheduledEventCount(): number {
      return scheduledKeys.size;
    },
  };
}

/**
 * loop playback에서 지난 cycle의 예약 key를 제거한다.
 * - 인수 : scheduledKeys : scheduler 중복 예약 방지 key set
 * - 인수 : loop : 현재 loop 상태
 * - 인수 : loopCycleIndex : playback controller가 관리하는 현재 loop cycle
 * - 반환값 : 없음
 */
function pruneScheduledKeysForLoop(
  scheduledKeys: Set<string>,
  loop: PlaybackLoopState,
  loopCycleIndex: number,
): void {
  if (!loop.enabled) {
    return;
  }

  const minKeptCycleIndex = Math.max(0, loopCycleIndex - 1);

  // wrap 직전/직후 lookahead를 고려해 현재 cycle과 직전 cycle key는 유지한다.
  for (const key of scheduledKeys) {
    const cycleText = key.slice(0, key.indexOf("|"));
    const cycleIndex = Number.parseInt(cycleText, 10);

    if (Number.isInteger(cycleIndex) && cycleIndex < minKeptCycleIndex) {
      scheduledKeys.delete(key);
    }
  }
}

/**
 * 현재 score time과 loop 상태로 조회할 schedule 구간을 만든다.
 * - 인수 : currentScoreSeconds : 현재 score time
 * - 인수 : lookaheadSeconds : 미리 예약할 초 단위 범위
 * - 인수 : loop : loop 상태
 * - 반환값 : LookaheadQueryWindow[] : scheduler가 조회할 하나 이상의 구간
 */
function createLookaheadQueryWindows(
  currentScoreSeconds: number,
  lookaheadSeconds: number,
  loop: PlaybackLoopState,
): LookaheadQueryWindow[] {
  if (!loop.enabled) {
    return [
      {
        queryStartSeconds: currentScoreSeconds,
        queryEndSeconds: currentScoreSeconds + lookaheadSeconds,
        offsetBaseSeconds: -currentScoreSeconds,
        cycleOffset: 0,
        hardClipEndSeconds: null,
      },
    ];
  }

  validateLoopState(loop);

  const clampedCurrent = clamp(
    currentScoreSeconds,
    loop.startSeconds,
    loop.endSeconds,
  );
  const lookaheadEnd = clampedCurrent + lookaheadSeconds;

  if (lookaheadEnd <= loop.endSeconds) {
    return [
      {
        queryStartSeconds: clampedCurrent,
        queryEndSeconds: lookaheadEnd,
        offsetBaseSeconds: -clampedCurrent,
        cycleOffset: 0,
        hardClipEndSeconds: loop.endSeconds,
      },
    ];
  }

  const wrappedEnd = loop.startSeconds + (lookaheadEnd - loop.endSeconds);

  return [
    {
      queryStartSeconds: clampedCurrent,
      queryEndSeconds: loop.endSeconds,
      offsetBaseSeconds: -clampedCurrent,
      cycleOffset: 0,
      hardClipEndSeconds: loop.endSeconds,
    },
    {
      queryStartSeconds: loop.startSeconds,
      queryEndSeconds: Math.min(wrappedEnd, loop.endSeconds),
      offsetBaseSeconds: loop.endSeconds - clampedCurrent - loop.startSeconds,
      cycleOffset: 1,
      hardClipEndSeconds: loop.endSeconds,
    },
  ];
}

/**
 * scheduler 중복 예약 방지용 key를 만든다.
 * - 인수 : event : 예약 후보 event
 * - 인수 : loopCycleIndex : playback controller가 관리하는 loop 반복 번호
 * - 인수 : window : event가 조회된 lookahead window
 * - 반환값 : scheduler 내부 key
 */
function createScheduledEventKey(
  event: AudioScheduleEvent,
  loopCycleIndex: number,
): string {
  return `${loopCycleIndex}|${event.eventId}`;
}

/**
 * 중간 재개용 event의 scheduler 중복 예약 방지 key를 만든다.
 * - 인수 : event : 원본 schedule event
 * - 인수 : loopCycleIndex : playback controller가 관리하는 loop 반복 번호
 * - 반환값 : scheduler 내부 key
 */
function createResumedEventKey(
  event: AudioScheduleEvent,
  loopCycleIndex: number,
): string {
  return `${loopCycleIndex}|resume|${event.eventId}`;
}

/**
 * 이미 진행 중인 event를 현재 score time부터 재생할 수 있는 event로 잘라낸다.
 * - 인수 : event : 원본 schedule event
 * - 인수 : resumeSeconds : 재개할 score time
 * - 반환값 : 중간 진입용 schedule event 또는 유효하지 않으면 null
 */
function createResumedScheduleEvent(
  event: AudioScheduleEvent,
  resumeSeconds: number,
): AudioScheduleEvent | null {
  if (resumeSeconds <= event.startSeconds || resumeSeconds >= event.endSeconds) {
    return null;
  }

  const clippedAutomation = clipAutomationForResume(event.automation, resumeSeconds);

  if (event.sourceEventKind === "note") {
    return createResumedNoteEvent(event, resumeSeconds, clippedAutomation);
  }

  if (event.sourceEventKind === "glissChain") {
    return createResumedGlissChainEvent(event, resumeSeconds, clippedAutomation);
  }

  return createResumedGlissEvent(event, resumeSeconds, clippedAutomation);
}

/**
 * 진행 중인 note event를 현재 score time부터 울리는 event로 변환한다.
 * - 인수 : event : 원본 note schedule event
 * - 인수 : resumeSeconds : 재개할 score time
 * - 인수 : automation : 재개 지점 기준으로 잘라낸 automation
 * - 반환값 : 중간 진입용 note event
 */
function createResumedNoteEvent(
  event: AudioNoteScheduleEvent,
  resumeSeconds: number,
  automation: AudioAutomationEvent[],
): AudioNoteScheduleEvent {
  return {
    ...event,
    eventId: `${event.eventId}:resume`,
    startSeconds: resumeSeconds,
    automation,
    effects: event.effects.filter((effect) => effect.endSeconds > resumeSeconds),
  };
}

/**
 * 진행 중인 gliss event를 현재 score time의 보간 pitch부터 울리는 event로 변환한다.
 * - 인수 : event : 원본 gliss schedule event
 * - 인수 : resumeSeconds : 재개할 score time
 * - 인수 : automation : 재개 지점 기준으로 잘라낸 automation
 * - 반환값 : 중간 진입용 gliss event
 */
function createResumedGlissEvent(
  event: AudioGlissScheduleEvent,
  resumeSeconds: number,
  automation: AudioAutomationEvent[],
): AudioGlissScheduleEvent {
  const startPitch = event.startMidi + event.startCentOffset / 100;
  const endPitch = event.endMidi + event.endCentOffset / 100;
  const ratio = (resumeSeconds - event.startSeconds) / (event.endSeconds - event.startSeconds);
  const resumedPitch = startPitch + (endPitch - startPitch) * Math.min(Math.max(ratio, 0), 1);
  const resumedMidi = Math.round(resumedPitch);
  const resumedCentOffset = (resumedPitch - resumedMidi) * 100;

  return {
    ...event,
    eventId: `${event.eventId}:resume`,
    startSeconds: resumeSeconds,
    startMidi: resumedMidi,
    startCentOffset: resumedCentOffset,
    automation,
    effects: event.effects.filter((effect) => effect.endSeconds > resumeSeconds),
  };
}

/**
 * 진행 중인 gliss chain event를 현재 score time부터 울리는 event로 변환한다.
 * - 인수 : event : 원본 gliss chain schedule event
 * - 인수 : resumeSeconds : 재개할 score time
 * - 인수 : automation : 재개 지점 기준으로 잘라낸 automation
 * - 반환값 : 중간 진입용 gliss chain event 또는 유효하지 않으면 null
 */
function createResumedGlissChainEvent(
  event: AudioGlissChainScheduleEvent,
  resumeSeconds: number,
  automation: AudioAutomationEvent[],
): AudioGlissChainScheduleEvent | null {
  const segments = event.segments
    .filter((segment) => segment.endSeconds > resumeSeconds)
    .map((segment) => clipGlissChainSegmentForResume(segment, resumeSeconds))
    .filter((segment): segment is AudioGlissChainSegment => segment !== null);

  if (segments.length === 0) {
    return null;
  }

  return {
    ...event,
    eventId: `${event.eventId}:resume`,
    startSeconds: resumeSeconds,
    segments,
    automation,
    effects: event.effects.filter((effect) => effect.endSeconds > resumeSeconds),
  };
}

/**
 * gliss chain segment를 재개 지점부터 시작하도록 자르고 시작 pitch를 보간한다.
 * - 인수 : segment : 원본 chain segment
 * - 인수 : resumeSeconds : 재개할 score time
 * - 반환값 : 재개 지점 기준 segment 또는 유효하지 않으면 null
 */
function clipGlissChainSegmentForResume(
  segment: AudioGlissChainSegment,
  resumeSeconds: number,
): AudioGlissChainSegment | null {
  if (segment.endSeconds <= resumeSeconds) {
    return null;
  }

  if (segment.startSeconds >= resumeSeconds) {
    return { ...segment };
  }

  const startPitch = segment.startMidi + segment.startCentOffset / 100;
  const endPitch = segment.endMidi + segment.endCentOffset / 100;
  const ratio = (resumeSeconds - segment.startSeconds) /
    (segment.endSeconds - segment.startSeconds);
  const resumedPitch = startPitch + (endPitch - startPitch) * Math.min(Math.max(ratio, 0), 1);
  const resumedMidi = Math.round(resumedPitch);
  const resumedCentOffset = (resumedPitch - resumedMidi) * 100;

  return {
    ...segment,
    startSeconds: resumeSeconds,
    startMidi: resumedMidi,
    startCentOffset: resumedCentOffset,
  };
}

/**
 * automation을 재개 지점부터 시작하도록 잘라내고 선형 automation은 시작값을 보간한다.
 * - 인수 : automations : 원본 automation 목록
 * - 인수 : resumeSeconds : 재개할 score time
 * - 반환값 : 재개 지점 이후에 유효한 automation 목록
 */
function clipAutomationForResume(
  automations: AudioAutomationEvent[],
  resumeSeconds: number,
): AudioAutomationEvent[] {
  return automations
    .filter((automation) => automation.endSeconds > resumeSeconds)
    .map((automation) => {
      if (automation.startSeconds >= resumeSeconds) {
        return { ...automation };
      }

      if (automation.kind === "pitchRamp") {
        return clipPitchRampAutomationForResume(automation, resumeSeconds);
      }

      return {
        ...automation,
        startSeconds: resumeSeconds,
        startValue: interpolateAutomationValue(automation, resumeSeconds),
      };
    });
}

/**
 * loop end 경계를 넘는 schedule event를 hard cut한다.
 * - 인수 : event : 예약 후보 event
 * - 인수 : hardClipEndSeconds : loop end에 해당하는 score seconds. null이면 자르지 않는다.
 * - 반환값 : loop end 안에서 유효한 event 또는 유효하지 않으면 null
 */
function clipScheduleEventToHardEnd(
  event: AudioScheduleEvent,
  hardClipEndSeconds: number | null,
): AudioScheduleEvent | null {
  if (hardClipEndSeconds === null || event.endSeconds <= hardClipEndSeconds) {
    return event;
  }

  if (event.startSeconds >= hardClipEndSeconds) {
    return null;
  }

  const automation = clipAutomationForEnd(event.automation, hardClipEndSeconds);
  const effects = clipEffectsForEnd(event.effects, hardClipEndSeconds);

  if (event.sourceEventKind === "note") {
    return {
      ...event,
      endSeconds: hardClipEndSeconds,
      automation,
      effects,
    };
  }

  if (event.sourceEventKind === "gliss") {
    return clipGlissEventForEnd(event, hardClipEndSeconds, automation, effects);
  }

  return clipGlissChainEventForEnd(event, hardClipEndSeconds, automation, effects);
}

/**
 * gliss fallback event를 loop end 지점의 pitch까지로 자른다.
 * - 인수 : event : 원본 gliss event
 * - 인수 : hardClipEndSeconds : loop end score seconds
 * - 인수 : automation : loop end 기준으로 잘라낸 automation
 * - 인수 : effects : loop end 기준으로 잘라낸 effects
 * - 반환값 : 잘라낸 gliss event
 */
function clipGlissEventForEnd(
  event: AudioGlissScheduleEvent,
  hardClipEndSeconds: number,
  automation: AudioAutomationEvent[],
  effects: AudioGlissScheduleEvent["effects"],
): AudioGlissScheduleEvent {
  const endPitch = interpolatePitchAtSeconds(event, hardClipEndSeconds);
  const endMidi = Math.round(endPitch);
  const endCentOffset = (endPitch - endMidi) * 100;

  return {
    ...event,
    endSeconds: hardClipEndSeconds,
    endMidi,
    endCentOffset,
    automation,
    effects,
  };
}

/**
 * connected gliss chain event를 loop end 이전 segment만 남기도록 자른다.
 * - 인수 : event : 원본 gliss chain event
 * - 인수 : hardClipEndSeconds : loop end score seconds
 * - 인수 : automation : loop end 기준으로 잘라낸 automation
 * - 인수 : effects : loop end 기준으로 잘라낸 effects
 * - 반환값 : 잘라낸 gliss chain event 또는 유효하지 않으면 null
 */
function clipGlissChainEventForEnd(
  event: AudioGlissChainScheduleEvent,
  hardClipEndSeconds: number,
  automation: AudioAutomationEvent[],
  effects: AudioGlissChainScheduleEvent["effects"],
): AudioGlissChainScheduleEvent | null {
  const segments = event.segments
    .filter((segment) => segment.startSeconds < hardClipEndSeconds)
    .map((segment) => clipGlissChainSegmentForEnd(segment, hardClipEndSeconds))
    .filter((segment): segment is AudioGlissChainSegment => segment !== null);

  if (segments.length === 0) {
    return null;
  }

  return {
    ...event,
    endSeconds: hardClipEndSeconds,
    segments,
    automation,
    effects,
  };
}

/**
 * gliss chain segment를 loop end 지점의 pitch까지로 자른다.
 * - 인수 : segment : 원본 chain segment
 * - 인수 : hardClipEndSeconds : loop end score seconds
 * - 반환값 : 잘라낸 segment 또는 유효하지 않으면 null
 */
function clipGlissChainSegmentForEnd(
  segment: AudioGlissChainSegment,
  hardClipEndSeconds: number,
): AudioGlissChainSegment | null {
  if (segment.startSeconds >= hardClipEndSeconds) {
    return null;
  }

  if (segment.endSeconds <= hardClipEndSeconds) {
    return { ...segment };
  }

  const endPitch = interpolatePitchAtSeconds(segment, hardClipEndSeconds);
  const endMidi = Math.round(endPitch);
  const endCentOffset = (endPitch - endMidi) * 100;

  return {
    ...segment,
    endSeconds: hardClipEndSeconds,
    endMidi,
    endCentOffset,
  };
}

/**
 * automation 목록을 loop end 이전 구간으로 제한한다.
 * - 인수 : automations : 원본 automation 목록
 * - 인수 : hardClipEndSeconds : loop end score seconds
 * - 반환값 : loop end 안에서 유효한 automation 목록
 */
function clipAutomationForEnd(
  automations: AudioAutomationEvent[],
  hardClipEndSeconds: number,
): AudioAutomationEvent[] {
  return automations
    .filter((automation) => automation.startSeconds < hardClipEndSeconds)
    .map((automation) => {
      if (automation.endSeconds <= hardClipEndSeconds) {
        return { ...automation };
      }

      if (automation.kind === "pitchRamp") {
        return clipPitchRampAutomationForEnd(automation, hardClipEndSeconds);
      }

      return {
        ...automation,
        endSeconds: hardClipEndSeconds,
        endValue: interpolateAutomationValue(automation, hardClipEndSeconds),
      };
    });
}

/**
 * pitchRamp automation을 loop end 지점의 pitch까지로 자른다.
 * - 인수 : automation : pitchRamp automation
 * - 인수 : hardClipEndSeconds : loop end score seconds
 * - 반환값 : 잘라낸 pitchRamp automation
 */
function clipPitchRampAutomationForEnd(
  automation: Extract<AudioAutomationEvent, { kind: "pitchRamp" }>,
  hardClipEndSeconds: number,
): Extract<AudioAutomationEvent, { kind: "pitchRamp" }> {
  const endPitch = interpolatePitchAtSeconds(automation, hardClipEndSeconds);
  const endMidi = Math.round(endPitch);
  const endCentOffset = (endPitch - endMidi) * 100;

  return {
    ...automation,
    endSeconds: hardClipEndSeconds,
    endMidi,
    endCentOffset,
  };
}

/**
 * effect 목록을 loop end 이전 구간으로 제한한다.
 * - 인수 : effects : 원본 effect 목록
 * - 인수 : hardClipEndSeconds : loop end score seconds
 * - 반환값 : loop end 안에서 유효한 effect 목록
 */
function clipEffectsForEnd<T extends AudioNoteScheduleEvent["effects"]>(
  effects: T,
  hardClipEndSeconds: number,
): T {
  return effects
    .filter((effect) => effect.startSeconds < hardClipEndSeconds)
    .map((effect) => ({
      ...effect,
      endSeconds: Math.min(effect.endSeconds, hardClipEndSeconds),
    })) as T;
}

/**
 * 선형 pitch 구간에서 특정 score seconds의 pitch를 보간한다.
 * - 인수 : range : 시작/끝 pitch와 seconds를 가진 구간
 * - 인수 : seconds : 보간할 score seconds
 * - 반환값 : MIDI number + cent offset을 합친 실수 pitch
 */
function interpolatePitchAtSeconds(
  range: {
    startSeconds: number;
    endSeconds: number;
    startMidi: number;
    startCentOffset: number;
    endMidi: number;
    endCentOffset: number;
  },
  seconds: number,
): number {
  const startPitch = range.startMidi + range.startCentOffset / 100;
  const endPitch = range.endMidi + range.endCentOffset / 100;

  if (range.endSeconds <= range.startSeconds) {
    return startPitch;
  }

  const ratio = (seconds - range.startSeconds) / (range.endSeconds - range.startSeconds);

  return startPitch + (endPitch - startPitch) * Math.min(Math.max(ratio, 0), 1);
}

/**
 * pitchRamp automation을 재개 지점의 보간 pitch부터 시작하도록 잘라낸다.
 * - 인수 : automation : pitchRamp automation
 * - 인수 : resumeSeconds : 재개할 score time
 * - 반환값 : 재개 지점 기준 pitchRamp automation
 */
function clipPitchRampAutomationForResume(
  automation: Extract<AudioAutomationEvent, { kind: "pitchRamp" }>,
  resumeSeconds: number,
): Extract<AudioAutomationEvent, { kind: "pitchRamp" }> {
  const startPitch = automation.startMidi + automation.startCentOffset / 100;
  const endPitch = automation.endMidi + automation.endCentOffset / 100;
  const ratio = (resumeSeconds - automation.startSeconds) /
    (automation.endSeconds - automation.startSeconds);
  const resumedPitch = startPitch + (endPitch - startPitch) * Math.min(Math.max(ratio, 0), 1);
  const resumedMidi = Math.round(resumedPitch);
  const resumedCentOffset = (resumedPitch - resumedMidi) * 100;

  return {
    ...automation,
    startSeconds: resumeSeconds,
    startMidi: resumedMidi,
    startCentOffset: resumedCentOffset,
  };
}

/**
 * automation 구간 안의 특정 score time에서 gain 값을 보간한다.
 * - 인수 : automation : gain automation
 * - 인수 : seconds : 값을 구할 score time
 * - 반환값 : 보간된 gain 값
 */
function interpolateAutomationValue(
  automation: Exclude<AudioAutomationEvent, { kind: "pitchRamp" }>,
  seconds: number,
): number {
  if (
    automation.curve === "instant" ||
    automation.endSeconds <= automation.startSeconds ||
    seconds <= automation.startSeconds
  ) {
    return automation.startValue;
  }

  if (seconds >= automation.endSeconds) {
    return automation.endValue;
  }

  const ratio = (seconds - automation.startSeconds) /
    (automation.endSeconds - automation.startSeconds);

  return automation.startValue + (automation.endValue - automation.startValue) * ratio;
}

/**
 * lookahead 값이 scheduler에 사용할 수 있는 양수인지 확인한다.
 * - 인수 : lookaheadSeconds : 미리 예약할 초 단위 범위
 * - 반환값 : 없음
 */
function validateLookaheadSeconds(lookaheadSeconds: number): void {
  if (!Number.isFinite(lookaheadSeconds) || lookaheadSeconds <= 0) {
    throw new Error("lookaheadSeconds must be a positive finite number.");
  }
}

/**
 * 현재 score time이 유한한 값인지 확인한다.
 * - 인수 : currentScoreSeconds : 현재 score time
 * - 반환값 : 없음
 */
function validateCurrentScoreSeconds(currentScoreSeconds: number): void {
  if (!Number.isFinite(currentScoreSeconds)) {
    throw new Error("currentScoreSeconds must be a finite number.");
  }
}

/**
 * loop 범위가 유효한지 확인한다.
 * - 인수 : loop : loop 상태
 * - 반환값 : 없음
 */
function validateLoopState(loop: Extract<PlaybackLoopState, { enabled: true }>): void {
  if (
    !Number.isFinite(loop.startSeconds) ||
    !Number.isFinite(loop.endSeconds) ||
    loop.endSeconds <= loop.startSeconds
  ) {
    throw new Error("Enabled loop requires finite startSeconds < endSeconds.");
  }
}

/**
 * 값을 지정 범위 안으로 제한한다.
 * - 인수 : value : 제한할 값
 * - 인수 : min : 최솟값
 * - 인수 : max : 최댓값
 * - 반환값 : 범위 안으로 제한된 값
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
