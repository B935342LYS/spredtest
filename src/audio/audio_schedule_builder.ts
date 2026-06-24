/**
 * src/audio/audio_schedule_builder.ts
 * AnalysisResult의 note event를 audio backend가 예약 가능한 초 단위 schedule로 변환한다.
 */

import type {
  AnalyzedEvent,
  AnalyzedDynamicsSegment,
  AnalysisResult,
  GlissEvent,
  NoteEffectSegment,
  NoteEvent,
  SourceCellRef,
} from "../core/analyze/types";
import type {
  AudioAutomationEvent,
  AudioBuildInput,
  AudioGlissChainScheduleEvent,
  AudioGlissChainSegment,
  AudioGlissScheduleEvent,
  AudioNoteScheduleEvent,
  AudioSchedule,
  AudioScheduleEvent,
  AudioScheduleEffect,
  TickTimeMapper,
} from "./audio_types";
import type { TrackId } from "../core/score/types";
import {
  createTickTimeMapper,
  numberToTimeFraction,
  timeFractionToNumber,
} from "./tick_time_mapper";
import {
  filterActiveTrackResults,
  getTrackGain,
} from "../track/track_control";

const DEFAULT_VELOCITY = 1;
const DEFAULT_GLISS_CROSSFADE_SECONDS = 0.02;
const DEFAULT_DYNAMICS_GAIN = 1;

type GainScaleSpan = {
  startSeconds: number;
  endSeconds: number;
  gainScale: number;
};

type SweepPoint = {
  seconds: number;
  delta: 1 | -1;
};

type GlissPlaybackChain = {
  events: GlissEvent[];
  startExtensionNote: NoteEvent | null;
  endExtensionNote: NoteEvent | null;
};

/**
 * analyzer 결과에서 audio schedule을 만든다.
 * - 인수 : input : analyzer 결과와 재생 대상 track 목록
 * - 반환값 : AudioSchedule : 초 단위로 정렬된 note schedule
 */
export function buildAudioSchedule(input: AudioBuildInput): AudioSchedule {
  const mapper = createTickTimeMapper(input.analysis.timingTimeline);

  return buildAudioScheduleWithMapper(input.analysis, input.activeTrackIds, mapper);
}

/**
 * 지정된 TickTimeMapper를 사용해 analyzer 결과에서 audio schedule을 만든다.
 * - 인수 : analysis : analyzer 결과
 * - 인수 : activeTrackIds : 재생할 trackId 목록
 * - 인수 : mapper : tick/seconds 변환기
 * - 반환값 : AudioSchedule : 초 단위로 정렬된 note schedule
 */
export function buildAudioScheduleWithMapper(
  analysis: AnalysisResult,
  activeTrackIds: TrackId[],
  mapper: TickTimeMapper,
): AudioSchedule {
  const events: AudioScheduleEvent[] = [];

  for (const trackResult of filterActiveTrackResults(analysis, activeTrackIds)) {
    const noteEvents = trackResult.events.filter(isNoteEvent);
    const glissEvents = trackResult.events.filter(isGlissEvent);
    const noteClipStartTickByEvent = buildGlissEndNoteClipStartTickMap(
      noteEvents,
      glissEvents,
    );
    const noteClipEndTickByEvent = buildGlissStartNoteClipEndTickMap(
      noteEvents,
      glissEvents,
    );
    const glissChains = buildGlissPlaybackChains(
      buildConnectedGlissChains(glissEvents, noteEvents),
      glissEvents,
      noteEvents,
    );
    const chainedGlissEvents = new Set<GlissEvent>(
      glissChains.flatMap((chain) => chain.events),
    );
    const mutedNoteEvents = buildMutedGlissAnchorNoteSet(
      noteEvents,
      glissEvents,
      glissChains,
    );

    // 선택된 track의 note, 단독 gliss fallback, 연결 gliss chain을 audio schedule event로 변환한다.
    for (const event of trackResult.events) {
      if (isNoteEvent(event)) {
        if (mutedNoteEvents.has(event)) {
          continue;
        }

        const noteScheduleEvent = createAudioNoteScheduleEvent(
          event,
          mapper,
          noteClipStartTickByEvent.get(event) ?? null,
          noteClipEndTickByEvent.get(event) ?? null,
          analysis.dynamicsTimeline,
        );

        if (noteScheduleEvent !== null) {
          events.push(noteScheduleEvent);
        }
        continue;
      }

      if (isGlissEvent(event)) {
        if (chainedGlissEvents.has(event)) {
          continue;
        }

        const glissScheduleEvent = createAudioGlissScheduleEvent(
          event,
          mapper,
          noteEvents,
          analysis.dynamicsTimeline,
        );

        if (glissScheduleEvent !== null) {
          events.push(glissScheduleEvent);
        }
      }
    }

    for (const glissChain of glissChains) {
      const chainScheduleEvent = createAudioGlissChainScheduleEvent(
        glissChain,
        mapper,
        noteEvents,
        analysis.dynamicsTimeline,
      );

      if (chainScheduleEvent !== null) {
        events.push(chainScheduleEvent);
      }
    }
  }

  return {
    durationSeconds: mapper.getDurationSeconds(),
    events: applyOverlapGainScaleAutomation(events.sort(compareAudioScheduleEvents)),
  };
}

/**
 * 실제로 동시에 울리는 schedule event 수를 기준으로 event별 gain scale automation을 추가한다.
 * - 인수 : events : 초 단위로 변환된 발음 이벤트 목록
 * - 반환값 : gainScale automation이 추가된 발음 이벤트 목록
 */
function applyOverlapGainScaleAutomation(
  events: AudioScheduleEvent[],
): AudioScheduleEvent[] {
  const gainScaleSpans = buildGainScaleSpans(events);
  let firstCandidateSpanIndex = 0;

  return events.map((event) => {
    // events와 span은 시간순이므로, 이미 event 시작 전 끝난 span은 다음 event에서도 다시 볼 필요가 없다.
    while (firstCandidateSpanIndex < gainScaleSpans.length) {
      const span = gainScaleSpans[firstCandidateSpanIndex];

      if (span === undefined || span.endSeconds > event.startSeconds) {
        break;
      }

      firstCandidateSpanIndex += 1;
    }

    const gainScaleAutomation = buildGainScaleAutomationForEvent(
      event,
      gainScaleSpans,
      firstCandidateSpanIndex,
    );

    return {
      ...event,
      automation: [
        ...event.automation,
        ...gainScaleAutomation,
      ],
    };
  });
}

