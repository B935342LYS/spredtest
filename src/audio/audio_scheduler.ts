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

      const windows = createLookaheadQueryWindows(
        currentScoreSeconds,
        input.lookaheadSeconds,
        loop,
      );
      let scheduledCount = 0;

      // lookahead window를 순회하며 아직 예약하지 않은 event만 backend에 넘긴다.
      for (const window of windows) {
        const overlappingEvents = input.queue.getEventsOverlappingRange(
          window.queryStartSeconds,
          window.queryStartSeconds,
        );
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

          input.backend.scheduleEvent(resumedEvent, window.offsetBaseSeconds + window.queryStartSeconds);
          scheduledKeys.add(scheduledKey);
          scheduledCount += 1;
        }

        const events = input.queue.getEventsStartingInRange(
          window.queryStartSeconds,
          window.queryEndSeconds,
        );

        for (const event of events) {
          const scheduledKey = createScheduledEventKey(event, loopCycleIndex + window.cycleOffset);

          if (scheduledKeys.has(scheduledKey)) {
            continue;
          }

          const offsetSeconds = event.startSeconds + window.offsetBaseSeconds;

          if (offsetSeconds < 0) {
            continue;
          }

          input.backend.scheduleEvent(event, offsetSeconds);
          scheduledKeys.add(scheduledKey);
          scheduledCount += 1;
        }
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
    },
    {
      queryStartSeconds: loop.startSeconds,
      queryEndSeconds: Math.min(wrappedEnd, loop.endSeconds),
      offsetBaseSeconds: loop.endSeconds - clampedCurrent - loop.startSeconds,
      cycleOffset: 1,
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