/**
 * sweep-line으로 전체 score 시간의 동시 발음 수 span을 만든다.
 * - 인수 : events : 전체 발음 event 목록
 * - 반환값 : gainScaleSpan[] : 인접 event 경계 사이의 gainScale 목록
 */
function buildGainScaleSpans(
  events: AudioScheduleEvent[],
): GainScaleSpan[] {
  const points: SweepPoint[] = events.flatMap((event) => [
    { seconds: event.startSeconds, delta: 1 as const },
    { seconds: event.endSeconds, delta: -1 as const },
  ])
    .filter((point) => Number.isFinite(point.seconds))
    .sort(compareSweepPoints);
  const spans: GainScaleSpan[] = [];
  let activeCount = 0;
  let index = 0;

  while (index < points.length) {
    const currentSeconds = points[index]?.seconds;

    if (currentSeconds === undefined) {
      break;
    }

    // 같은 시각의 end/start delta를 모두 반영한 activeCount가 다음 span의 동시 발음 수이다.
    let nextIndex = index;
    while (nextIndex < points.length && points[nextIndex]?.seconds === currentSeconds) {
      activeCount += points[nextIndex]?.delta ?? 0;
      nextIndex += 1;
    }

    const nextSeconds = points[nextIndex]?.seconds;

    if (nextSeconds !== undefined && nextSeconds > currentSeconds && activeCount > 0) {
      spans.push({
        startSeconds: currentSeconds,
        endSeconds: nextSeconds,
        gainScale: 1 / activeCount,
      });
    }

    index = nextIndex;
  }

  return mergeAdjacentGainScaleSpans(spans);
}

/**
 * sweep point를 시간순으로 정렬한다. 같은 시간에서는 end를 start보다 먼저 처리한다.
 * - 인수 : left : 왼쪽 sweep point
 * - 인수 : right : 오른쪽 sweep point
 * - 반환값 : 정렬 비교값
 */
function compareSweepPoints(left: SweepPoint, right: SweepPoint): number {
  if (left.seconds !== right.seconds) {
    return left.seconds - right.seconds;
  }

  return left.delta - right.delta;
}

/**
 * 같은 scale이 이어지는 span을 병합한다.
 * - 인수 : spans : sweep-line으로 만든 gainScale span 목록
 * - 반환값 : 인접 동일 scale span을 병합한 목록
 */
function mergeAdjacentGainScaleSpans(spans: GainScaleSpan[]): GainScaleSpan[] {
  const merged: GainScaleSpan[] = [];

  for (const span of spans) {
    const previous = merged[merged.length - 1];

    if (
      previous !== undefined &&
      previous.gainScale === span.gainScale &&
      previous.endSeconds === span.startSeconds
    ) {
      previous.endSeconds = span.endSeconds;
      continue;
    }

    merged.push({ ...span });
  }

  return merged;
}

/**
 * 단일 event와 겹치는 gainScale span을 automation으로 변환한다.
 * - 인수 : event : gain scale을 적용할 event
 * - 인수 : gainScaleSpans : sweep-line으로 만든 전체 gainScale span 목록
 * - 반환값 : gainScale automation 목록
 */
function buildGainScaleAutomationForEvent(
  event: AudioScheduleEvent,
  gainScaleSpans: GainScaleSpan[],
  startSpanIndex: number,
): AudioAutomationEvent[] {
  const automation: AudioAutomationEvent[] = [];

  for (let index = startSpanIndex; index < gainScaleSpans.length; index += 1) {
    const span = gainScaleSpans[index];

    if (span === undefined) {
      break;
    }

    if (span.startSeconds >= event.endSeconds) {
      break;
    }

    const startSeconds = Math.max(event.startSeconds, span.startSeconds);
    const endSeconds = Math.min(event.endSeconds, span.endSeconds);

    if (endSeconds <= startSeconds) {
      continue;
    }

    automation.push({
      kind: "gainScale",
      startSeconds,
      endSeconds,
      startValue: span.gainScale,
      endValue: span.gainScale,
      curve: "instant",
    });
  }

  return mergeAdjacentConstantGainScaleAutomation(automation);
}

/**
 * 같은 값이 연속되는 gainScale automation을 하나로 합쳐 backend 예약량을 줄인다.
 * - 인수 : automation : gainScale automation 목록
 * - 반환값 : 인접 동일 scale 구간을 병합한 목록
 */
function mergeAdjacentConstantGainScaleAutomation(
  automation: AudioAutomationEvent[],
): AudioAutomationEvent[] {
  const merged: AudioAutomationEvent[] = [];

  for (const item of automation) {
    const previous = merged[merged.length - 1];

    if (
      previous?.kind === "gainScale" &&
      item.kind === "gainScale" &&
      previous.endValue === item.startValue &&
      previous.endValue === item.endValue &&
      previous.endSeconds === item.startSeconds
    ) {
      previous.endSeconds = item.endSeconds;
      continue;
    }

    merged.push({ ...item });
  }

  return merged;
}

/**
 * 연결된 gliss 세그먼트를 하나의 oscillator chain 후보로 묶는다.
 * - 인수 : glissEvents : 같은 track의 gliss event 목록
 * - 인수 : noteEvents : tremolo 상태 비교에 사용할 같은 track note event 목록
 * - 반환값 : GlissEvent[][] : 길이 2 이상인 연결 gliss chain 목록
 */
function buildConnectedGlissChains(
  glissEvents: GlissEvent[],
  noteEvents: NoteEvent[],
): GlissEvent[][] {
  const sortedEvents = [...glissEvents].sort((left, right) =>
    timeFractionToNumber(left.startAnchorTick) - timeFractionToNumber(right.startAnchorTick),
  );
  const chains: GlissEvent[][] = [];
  let currentChain: GlissEvent[] = [];

  // 같은 gliss id의 인접 세그먼트가 같은 anchor pitch에서 만날 때 하나의 chain으로 재생한다.
  for (let index = 0; index < sortedEvents.length; index += 1) {
    const currentEvent = sortedEvents[index];
    const nextEvent = sortedEvents[index + 1];

    if (currentEvent === undefined) {
      continue;
    }

    if (currentChain.length === 0) {
      currentChain.push(currentEvent);
    }

    if (nextEvent !== undefined && areConnectedGlissEvents(currentEvent, nextEvent, noteEvents)) {
      currentChain.push(nextEvent);
      continue;
    }

    if (currentChain.length > 1) {
      chains.push(currentChain);
    }

    currentChain = [];
  }

  return chains;
}

/**
 * audio 재생용 gliss chain 목록을 만든다.
 * - 인수 : connectedGlissChains : pitch가 이어지는 기존 gliss segment chain 목록
 * - 인수 : glissEvents : 같은 track의 전체 gliss event 목록
 * - 인수 : noteEvents : anchor와 연결된 long note를 찾기 위한 note event 목록
 * - 반환값 : GlissPlaybackChain[] : constant pitch extension을 포함할 수 있는 재생용 chain 목록
 */
function buildGlissPlaybackChains(
  connectedGlissChains: GlissEvent[][],
  glissEvents: GlissEvent[],
  noteEvents: NoteEvent[],
): GlissPlaybackChain[] {
  const chains: GlissPlaybackChain[] = [];
  const chainedEvents = new Set<GlissEvent>();

  for (const events of connectedGlissChains) {
    const chain = createGlissPlaybackChain(events, noteEvents);

    if (chain !== null) {
      chains.push(chain);
      for (const event of events) {
        chainedEvents.add(event);
      }
    }
  }

  for (const event of glissEvents) {
    if (chainedEvents.has(event)) {
      continue;
    }

    const chain = createGlissPlaybackChain([event], noteEvents);

    if (
      chain !== null &&
      (chain.events.length > 1 || chain.startExtensionNote !== null || chain.endExtensionNote !== null)
    ) {
      chains.push(chain);
    }
  }

  return chains;
}

/**
 * gliss event 목록과 양끝 long note extension을 하나의 playback chain으로 묶는다.
 * - 인수 : events : 같은 gliss id로 이어지는 gliss event 목록
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : 재생용 chain 또는 유효하지 않으면 null
 */
function createGlissPlaybackChain(
  events: GlissEvent[],
  noteEvents: NoteEvent[],
): GlissPlaybackChain | null {
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];

  if (firstEvent === undefined || lastEvent === undefined) {
    return null;
  }

  return {
    events,
    startExtensionNote: findStartLongNoteExtension(firstEvent, noteEvents),
    endExtensionNote: findEndLongNoteExtension(lastEvent, noteEvents),
  };
}

/**
 * gliss anchor에서 독립 발음을 제거할 note event 목록을 만든다.
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 인수 : glissEvents : 같은 track의 gliss event 목록
 * - 인수 : glissChains : long note extension을 흡수한 재생용 chain 목록
 * - 반환값 : audio schedule에서 제외할 note event 집합
 */
function buildMutedGlissAnchorNoteSet(
  noteEvents: NoteEvent[],
  glissEvents: GlissEvent[],
  glissChains: GlissPlaybackChain[],
): Set<NoteEvent> {
  const mutedNoteEvents = new Set<NoteEvent>();

  for (const noteEvent of noteEvents) {
    if (isSingleCellGlissAnchorNote(noteEvent, glissEvents)) {
      mutedNoteEvents.add(noteEvent);
    }
  }

  for (const chain of glissChains) {
    if (chain.startExtensionNote !== null) {
      mutedNoteEvents.add(chain.startExtensionNote);
    }

    if (chain.endExtensionNote !== null) {
      mutedNoteEvents.add(chain.endExtensionNote);
    }
  }

  return mutedNoteEvents;
}

/**
 * 단일 셀 anchor note가 실제 gliss segment의 시작/종료 anchor로 쓰였는지 확인한다.
 * - 인수 : noteEvent : 검사할 note event
 * - 인수 : glissEvents : 같은 track의 gliss event 목록
 * - 반환값 : 단일 셀 anchor note를 독립 발음에서 제거해야 하는지 여부
 */
function isSingleCellGlissAnchorNote(
  noteEvent: NoteEvent,
  glissEvents: GlissEvent[],
): boolean {
  if (!isSingleSourceCellNoteEvent(noteEvent)) {
    return false;
  }

  return glissEvents.some((glissEvent) =>
    isNoteEventGlissBoundaryAnchor(noteEvent, glissEvent, "start") ||
    isNoteEventGlissBoundaryAnchor(noteEvent, glissEvent, "end")
  );
}

/**
 * note event가 한 source cell의 길이와 같은 단일 셀 note인지 확인한다.
 * - 인수 : noteEvent : 검사할 note event
 * - 반환값 : source cell 하나만 가진 단일 셀 note 여부
 */
function isSingleSourceCellNoteEvent(noteEvent: NoteEvent): boolean {
  const source = noteEvent.sourceCells[0];

  if (source === undefined || noteEvent.sourceCells.length !== 1) {
    return false;
  }

  const sourceStart = source.col;
  const sourceEnd = source.col + 1;

  return timeFractionToNumber(noteEvent.time.startTick) === sourceStart &&
    timeFractionToNumber(noteEvent.time.endTick) === sourceEnd;
}

/**
 * note event가 지정한 gliss event의 boundary anchor인지 확인한다.
 * - 인수 : noteEvent : 검사할 note event
 * - 인수 : glissEvent : 연결 기준 gliss event
 * - 인수 : boundary : start 또는 end anchor 검사 방향
 * - 반환값 : note event가 해당 gliss boundary anchor이면 true
 */
function isNoteEventGlissBoundaryAnchor(
  noteEvent: NoteEvent,
  glissEvent: GlissEvent,
  boundary: "start" | "end",
): boolean {
  const source = boundary === "start"
    ? glissEvent.sourceCells[0]
    : glissEvent.sourceCells[1];
  const role = boundary === "start" ? glissEvent.fromKind : glissEvent.toKind;

  if (source === undefined) {
    return false;
  }

  return noteEvent.glissAnchors.some((anchor) =>
    anchor.glissId === glissEvent.glissId &&
    anchor.role === role &&
    sourceCellsMatch(anchor.source, source)
  );
}

/**
 * gliss 시작 anchor 앞쪽으로 이어진 long note를 찾는다.
 * - 인수 : glissEvent : 시작 anchor를 가진 gliss event
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : 시작 anchor 앞 constant pitch로 흡수할 note event 또는 null
 */
function findStartLongNoteExtension(
  glissEvent: GlissEvent,
  noteEvents: NoteEvent[],
): NoteEvent | null {
  const noteEvent = findStartAnchorNoteEvent(glissEvent, noteEvents);
  const source = glissEvent.sourceCells[0];

  if (noteEvent === null || source === undefined) {
    return null;
  }

  if (timeFractionToNumber(noteEvent.time.startTick) >= source.col) {
    return null;
  }

  return noteEvent;
}

/**
 * gliss 종료 anchor 뒤쪽으로 이어진 long note를 찾는다.
 * - 인수 : glissEvent : 종료 anchor를 가진 gliss event
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : 종료 anchor 뒤 constant pitch로 흡수할 note event 또는 null
 */
function findEndLongNoteExtension(
  glissEvent: GlissEvent,
  noteEvents: NoteEvent[],
): NoteEvent | null {
  const noteEvent = findEndAnchorNoteEvent(glissEvent, noteEvents);
  const source = glissEvent.sourceCells[1];

  if (noteEvent === null || source === undefined) {
    return null;
  }

  if (timeFractionToNumber(noteEvent.time.endTick) <= source.col + 1) {
    return null;
  }

  return noteEvent;
}

/**
 * 두 gliss fallback 세그먼트가 같은 내부 anchor를 공유하는지 확인한다.
 * - 인수 : currentEvent : 앞쪽 gliss event
 * - 인수 : nextEvent : 뒤쪽 gliss event
 * - 인수 : noteEvents : tremolo 상태 비교에 사용할 같은 track note event 목록
 * - 반환값 : 같은 track/id/time/pitch/tremolo 상태에서 연결되는지 여부
 */
function areConnectedGlissEvents(
  currentEvent: GlissEvent,
  nextEvent: GlissEvent,
  noteEvents: NoteEvent[],
): boolean {
  return currentEvent.trackId === nextEvent.trackId &&
    currentEvent.glissId === nextEvent.glissId &&
    timeFractionToNumber(currentEvent.endAnchorTick) ===
      timeFractionToNumber(nextEvent.startAnchorTick) &&
    currentEvent.endSound.midi === nextEvent.startSound.midi &&
    currentEvent.endSound.centOffset === nextEvent.startSound.centOffset &&
    hasGlissTremoloEffect(currentEvent, noteEvents) ===
      hasGlissTremoloEffect(nextEvent, noteEvents);
}

/**
 * analyzer event가 실제 발음 note event인지 확인한다.
 * - 인수 : event : analyzer event
 * - 반환값 : event is NoteEvent : note event 여부
 */
function isNoteEvent(event: AnalyzedEvent): event is NoteEvent {
  return event.eventKind === "note";
}

/**
 * analyzer event가 gliss fallback 발음 이벤트인지 확인한다.
 * - 인수 : event : analyzer event
 * - 반환값 : event is GlissEvent : gliss event 여부
 */
function isGlissEvent(event: AnalyzedEvent): event is GlissEvent {
  return event.eventKind === "gliss";
}

/**
 * NoteEvent 하나를 AudioNoteScheduleEvent로 변환한다.
 * - 인수 : event : analyzer가 만든 note event
 * - 인수 : mapper : tick/seconds 변환기
 * - 인수 : clipStartTick : gliss 종료점 때문에 audio에서만 늦출 시작 tick
 * - 인수 : clipEndTick : gliss 시작점 때문에 audio에서만 줄일 종료 tick
 * - 인수 : dynamicsTimeline : analyzer가 만든 dynamics timeline
 * - 반환값 : AudioNoteScheduleEvent : backend 예약용 note event 또는 길이가 없으면 null
 */
function createAudioNoteScheduleEvent(
  event: NoteEvent,
  mapper: TickTimeMapper,
  clipStartTick: NoteEvent["time"]["startTick"] | null,
  clipEndTick: NoteEvent["time"]["endTick"] | null,
  dynamicsTimeline: AnalyzedDynamicsSegment[],
): AudioNoteScheduleEvent | null {
  const effectiveStartTick = getClippedNoteStartTick(event, clipStartTick);
  const effectiveEndTick = getClippedNoteEndTick(event, clipEndTick);
  const startSeconds = mapper.tickToSeconds(effectiveStartTick);
  const endSeconds = mapper.tickToSeconds(effectiveEndTick);

  if (endSeconds <= startSeconds) {
    return null;
  }

  return {
    eventId: event.eventId,
    trackId: event.trackId,
    startTick: effectiveStartTick,
    endTick: effectiveEndTick,
    startSeconds,
    endSeconds,
    midi: event.sound.midi,
    centOffset: event.sound.centOffset,
    velocity: DEFAULT_VELOCITY * getTrackGain(event.trackId),
    effects: buildAudioScheduleEffects(event.effects, mapper),
    automation: buildDynamicsGainAutomation(
      dynamicsTimeline,
      effectiveStartTick,
      effectiveEndTick,
      mapper,
    ),
    sourceEventKind: "note" as const,
  };
}

/**
 * gliss 종료 anchor와 겹치는 note event의 audio 시작 tick을 찾는다.
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 인수 : glissEvents : 같은 track의 gliss event 목록
 * - 반환값 : Map<NoteEvent, TimeFraction> : audio note 시작을 늦출 tick lookup
 */
function buildGlissEndNoteClipStartTickMap(
  noteEvents: NoteEvent[],
  glissEvents: GlissEvent[],
): Map<NoteEvent, NoteEvent["time"]["startTick"]> {
  const clipStartTickByEvent = new Map<NoteEvent, NoteEvent["time"]["startTick"]>();

  // gliss가 도착하는 anchor note는 gliss 종료 시점부터 발음해 ramp와의 중복 발음을 막는다.
  for (const glissEvent of glissEvents) {
    const noteEvent = findEndAnchorNoteEvent(glissEvent, noteEvents);

    if (noteEvent === null) {
      continue;
    }

    const currentClipStartTick = clipStartTickByEvent.get(noteEvent);
    const nextClipStartTick = glissEvent.endAnchorTick;

    if (
      currentClipStartTick === undefined ||
      timeFractionToNumber(nextClipStartTick) > timeFractionToNumber(currentClipStartTick)
    ) {
      clipStartTickByEvent.set(noteEvent, cloneTimeFraction(nextClipStartTick));
    }
  }

  return clipStartTickByEvent;
}

/**
 * gliss fallback 시작 anchor와 겹치는 note event의 audio 종료 tick을 찾는다.
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 인수 : glissEvents : 같은 track의 gliss event 목록
 * - 반환값 : Map<NoteEvent, TimeFraction> : audio note 종료를 앞당길 tick lookup
 */
function buildGlissStartNoteClipEndTickMap(
  noteEvents: NoteEvent[],
  glissEvents: GlissEvent[],
): Map<NoteEvent, NoteEvent["time"]["endTick"]> {
  const clipEndTickByEvent = new Map<NoteEvent, NoteEvent["time"]["endTick"]>();

  // gliss fallback이 시작되는 anchor note는 gliss 시작 시점에서 발음을 끊어 겹침을 줄인다.
  for (const glissEvent of glissEvents) {
    const noteEvent = findStartAnchorNoteEvent(glissEvent, noteEvents);

    if (noteEvent === null) {
      continue;
    }

    const currentClipEndTick = clipEndTickByEvent.get(noteEvent);
    const nextClipEndTick = glissEvent.startAnchorTick;

    if (
      currentClipEndTick === undefined ||
      timeFractionToNumber(nextClipEndTick) < timeFractionToNumber(currentClipEndTick)
    ) {
      clipEndTickByEvent.set(noteEvent, cloneTimeFraction(nextClipEndTick));
    }
  }

  return clipEndTickByEvent;
}

/**
 * gliss 종료 anchor가 속한 note event를 찾는다.
 * - 인수 : glissEvent : analyzer가 만든 gliss event
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : 종료 anchor가 붙은 note event 또는 없으면 null
 */
function findEndAnchorNoteEvent(
  glissEvent: GlissEvent,
  noteEvents: NoteEvent[],
): NoteEvent | null {
  const endSource = glissEvent.sourceCells[1];

  if (endSource === undefined) {
    return null;
  }

  return noteEvents.find((noteEvent) =>
    noteEvent.glissAnchors.some((anchor) =>
      anchor.glissId === glissEvent.glissId &&
      anchor.role === glissEvent.toKind &&
      sourceCellsMatch(anchor.source, endSource)
    )
  ) ?? null;
}

/**
 * gliss 시작 anchor가 속한 note event를 찾는다.
 * - 인수 : glissEvent : analyzer가 만든 gliss event
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : 시작 anchor가 붙은 note event 또는 없으면 null
 */
function findStartAnchorNoteEvent(
  glissEvent: GlissEvent,
  noteEvents: NoteEvent[],
): NoteEvent | null {
  const startSource = glissEvent.sourceCells[0];

  if (startSource === undefined) {
    return null;
  }

  return noteEvents.find((noteEvent) =>
    noteEvent.glissAnchors.some((anchor) =>
      anchor.glissId === glissEvent.glissId &&
      anchor.role === glissEvent.fromKind &&
      sourceCellsMatch(anchor.source, startSource)
    )
  ) ?? null;
}

/**
 * note event의 audio 시작 tick을 gliss 종료점 기준으로 제한한다.
 * - 인수 : event : analyzer가 만든 note event
 * - 인수 : clipStartTick : 후보 시작 tick
 * - 반환값 : 실제 audio note 시작 tick
 */
function getClippedNoteStartTick(
  event: NoteEvent,
  clipStartTick: NoteEvent["time"]["startTick"] | null,
): NoteEvent["time"]["startTick"] {
  if (clipStartTick === null) {
    return event.time.startTick;
  }

  const startTick = timeFractionToNumber(event.time.startTick);
  const endTick = timeFractionToNumber(event.time.endTick);
  const clippedStartTick = timeFractionToNumber(clipStartTick);

  if (clippedStartTick < startTick || clippedStartTick > endTick) {
    return event.time.startTick;
  }

  return cloneTimeFraction(clipStartTick);
}

/**
 * note event의 audio 종료 tick을 gliss 시작점 기준으로 제한한다.
 * - 인수 : event : analyzer가 만든 note event
 * - 인수 : clipEndTick : 후보 종료 tick
 * - 반환값 : 실제 audio note 종료 tick
 */
function getClippedNoteEndTick(
  event: NoteEvent,
  clipEndTick: NoteEvent["time"]["endTick"] | null,
): NoteEvent["time"]["endTick"] {
  if (clipEndTick === null) {
    return event.time.endTick;
  }

  const startTick = timeFractionToNumber(event.time.startTick);
  const endTick = timeFractionToNumber(event.time.endTick);
  const clippedEndTick = timeFractionToNumber(clipEndTick);

  if (clippedEndTick < startTick || clippedEndTick > endTick) {
    return event.time.endTick;
  }

  return cloneTimeFraction(clipEndTick);
}

/**
 * GlissEvent 하나를 AudioGlissScheduleEvent로 변환한다.
 * - 인수 : event : analyzer가 만든 gliss event
 * - 인수 : mapper : tick/seconds 변환기
 * - 인수 : noteEvents : gliss 시작 anchor의 tremolo 정보를 찾기 위한 같은 track note event 목록
 * - 반환값 : backend 예약용 gliss fallback event 또는 길이가 없으면 null
 */
function createAudioGlissScheduleEvent(
  event: GlissEvent,
  mapper: TickTimeMapper,
  noteEvents: NoteEvent[],
  dynamicsTimeline: AnalyzedDynamicsSegment[],
): AudioGlissScheduleEvent | null {
  const startTick = getAudioGlissStartTick(event, noteEvents);
  const startSeconds = mapper.tickToSeconds(startTick);
  const endSeconds = mapper.tickToSeconds(event.endAnchorTick);

  if (endSeconds <= startSeconds) {
    return null;
  }

  return {
    eventId: event.eventId,
    trackId: event.trackId,
    startTick,
    endTick: event.endAnchorTick,
    startSeconds,
    endSeconds,
    velocity: DEFAULT_VELOCITY * getTrackGain(event.trackId),
    sourceEventKind: "gliss",
    startMidi: event.startSound.midi,
    startCentOffset: event.startSound.centOffset,
    endMidi: event.endSound.midi,
    endCentOffset: event.endSound.centOffset,
    curve: "linear",
    crossfadeSeconds: DEFAULT_GLISS_CROSSFADE_SECONDS,
    effects: buildGlissTremoloEffects(event, mapper, noteEvents),
    automation: buildDynamicsGainAutomation(
      dynamicsTimeline,
      startTick,
      event.endAnchorTick,
      mapper,
    ),
  };
}

/**
 * 재생용 GlissPlaybackChain을 하나의 AudioGlissChainScheduleEvent로 변환한다.
 * - 인수 : chain : gliss segment와 long note extension을 담은 재생용 chain
 * - 인수 : mapper : tick/seconds 변환기
 * - 인수 : noteEvents : gliss 시작 anchor의 tremolo 정보를 찾기 위한 같은 track note event 목록
 * - 인수 : dynamicsTimeline : analyzer가 만든 dynamics timeline
 * - 반환값 : backend 예약용 gliss chain event 또는 유효 구간이 없으면 null
 */
function createAudioGlissChainScheduleEvent(
  chain: GlissPlaybackChain,
  mapper: TickTimeMapper,
  noteEvents: NoteEvent[],
  dynamicsTimeline: AnalyzedDynamicsSegment[],
): AudioGlissChainScheduleEvent | null {
  const events = chain.events;
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];

  if (firstEvent === undefined || lastEvent === undefined) {
    return null;
  }

  const firstAudioStartTick = getAudioGlissStartTick(firstEvent, noteEvents);
  const startTick = chain.startExtensionNote?.time.startTick ?? firstAudioStartTick;
  const endTick = chain.endExtensionNote?.time.endTick ?? lastEvent.endAnchorTick;
  const startSeconds = mapper.tickToSeconds(startTick);
  const endSeconds = mapper.tickToSeconds(endTick);

  if (endSeconds <= startSeconds) {
    return null;
  }

  const segments = [
    createStartExtensionGlissChainSegment(chain, mapper),
    ...events.map((event) => createAudioGlissChainSegment(event, noteEvents, mapper)),
    createEndExtensionGlissChainSegment(chain, mapper),
  ]
    .filter((segment): segment is AudioGlissChainSegment => segment !== null);

  if (segments.length === 0) {
    return null;
  }

  return {
    eventId: `${firstEvent.trackId}:gliss-chain:${firstEvent.glissId}:${firstEvent.eventId}:${lastEvent.eventId}`,
    trackId: firstEvent.trackId,
    startTick,
    endTick,
    startSeconds,
    endSeconds,
    velocity: DEFAULT_VELOCITY * getTrackGain(firstEvent.trackId),
    sourceEventKind: "glissChain",
    segments,
    fadeSeconds: DEFAULT_GLISS_CROSSFADE_SECONDS,
    effects: [
      ...buildExtensionNoteEffects(chain.startExtensionNote, mapper),
      ...events.flatMap((event) => buildGlissTremoloEffects(event, mapper, noteEvents)),
      ...buildExtensionNoteEffects(chain.endExtensionNote, mapper),
    ],
    automation: buildDynamicsGainAutomation(
      dynamicsTimeline,
      startTick,
      endTick,
      mapper,
    ),
  };
}

/**
 * gliss 시작 앞쪽 long note를 constant pitch chain segment로 변환한다.
 * - 인수 : chain : 변환할 재생용 gliss chain
 * - 인수 : mapper : tick/seconds 변환기
 * - 반환값 : constant pitch segment 또는 유효하지 않으면 null
 */
function createStartExtensionGlissChainSegment(
  chain: GlissPlaybackChain,
  mapper: TickTimeMapper,
): AudioGlissChainSegment | null {
  const noteEvent = chain.startExtensionNote;
  const firstEvent = chain.events[0];

  if (noteEvent === null || firstEvent === undefined) {
    return null;
  }

  return createConstantPitchGlissChainSegment(
    noteEvent.time.startTick,
    getAudioGlissStartTick(firstEvent, [noteEvent]),
    noteEvent.sound.midi,
    noteEvent.sound.centOffset,
    mapper,
  );
}

/**
 * gliss 종료 뒤쪽 long note를 constant pitch chain segment로 변환한다.
 * - 인수 : chain : 변환할 재생용 gliss chain
 * - 인수 : mapper : tick/seconds 변환기
 * - 반환값 : constant pitch segment 또는 유효하지 않으면 null
 */
function createEndExtensionGlissChainSegment(
  chain: GlissPlaybackChain,
  mapper: TickTimeMapper,
): AudioGlissChainSegment | null {
  const noteEvent = chain.endExtensionNote;
  const lastEvent = chain.events[chain.events.length - 1];

  if (noteEvent === null || lastEvent === undefined) {
    return null;
  }

  return createConstantPitchGlissChainSegment(
    lastEvent.endAnchorTick,
    noteEvent.time.endTick,
    noteEvent.sound.midi,
    noteEvent.sound.centOffset,
    mapper,
  );
}

/**
 * 같은 pitch를 유지하는 gliss chain segment를 만든다.
 * - 인수 : startTick : segment 시작 tick
 * - 인수 : endTick : segment 끝 tick
 * - 인수 : midi : 유지할 MIDI pitch
 * - 인수 : centOffset : 유지할 cent offset
 * - 인수 : mapper : tick/seconds 변환기
 * - 반환값 : constant pitch segment 또는 길이가 없으면 null
 */
function createConstantPitchGlissChainSegment(
  startTick: NoteEvent["time"]["startTick"],
  endTick: NoteEvent["time"]["endTick"],
  midi: number,
  centOffset: number,
  mapper: TickTimeMapper,
): AudioGlissChainSegment | null {
  const startSeconds = mapper.tickToSeconds(startTick);
  const endSeconds = mapper.tickToSeconds(endTick);

  if (endSeconds <= startSeconds) {
    return null;
  }

  return {
    startSeconds,
    endSeconds,
    startMidi: midi,
    startCentOffset: centOffset,
    endMidi: midi,
    endCentOffset: centOffset,
    curve: "linear",
  };
}

/**
 * GlissEvent 하나를 gliss chain 내부 pitch ramp 세그먼트로 변환한다.
 * - 인수 : event : analyzer가 만든 gliss event
 * - 인수 : mapper : tick/seconds 변환기
 * - 반환값 : AudioGlissChainSegment 또는 길이가 없으면 null
 */
function createAudioGlissChainSegment(
  event: GlissEvent,
  noteEvents: NoteEvent[],
  mapper: TickTimeMapper,
): AudioGlissChainSegment | null {
  const startTick = getAudioGlissStartTick(event, noteEvents);
  const startSeconds = mapper.tickToSeconds(startTick);
  const endSeconds = mapper.tickToSeconds(event.endAnchorTick);

  if (endSeconds <= startSeconds) {
    return null;
  }

  return {
    startSeconds,
    endSeconds,
    startMidi: event.startSound.midi,
    startCentOffset: event.startSound.centOffset,
    endMidi: event.endSound.midi,
    endCentOffset: event.endSound.centOffset,
    curve: "linear",
  };
}

/**
 * audio 재생에서 사용할 gliss 시작 tick을 결정한다.
 * - 인수 : event : analyzer가 만든 gliss event
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : 단일 셀 start anchor는 셀 시작 tick, 그 외에는 analyzer anchor tick
 */
function getAudioGlissStartTick(
  event: GlissEvent,
  noteEvents: NoteEvent[],
): GlissEvent["startAnchorTick"] {
  if (event.fromKind !== "start") {
    return event.startAnchorTick;
  }

  const noteEvent = findStartAnchorNoteEvent(event, noteEvents);

  if (noteEvent === null || !isSingleSourceCellNoteEvent(noteEvent)) {
    return event.startAnchorTick;
  }

  return cloneTimeFraction(noteEvent.time.startTick);
}

/**
 * dynamics timeline을 발음 event 내부 gain automation으로 변환한다.
 * - 인수 : dynamicsTimeline : analyzer가 만든 dynamics segment 목록
 * - 인수 : eventStartTick : 발음 event 시작 tick
 * - 인수 : eventEndTick : 발음 event 끝 tick
 * - 인수 : mapper : tick/seconds 변환기
 * - 반환값 : AudioAutomationEvent[] : event 구간과 겹치는 gain ramp 목록
 */
function buildDynamicsGainAutomation(
  dynamicsTimeline: AnalyzedDynamicsSegment[],
  eventStartTick: NoteEvent["time"]["startTick"],
  eventEndTick: NoteEvent["time"]["endTick"],
  mapper: TickTimeMapper,
): AudioScheduleEvent["automation"] {
  const eventStart = timeFractionToNumber(eventStartTick);
  const eventEnd = timeFractionToNumber(eventEndTick);
  const automation: AudioScheduleEvent["automation"] = [];

  if (eventEnd <= eventStart) {
    return automation;
  }

  for (const segment of dynamicsTimeline) {
    const segmentStart = timeFractionToNumber(segment.time.startTick);
    const segmentEnd = timeFractionToNumber(segment.time.endTick);
    const overlapStart = Math.max(eventStart, segmentStart);
    const overlapEnd = Math.min(eventEnd, segmentEnd);

    if (overlapEnd <= overlapStart) {
      continue;
    }

    const startValue = interpolateDynamicsValue(segment, overlapStart);
    const endValue = interpolateDynamicsValue(segment, overlapEnd);

    automation.push({
      kind: "gainRamp",
      startSeconds: mapper.tickToSeconds(numberToTimeFraction(overlapStart)),
      endSeconds: mapper.tickToSeconds(numberToTimeFraction(overlapEnd)),
      startValue: dynamicsValueToGain(startValue),
      endValue: dynamicsValueToGain(endValue),
      curve: Math.abs(startValue - endValue) < 1e-9 ? "instant" : segment.curve,
    });
  }

  return automation;
}

/**
 * dynamics segment 안의 특정 tick에서 dynamics 값을 선형 보간한다.
 * - 인수 : segment : dynamics analyzer segment
 * - 인수 : tick : 값을 구할 tick number
 * - 반환값 : number : 0~150 범위의 dynamics 값
 */
function interpolateDynamicsValue(
  segment: AnalyzedDynamicsSegment,
  tick: number,
): number {
  const segmentStart = timeFractionToNumber(segment.time.startTick);
  const segmentEnd = timeFractionToNumber(segment.time.endTick);

  if (
    segment.curve === "instant" ||
    segmentEnd <= segmentStart ||
    Math.abs(segment.endValue - segment.startValue) < 1e-9
  ) {
    return segment.startValue;
  }

  const ratio = (tick - segmentStart) / (segmentEnd - segmentStart);

  return segment.startValue + (segment.endValue - segment.startValue) * ratio;
}

/**
 * dynamics raw value를 audio gain 배율로 변환한다.
 * - 인수 : value : dynamics row 값. 현재 parser 기준 0~150 정수이다.
 * - 반환값 : number : 100을 기본 음량 1로 보는 gain 배율
 */
function dynamicsValueToGain(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_DYNAMICS_GAIN;
  }

  return Math.min(Math.max(value, 0), 150) / 100;
}

/**
 * gliss 시작 anchor에 걸린 tremolo를 gliss fallback 전체 구간의 audio effect로 변환한다.
 * - 인수 : event : analyzer가 만든 gliss event
 * - 인수 : mapper : tick/seconds 변환기
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : AudioScheduleEffect[] : gliss fallback에 적용할 tremolo effect 목록
 */
function buildGlissTremoloEffects(
  event: GlissEvent,
  mapper: TickTimeMapper,
  noteEvents: NoteEvent[],
): AudioScheduleEffect[] {
  const tremDivision = findStartAnchorTremoloDivision(event, noteEvents);

  if (tremDivision === null) {
    return [];
  }

  const startTick = getAudioGlissStartTick(event, noteEvents);

  return [
    {
      kind: "tremolo",
      startSeconds: mapper.tickToSeconds(startTick),
      endSeconds: mapper.tickToSeconds(event.endAnchorTick),
      durationTicks:
        timeFractionToNumber(event.endAnchorTick) -
        timeFractionToNumber(startTick),
      division: tremDivision,
    },
  ];
}

/**
 * gliss 시작 anchor에 tremolo effect가 걸려 있는지 확인한다.
 * - 인수 : event : analyzer가 만든 gliss event
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : tremolo division이 있으면 true
 */
function hasGlissTremoloEffect(
  event: GlissEvent,
  noteEvents: NoteEvent[],
): boolean {
  return findStartAnchorTremoloDivision(event, noteEvents) !== null;
}

/**
 * gliss 시작 anchor가 속한 note effect에서 tremolo division을 찾는다.
 * - 인수 : glissEvent : analyzer가 만든 gliss event
 * - 인수 : noteEvents : 같은 track의 note event 목록
 * - 반환값 : tremolo division 또는 없으면 null
 */
function findStartAnchorTremoloDivision(
  glissEvent: GlissEvent,
  noteEvents: NoteEvent[],
): number | null {
  const startSource = glissEvent.sourceCells[0];

  if (startSource === undefined) {
    return null;
  }

  for (const noteEvent of noteEvents) {
    const startAnchor = noteEvent.glissAnchors.find((anchor) =>
      anchor.glissId === glissEvent.glissId &&
      anchor.role === glissEvent.fromKind &&
      sourceCellsMatch(anchor.source, startSource)
    );

    if (startAnchor === undefined) {
      continue;
    }

    const anchorStartTick = timeFractionToNumber(startAnchor.time.startTick);
    const anchorEndTick = timeFractionToNumber(startAnchor.time.endTick);
    const tremEffect = noteEvent.effects.find((effect) =>
      effect.trem !== null &&
      effect.trem !== undefined &&
      rangesOverlap(
        anchorStartTick,
        anchorEndTick,
        timeFractionToNumber(effect.time.startTick),
        timeFractionToNumber(effect.time.endTick),
      )
    );

    if (tremEffect?.trem !== null && tremEffect?.trem !== undefined) {
      return tremEffect.trem.division;
    }
  }

  return null;
}

/**
 * long note extension에 걸린 note effect를 gliss chain effect로 보존한다.
 * - 인수 : noteEvent : chain에 흡수된 note event
 * - 인수 : mapper : tick/seconds 변환기
 * - 반환값 : audio backend가 적용할 effect 목록
 */
function buildExtensionNoteEffects(
  noteEvent: NoteEvent | null,
  mapper: TickTimeMapper,
): AudioScheduleEffect[] {
  if (noteEvent === null) {
    return [];
  }

  return buildAudioScheduleEffects(noteEvent.effects, mapper);
}

/**
 * NoteEffectSegment 목록을 초 단위 audio effect 목록으로 변환한다.
 * - 인수 : segments : analyzer note effect segment 목록
 * - 인수 : mapper : tick/seconds 변환기
 * - 반환값 : AudioScheduleEffect[] : backend가 해석할 effect 목록
 */
function buildAudioScheduleEffects(
  segments: NoteEffectSegment[],
  mapper: TickTimeMapper,
): AudioScheduleEffect[] {
  return segments.flatMap((segment) => {
    const startSeconds = mapper.tickToSeconds(segment.time.startTick);
    const endSeconds = mapper.tickToSeconds(segment.time.endTick);
    const effects: AudioScheduleEffect[] = [];

    // vibrato와 tremolo는 첫 schedule 단계에서는 DTO에 보존하고 backend에서 후속 해석한다.
    if (segment.vib) {
      effects.push({
        kind: "vibrato",
        startSeconds,
        endSeconds,
      });
    }

    if (segment.trem !== null && segment.trem !== undefined) {
      effects.push({
        kind: "tremolo",
        startSeconds,
        endSeconds,
        durationTicks:
          timeFractionToNumber(segment.time.endTick) -
          timeFractionToNumber(segment.time.startTick),
        division: segment.trem.division,
      });
    }

    return effects;
  });
}

/**
 * 두 source cell 참조가 같은 일반 cell 또는 같은 tuplet slot을 가리키는지 확인한다.
 * - 인수 : left : 왼쪽 source cell 참조
 * - 인수 : right : 오른쪽 source cell 참조
 * - 반환값 : row/col/slotIndex가 모두 같은지 여부
 */
function sourceCellsMatch(left: SourceCellRef, right: SourceCellRef): boolean {
  return left.rowId === right.rowId &&
    left.col === right.col &&
    (left.slotIndex ?? null) === (right.slotIndex ?? null);
}

/**
 * 두 배타적 tick 범위가 겹치는지 확인한다.
 * - 인수 : leftStart : 첫 범위 시작 tick
 * - 인수 : leftEnd : 첫 범위 배타적 끝 tick
 * - 인수 : rightStart : 둘째 범위 시작 tick
 * - 인수 : rightEnd : 둘째 범위 배타적 끝 tick
 * - 반환값 : 두 범위에 공통 구간이 있는지 여부
 */
function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

/**
 * TimeFraction을 얕은 공유 없이 복사한다.
 * - 인수 : value : 복사할 시간 분수
 * - 반환값 : 복제된 시간 분수
 */
function cloneTimeFraction(value: NoteEvent["time"]["endTick"]): NoteEvent["time"]["endTick"] {
  return {
    numerator: value.numerator,
    denominator: value.denominator,
  };
}

/**
 * audio schedule event를 backend 예약 순서로 정렬한다.
 * - 인수 : left : 왼쪽 event
 * - 인수 : right : 오른쪽 event
 * - 반환값 : 정렬 비교값
 */
function compareAudioScheduleEvents(
  left: { startSeconds: number; endSeconds: number; trackId: string; eventId: string },
  right: { startSeconds: number; endSeconds: number; trackId: string; eventId: string },
): number {
  if (left.startSeconds !== right.startSeconds) {
    return left.startSeconds - right.startSeconds;
  }

  if (left.endSeconds !== right.endSeconds) {
    return left.endSeconds - right.endSeconds;
  }

  if (left.trackId !== right.trackId) {
    return left.trackId.localeCompare(right.trackId);
  }

  return left.eventId.localeCompare(right.eventId);
}
