import { readFileSync } from "node:fs";

import { analyzeDocument } from "../src/core/analyze/analyze_full";
import type {
  AnalysisResult,
  AnalyzedDynamicsSegment,
  AnalyzedTimeSegment,
  GlissEvent,
  NoteEvent,
} from "../src/core/analyze/types";
import { buildParsedDocument } from "../src/core/parse/build_parsed_document";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";
import { createAudioEventQueue } from "../src/audio/audio_event_queue";
import { buildAudioSchedule } from "../src/audio/audio_schedule_builder";
import { createAudioLookaheadScheduler } from "../src/audio/audio_scheduler";
import { createPlaybackController } from "../src/audio/playback_controller";
import type {
  AudioBackend,
  AudioScheduleEvent,
} from "../src/audio/audio_types";
import {
  createEdgeEnvelope,
  midiToFrequency,
} from "../src/audio/oscillator_backend";
import {
  createTickTimeMapper,
  numberToTimeFraction,
  timeFractionToNumber,
} from "../src/audio/tick_time_mapper";

/**
 * 테스트 조건이 거짓이면 프로세스를 실패 상태로 만든다.
 * - 인수 : condition : 통과 여부
 * - 인수 : message : 실패 시 출력할 설명
 * - 반환값 : 없음
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * 두 숫자가 허용 오차 안에서 같은지 확인한다.
 * - 인수 : actual : 실제 값
 * - 인수 : expected : 기대 값
 * - 인수 : message : 실패 시 출력할 설명
 * - 반환값 : 없음
 */
function assertNear(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${message} actual=${actual} expected=${expected}`);
  }
}

/**
 * constant BPM timing segment를 만든다.
 * - 인수 : startTick : segment 시작 tick
 * - 인수 : endTick : segment 끝 tick
 * - 인수 : bpm : segment BPM
 * - 인수 : stepsPerBeat : 1 beat당 step 수
 * - 반환값 : AnalyzedTimeSegment : 테스트용 timing segment
 */
function createConstantSegment(
  startTick: number,
  endTick: number,
  bpm: number,
  stepsPerBeat: number,
): AnalyzedTimeSegment {
  return {
    time: {
      startTick: numberToTimeFraction(startTick),
      endTick: numberToTimeFraction(endTick),
    },
    startBpm: bpm,
    endBpm: bpm,
    bpmCurve: "instant",
    beatsPerBar: 4,
    stepsPerBeat,
    sourceCells: [],
  };
}

/**
 * linear BPM timing segment를 만든다.
 * - 인수 : startTick : segment 시작 tick
 * - 인수 : endTick : segment 끝 tick
 * - 인수 : startBpm : 시작 BPM
 * - 인수 : endBpm : 종료 BPM
 * - 인수 : stepsPerBeat : 1 beat당 step 수
 * - 반환값 : AnalyzedTimeSegment : 테스트용 timing segment
 */
function createLinearSegment(
  startTick: number,
  endTick: number,
  startBpm: number,
  endBpm: number,
  stepsPerBeat: number,
): AnalyzedTimeSegment {
  return {
    time: {
      startTick: numberToTimeFraction(startTick),
      endTick: numberToTimeFraction(endTick),
    },
    startBpm,
    endBpm,
    bpmCurve: "linear",
    beatsPerBar: 4,
    stepsPerBeat,
    sourceCells: [],
  };
}

/**
 * dynamics timeline segment를 만든다.
 * - 인수 : startTick : segment 시작 tick
 * - 인수 : endTick : segment 끝 tick
 * - 인수 : startValue : 시작 dynamics 값
 * - 인수 : endValue : 종료 dynamics 값
 * - 인수 : curve : 값 변화 방식
 * - 반환값 : AnalyzedDynamicsSegment : 테스트용 dynamics segment
 */
function createDynamicsSegment(
  startTick: number,
  endTick: number,
  startValue: number,
  endValue: number,
  curve: "instant" | "linear",
): AnalyzedDynamicsSegment {
  return {
    time: {
      startTick: numberToTimeFraction(startTick),
      endTick: numberToTimeFraction(endTick),
    },
    startValue,
    endValue,
    curve,
    sourceCells: [],
  };
}

/**
 * gliss anchor가 붙은 테스트용 note event를 만든다.
 * - 인수 : rowId : anchor note row id
 * - 인수 : col : anchor note column
 * - 인수 : midi : note MIDI pitch
 * - 인수 : role : gliss anchor role
 * - 반환값 : NoteEvent : 테스트용 note event
 */
function createGlissAnchorNoteEvent(
  rowId: string,
  col: number,
  midi: number,
  role: "start" | "mid" | "end",
): NoteEvent {
  return {
    eventKind: "note",
    eventId: `basic:note:${rowId}:${col}`,
    trackId: "basic",
    time: {
      startTick: numberToTimeFraction(col),
      endTick: numberToTimeFraction(col + 1),
    },
    sourceCells: [{ rowId, col }],
    text: String(midi),
    displayTextAnchors: [],
    display: {
      rowId,
      centOffset: 0,
    },
    sound: {
      midi,
      centOffset: 0,
    },
    effects: [],
    glissRole: {
      glissId: "a",
      role,
    },
    glissAnchors: [
      {
        glissId: "a",
        role,
        source: { rowId, col },
        time: {
          startTick: numberToTimeFraction(col),
          endTick: numberToTimeFraction(col + 1),
        },
        display: {
          rowId,
          centOffset: 0,
        },
      },
    ],
    tuplet: null,
  };
}

/**
 * 테스트용 gliss segment event를 만든다.
 * - 인수 : startRowId : 시작 anchor row id
 * - 인수 : startCol : 시작 anchor column
 * - 인수 : startMidi : 시작 MIDI pitch
 * - 인수 : fromKind : 시작 anchor kind
 * - 인수 : endRowId : 종료 anchor row id
 * - 인수 : endCol : 종료 anchor column
 * - 인수 : endMidi : 종료 MIDI pitch
 * - 인수 : toKind : 종료 anchor kind
 * - 인수 : startAnchorTick : 시작 anchor tick number
 * - 인수 : endAnchorTick : 종료 anchor tick number
 * - 반환값 : GlissEvent : 테스트용 gliss event
 */
function createGlissSegmentEvent(
  startRowId: string,
  startCol: number,
  startMidi: number,
  fromKind: "start" | "mid",
  endRowId: string,
  endCol: number,
  endMidi: number,
  toKind: "mid" | "end",
  startAnchorTick: number,
  endAnchorTick: number,
): GlissEvent {
  return {
    eventKind: "gliss",
    eventId: `basic:gliss:a:${startRowId}:${startCol}`,
    trackId: "basic",
    time: {
      startTick: numberToTimeFraction(startCol),
      endTick: numberToTimeFraction(endCol + 1),
    },
    sourceCells: [
      { rowId: startRowId, col: startCol },
      { rowId: endRowId, col: endCol },
    ],
    startDisplay: {
      rowId: startRowId,
      centOffset: 0,
    },
    endDisplay: {
      rowId: endRowId,
      centOffset: 0,
    },
    startSound: {
      midi: startMidi,
      centOffset: 0,
    },
    endSound: {
      midi: endMidi,
      centOffset: 0,
    },
    glissId: "a",
    startAnchorTick: numberToTimeFraction(startAnchorTick),
    endAnchorTick: numberToTimeFraction(endAnchorTick),
    fromKind,
    toKind,
    startAttach: "attack",
    endAttach: "release",
  };
}

/**
 * tuplet slot gliss anchor가 붙은 테스트용 note event를 만든다.
 * - 인수 : rowId : anchor note row id
 * - 인수 : sourceCol : tuplet head column
 * - 인수 : slotIndex : tuplet slot index
 * - 인수 : startTick : slot 시작 tick number
 * - 인수 : endTick : slot 끝 tick number
 * - 인수 : midi : note MIDI pitch
 * - 인수 : role : gliss anchor role
 * - 반환값 : NoteEvent : 테스트용 tuplet slot note event
 */
function createTupletGlissAnchorNoteEvent(
  rowId: string,
  sourceCol: number,
  slotIndex: number,
  startTick: number,
  endTick: number,
  midi: number,
  role: "start" | "end",
): NoteEvent {
  return {
    eventKind: "note",
    eventId: `basic:note:${rowId}:${sourceCol}:slot:${slotIndex}`,
    trackId: "basic",
    time: {
      startTick: numberToTimeFraction(startTick),
      endTick: numberToTimeFraction(endTick),
    },
    sourceCells: [{ rowId, col: sourceCol, slotIndex }],
    text: String(midi),
    displayTextAnchors: [],
    display: {
      rowId,
      centOffset: 0,
    },
    sound: {
      midi,
      centOffset: 0,
    },
    effects: [],
    glissRole: {
      glissId: "a",
      role,
    },
    glissAnchors: [
      {
        glissId: "a",
        role,
        source: { rowId, col: sourceCol, slotIndex },
        time: {
          startTick: numberToTimeFraction(startTick),
          endTick: numberToTimeFraction(endTick),
        },
        display: {
          rowId,
          centOffset: 0,
        },
      },
    ],
    tuplet: {
      groupId: `basic:tuplet:${rowId}:${sourceCol}`,
      slotIndex,
      divNum: 6,
    },
  };
}

const singleMapper = createTickTimeMapper([
  createConstantSegment(0, 16, 120, 4),
]);

assertNear(singleMapper.tickToSeconds(numberToTimeFraction(0)), 0, "tick 0 should be 0s.");
assertNear(singleMapper.tickToSeconds(numberToTimeFraction(1)), 0.125, "BPM 120 SPB 4 should make 1 tick 0.125s.");
assertNear(singleMapper.tickToSeconds(numberToTimeFraction(16)), 2, "16 ticks should be 2s.");
assertNear(singleMapper.getDurationSeconds(), 2, "single segment duration mismatch.");
assertNear(timeFractionToNumber(singleMapper.secondsToTick(0.125)), 1, "0.125s should map to tick 1.");
assertNear(timeFractionToNumber(singleMapper.secondsToTick(2)), 16, "duration end should map to end tick.");

const multiMapper = createTickTimeMapper([
  createConstantSegment(0, 8, 120, 4),
  createConstantSegment(8, 16, 60, 4),
]);

assertNear(multiMapper.tickToSeconds(numberToTimeFraction(8)), 1, "second segment should start at 1s.");
assertNear(multiMapper.tickToSeconds(numberToTimeFraction(9)), 1.25, "BPM 60 SPB 4 should make 1 tick 0.25s.");
assertNear(multiMapper.tickToSeconds(numberToTimeFraction(16)), 3, "multi segment duration mismatch.");
assertNear(multiMapper.getDurationSeconds(), 3, "multi segment total duration mismatch.");
assertNear(timeFractionToNumber(multiMapper.secondsToTick(1)), 8, "1s should map to second segment start tick.");
assertNear(timeFractionToNumber(multiMapper.secondsToTick(1.25)), 9, "1.25s should map to tick 9.");
assertNear(timeFractionToNumber(multiMapper.secondsToTick(3)), 16, "multi duration end should map to end tick.");

const linearMapper = createTickTimeMapper([
  createLinearSegment(0, 8, 120, 240, 4),
]);

assertNear(
  linearMapper.tickToSeconds(numberToTimeFraction(4)),
  Math.log(1.5),
  "Linear BPM 120..240 should integrate to ln(1.5) seconds at tick 4.",
);
assertNear(
  linearMapper.tickToSeconds(numberToTimeFraction(8)),
  Math.log(2),
  "Linear BPM 120..240 should integrate to ln(2) seconds at tick 8.",
);
assertNear(
  timeFractionToNumber(linearMapper.secondsToTick(Math.log(1.5))),
  4,
  "Linear BPM inverse mapping should recover tick 4.",
);

const fractionalTick = numberToTimeFraction(8.5);

assert(fractionalTick.numerator === 17 && fractionalTick.denominator === 2, "8.5 should reduce to 17/2.");
assertNear(multiMapper.tickToSeconds(fractionalTick), 1.125, "fractional tick should map inside second segment.");
assertNear(midiToFrequency(69, 0), 440, "A4 should be 440Hz.");
assertNear(midiToFrequency(69, 100), midiToFrequency(70, 0), "+100 cents should match the next semitone.");
assertNear(midiToFrequency(69, -100), midiToFrequency(68, 0), "-100 cents should match the previous semitone.");

const shortEnvelope = createEdgeEnvelope(10, 10.03125, 0.005, 0.03);

assertNear(shortEnvelope.attackEndTime, 10.005, "Short envelope attack end mismatch.");
assert(
  shortEnvelope.releaseStartTime >= shortEnvelope.attackEndTime,
  "Short envelope release should not start before attack ends.",
);

const effectNoteEvent: NoteEvent = {
  eventKind: "note",
  eventId: "basic:note:s1-note-60:0",
  trackId: "basic",
  time: {
    startTick: numberToTimeFraction(0),
    endTick: numberToTimeFraction(3),
  },
  sourceCells: [{ rowId: "s1-note-60", col: 0 }],
  text: "C4",
  displayTextAnchors: [],
  display: {
    rowId: "s1-note-60",
    centOffset: 0,
  },
  sound: {
    midi: 60,
    centOffset: 0,
  },
  effects: [
    {
      time: {
        startTick: numberToTimeFraction(0),
        endTick: numberToTimeFraction(1),
      },
      vib: false,
      trem: { division: 3 },
    },
    {
      time: {
        startTick: numberToTimeFraction(1),
        endTick: numberToTimeFraction(3),
      },
      vib: true,
      trem: null,
    },
  ],
  glissRole: null,
  glissAnchors: [
    {
      glissId: "a",
      role: "start",
      source: { rowId: "s1-note-60", col: 0 },
      time: {
        startTick: numberToTimeFraction(0),
        endTick: numberToTimeFraction(1),
      },
      display: {
        rowId: "s1-note-60",
        centOffset: 0,
      },
    },
  ],
  tuplet: null,
};
const effectGlissEvent: GlissEvent = {
  eventKind: "gliss",
  eventId: "basic:gliss:a:s1-note-60:0:s1-note-64:3",
  trackId: "basic",
  time: {
    startTick: numberToTimeFraction(0),
    endTick: numberToTimeFraction(3),
  },
  sourceCells: [
    { rowId: "s1-note-60", col: 0 },
    { rowId: "s1-note-64", col: 3 },
  ],
  startDisplay: {
    rowId: "s1-note-60",
    centOffset: 0,
  },
  endDisplay: {
    rowId: "s1-note-64",
    centOffset: 0,
  },
  startSound: {
    midi: 60,
    centOffset: 0,
  },
  endSound: {
    midi: 64,
    centOffset: 0,
  },
  glissId: "a",
  startAnchorTick: numberToTimeFraction(0.5),
  endAnchorTick: numberToTimeFraction(3),
  fromKind: "start",
  toKind: "end",
  startAttach: "attack",
  endAttach: "release",
};
const connectedEffectGlissEvent: GlissEvent = {
  eventKind: "gliss",
  eventId: "basic:gliss:a:s1-note-64:3:s1-note-67:4",
  trackId: "basic",
  time: {
    startTick: numberToTimeFraction(3),
    endTick: numberToTimeFraction(4),
  },
  sourceCells: [
    { rowId: "s1-note-64", col: 3 },
    { rowId: "s1-note-67", col: 4 },
  ],
  startDisplay: {
    rowId: "s1-note-64",
    centOffset: 0,
  },
  endDisplay: {
    rowId: "s1-note-67",
    centOffset: 0,
  },
  startSound: {
    midi: 64,
    centOffset: 0,
  },
  endSound: {
    midi: 67,
    centOffset: 0,
  },
  glissId: "a",
  startAnchorTick: numberToTimeFraction(3),
  endAnchorTick: numberToTimeFraction(4),
  fromKind: "mid",
  toKind: "end",
  startAttach: "attack",
  endAttach: "release",
};
const effectAnalysis: AnalysisResult = {
  timingTimeline: [
    {
      time: {
        startTick: numberToTimeFraction(0),
        endTick: numberToTimeFraction(4),
      },
      startBpm: 120,
      endBpm: 120,
      bpmCurve: "instant",
      beatsPerBar: 4,
      stepsPerBeat: 4,
      sourceCells: [],
    },
  ],
  dynamicsTimeline: [
    createDynamicsSegment(0, 2, 50, 150, "linear"),
    createDynamicsSegment(2, 4, 80, 80, "instant"),
  ],
  trackResults: [
    {
      trackId: "basic",
      events: [effectNoteEvent, effectGlissEvent, connectedEffectGlissEvent],
    },
  ],
  analysisIssues: [],
};
const effectSchedule = buildAudioSchedule({
  analysis: effectAnalysis,
  activeTrackIds: ["basic"],
});
const effectScheduleEvent = effectSchedule.events[0];

assert(effectScheduleEvent !== undefined, "Effect schedule should include the synthetic note.");
assert(
  effectScheduleEvent?.sourceEventKind === "note",
  "First effect schedule event should be a note.",
);

if (effectScheduleEvent?.sourceEventKind === "note") {
  const tremolo = effectScheduleEvent.effects.find((effect) => effect.kind === "tremolo");
  const vibrato = effectScheduleEvent.effects.find((effect) => effect.kind === "vibrato");
  const dynamicsAutomation = effectScheduleEvent.automation.find(
    (automation) => automation.kind === "gainRamp",
  );

  assertNear(
    effectScheduleEvent.endSeconds,
    0.0625,
    "Gliss start anchor note should be clipped at the gliss start tick.",
  );
  assert(tremolo !== undefined, "Schedule should preserve tremolo effect.");
  assert(vibrato !== undefined, "Schedule should preserve vibrato effect.");
  assert(dynamicsAutomation !== undefined, "Schedule should include note dynamics automation.");

  if (tremolo !== undefined) {
    assert(tremolo.division === 3, "Tremolo schedule should keep division.");
    assertNear(tremolo.durationTicks, 1, "Tremolo schedule should keep source duration in ticks.");
    assertNear(tremolo.startSeconds, 0, "Tremolo should start at note start.");
    assertNear(tremolo.endSeconds, 0.125, "One tick at BPM 120/SPB 4 should last 0.125s.");
  }

  if (vibrato !== undefined) {
    assertNear(vibrato.startSeconds, 0.125, "Vibrato should start on the second tick.");
    assertNear(vibrato.endSeconds, 0.375, "Vibrato should end with the note.");
  }

  if (dynamicsAutomation !== undefined && dynamicsAutomation.kind === "gainRamp") {
    assertNear(dynamicsAutomation.startSeconds, 0, "Note dynamics should start with the note.");
    assertNear(dynamicsAutomation.endSeconds, 0.0625, "Note dynamics should end at clipped note end.");
    assertNear(dynamicsAutomation.startValue, 0.5, "Dynamics 50 should map to gain 0.5.");
    assertNear(dynamicsAutomation.endValue, 0.75, "Dynamics should interpolate to gain 0.75 at tick 0.5.");
  }
}

const tremoloBoundaryGlissChainEvent = effectSchedule.events.find(
  (event) => event.sourceEventKind === "glissChain",
);
const tremoloBoundaryGlissEvents = effectSchedule.events.filter(
  (event) => event.sourceEventKind === "gliss",
);

assert(
  tremoloBoundaryGlissChainEvent === undefined,
  "Tremolo state changes at a shared anchor should split connected gliss chains.",
);
assert(
  tremoloBoundaryGlissEvents.length === 2,
  "Tremolo boundary fixture should keep two separate gliss schedule events.",
);

const tremoloGlissEvent = tremoloBoundaryGlissEvents[0];

if (tremoloGlissEvent?.sourceEventKind === "gliss") {
  const tremolo = tremoloGlissEvent.effects.find((effect) => effect.kind === "tremolo");
  const dynamicsAutomation = tremoloGlissEvent.automation.filter(
    (automation) => automation.kind === "gainRamp",
  );

  assertNear(tremoloGlissEvent.startSeconds, 0.0625, "Tremolo gliss should start at its start anchor.");
  assertNear(tremoloGlissEvent.endSeconds, 0.375, "Tremolo gliss should end at its end anchor.");
  assert(tremoloGlissEvent.startMidi === 60, "Tremolo gliss should keep start MIDI.");
  assert(tremoloGlissEvent.endMidi === 64, "Tremolo gliss should keep end MIDI.");
  assert(tremolo !== undefined, "Tremolo gliss should inherit tremolo from its start anchor.");
  assert(dynamicsAutomation.length === 2, "Tremolo gliss should split dynamics automation by timeline segments.");

  if (tremolo !== undefined) {
    assert(tremolo.division === 3, "Tremolo gliss should keep start anchor division.");
    assertNear(tremolo.startSeconds, 0.0625, "Tremolo gliss tremolo should start with the gliss.");
    assertNear(tremolo.endSeconds, 0.375, "Tremolo gliss tremolo should end with the gliss.");
  }
}

const anchorOverlapSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 8, 120, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [
          createGlissAnchorNoteEvent("s1-note-60", 0, 60, "start"),
          createGlissAnchorNoteEvent("s1-note-64", 2, 64, "mid"),
          createGlissAnchorNoteEvent("s1-note-67", 4, 67, "end"),
          createGlissSegmentEvent("s1-note-60", 0, 60, "start", "s1-note-64", 2, 64, "mid", 0.5, 2.5),
          createGlissSegmentEvent("s1-note-64", 2, 64, "mid", "s1-note-67", 4, 67, "end", 2.5, 4.5),
        ],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic"],
});
const anchorOverlapGlissChain = anchorOverlapSchedule.events.find(
  (event) => event.sourceEventKind === "glissChain",
);
const anchorOverlapMiddleNote = anchorOverlapSchedule.events.find(
  (event) => event.eventId === "basic:note:s1-note-64:2",
);
const anchorOverlapChainGainScale = anchorOverlapGlissChain?.automation.filter(
  (automation) => automation.kind === "gainScale",
) ?? [];

assert(
  anchorOverlapGlissChain?.sourceEventKind === "glissChain",
  "Anchor overlap fixture should create one gliss chain.",
);
assert(
  anchorOverlapMiddleNote === undefined,
  "Middle anchor note should be removed from audio schedule when connected gliss chain passes through it.",
);
assert(
  anchorOverlapChainGainScale.length === 1 &&
    anchorOverlapChainGainScale[0]?.startValue === 1 &&
    anchorOverlapChainGainScale[0]?.endValue === 1,
  "Connected gliss chain should not receive anchor-overlap gainScale dips.",
);

const singleAnchorMuteSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 4, 120, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [
          createGlissAnchorNoteEvent("s1-note-60", 0, 60, "start"),
          createGlissAnchorNoteEvent("s1-note-64", 2, 64, "end"),
          createGlissSegmentEvent("s1-note-60", 0, 60, "start", "s1-note-64", 2, 64, "end", 0.5, 2.5),
        ],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic"],
});
const singleAnchorMuteNotes = singleAnchorMuteSchedule.events.filter(
  (event) => event.sourceEventKind === "note",
);
const singleAnchorMuteGliss = singleAnchorMuteSchedule.events.find(
  (event) => event.sourceEventKind === "gliss",
);

assert(singleAnchorMuteNotes.length === 0, "Single-cell gliss anchor notes should be muted.");
assert(
  singleAnchorMuteGliss?.sourceEventKind === "gliss",
  "Single-cell gliss anchors should keep the fallback gliss event.",
);

if (singleAnchorMuteGliss?.sourceEventKind === "gliss") {
  assertNear(
    singleAnchorMuteGliss.startSeconds,
    0,
    "Single-cell start anchor gliss should start audio at the source cell start.",
  );
}

const tupletBoundaryGlissSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 16, 240, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [
          createTupletGlissAnchorNoteEvent("s1-note-69", 0, 5, 40 / 6, 48 / 6, 69, "start"),
          createTupletGlissAnchorNoteEvent("s1-note-70", 8, 0, 48 / 6, 56 / 6, 70, "end"),
          {
            eventKind: "gliss",
            eventId: "basic:gliss:a:s1-note-69:0:slot:5",
            trackId: "basic",
            time: {
              startTick: numberToTimeFraction(40 / 6),
              endTick: numberToTimeFraction(56 / 6),
            },
            sourceCells: [
              { rowId: "s1-note-69", col: 0, slotIndex: 5 },
              { rowId: "s1-note-70", col: 8, slotIndex: 0 },
            ],
            startDisplay: {
              rowId: "s1-note-69",
              centOffset: 0,
            },
            endDisplay: {
              rowId: "s1-note-70",
              centOffset: 0,
            },
            startSound: {
              midi: 69,
              centOffset: 0,
            },
            endSound: {
              midi: 70,
              centOffset: 0,
            },
            glissId: "a",
            startAnchorTick: numberToTimeFraction(43 / 6),
            endAnchorTick: numberToTimeFraction(51 / 6),
            fromKind: "start",
            toKind: "end",
            startAttach: "attack",
            endAttach: "release",
          },
        ],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic"],
});
const tupletBoundaryStartNote = tupletBoundaryGlissSchedule.events.find(
  (event) => event.eventId === "basic:note:s1-note-69:0:slot:5",
);
const tupletBoundaryEndNote = tupletBoundaryGlissSchedule.events.find(
  (event) => event.eventId === "basic:note:s1-note-70:8:slot:0",
);
const tupletBoundaryGliss = tupletBoundaryGlissSchedule.events.find(
  (event) => event.sourceEventKind === "glissChain",
);

assert(
  tupletBoundaryStartNote === undefined &&
    tupletBoundaryEndNote === undefined &&
    tupletBoundaryGliss?.sourceEventKind === "glissChain",
  "Tuplet boundary gliss fixture should absorb both anchor notes into one gliss chain.",
);

if (
  tupletBoundaryGliss?.sourceEventKind === "glissChain"
) {
  assertNear(tupletBoundaryGliss.startSeconds, timeFractionToNumber(numberToTimeFraction(40 / 6)) / 16,
    "Chain should start at the first slot onset.");
  assertNear(
    (tupletBoundaryGliss.segments[0]?.endSeconds ?? 0) - tupletBoundaryGliss.startSeconds,
    0.03125,
    "240BPM 8:6 boundary start anchor should remain a constant-pitch segment inside the chain.",
  );
  assertNear(
    tupletBoundaryGliss.segments[1]?.endSeconds ?? -1,
    0.53125,
    "240BPM 8:6 boundary ramp should end at the first-slot end anchor.",
  );
}

const longStartAnchorNote: NoteEvent = {
  ...createGlissAnchorNoteEvent("s1-note-60", 2, 60, "start"),
  eventId: "basic:note:s1-note-60:0",
  time: {
    startTick: numberToTimeFraction(0),
    endTick: numberToTimeFraction(3),
  },
  sourceCells: [
    { rowId: "s1-note-60", col: 0 },
    { rowId: "s1-note-60", col: 1 },
    { rowId: "s1-note-60", col: 2 },
  ],
  effects: [
    {
      time: {
        startTick: numberToTimeFraction(0),
        endTick: numberToTimeFraction(2),
      },
      vib: true,
      trem: null,
    },
  ],
};
const longEndAnchorNote: NoteEvent = {
  ...createGlissAnchorNoteEvent("s1-note-67", 4, 67, "end"),
  eventId: "basic:note:s1-note-67:4",
  time: {
    startTick: numberToTimeFraction(4),
    endTick: numberToTimeFraction(6),
  },
  sourceCells: [
    { rowId: "s1-note-67", col: 4 },
    { rowId: "s1-note-67", col: 5 },
  ],
  effects: [
    {
      time: {
        startTick: numberToTimeFraction(4),
        endTick: numberToTimeFraction(6),
      },
      vib: false,
      trem: { division: 4 },
    },
  ],
};
const longAnchorExtensionSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 8, 120, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [
          longStartAnchorNote,
          longEndAnchorNote,
          createGlissSegmentEvent("s1-note-60", 2, 60, "start", "s1-note-67", 4, 67, "end", 2.5, 4.5),
        ],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic"],
});
const longAnchorExtensionNotes = longAnchorExtensionSchedule.events.filter(
  (event) => event.sourceEventKind === "note",
);
const longAnchorExtensionChain = longAnchorExtensionSchedule.events.find(
  (event) => event.sourceEventKind === "glissChain",
);

assert(longAnchorExtensionNotes.length === 0, "Long-note gliss anchors should be muted after chain absorption.");
assert(
  longAnchorExtensionChain?.sourceEventKind === "glissChain",
  "Long-note gliss anchors should promote a single gliss segment to a chain.",
);

if (longAnchorExtensionChain?.sourceEventKind === "glissChain") {
  const [startSegment, glissSegment, endSegment] = longAnchorExtensionChain.segments;
  const vibrato = longAnchorExtensionChain.effects.find((effect) => effect.kind === "vibrato");
  const tremolo = longAnchorExtensionChain.effects.find((effect) => effect.kind === "tremolo");

  assert(longAnchorExtensionChain.segments.length === 3, "Long-note chain should include two constant pitch segments and one ramp.");
  assertNear(longAnchorExtensionChain.startSeconds, 0, "Long-note chain should start at the absorbed start note.");
  assertNear(longAnchorExtensionChain.endSeconds, 0.75, "Long-note chain should end at the absorbed end note.");
  assertNear(startSegment?.startSeconds ?? -1, 0, "Start extension should begin at note start.");
  assertNear(startSegment?.endSeconds ?? -1, 0.3125, "Start extension should end at the gliss start anchor.");
  assert(startSegment?.startMidi === 60 && startSegment.endMidi === 60, "Start extension should keep constant pitch.");
  assertNear(glissSegment?.startSeconds ?? -1, 0.3125, "Ramp should start at the gliss start anchor.");
  assertNear(glissSegment?.endSeconds ?? -1, 0.5625, "Ramp should end at the gliss end anchor.");
  assertNear(endSegment?.startSeconds ?? -1, 0.5625, "End extension should start at the gliss end anchor.");
  assertNear(endSegment?.endSeconds ?? -1, 0.75, "End extension should continue through the long end note.");
  assert(endSegment?.startMidi === 67 && endSegment.endMidi === 67, "End extension should keep constant pitch.");
  assert(vibrato !== undefined, "Absorbed start long note should preserve vibrato on the chain.");
  assert(tremolo !== undefined, "Absorbed end long note should preserve tremolo on the chain.");
}

const sharedExtensionStartNote = createGlissAnchorNoteEvent("s1-note-67", 0, 67, "start");
const sharedExtensionBridgeNote: NoteEvent = {
  eventKind: "note",
  eventId: "basic:note:s1-note-66:2",
  trackId: "basic",
  time: {
    startTick: numberToTimeFraction(2),
    endTick: numberToTimeFraction(4),
  },
  sourceCells: [
    { rowId: "s1-note-66", col: 2 },
    { rowId: "s1-note-66", col: 3 },
  ],
  text: "66",
  displayTextAnchors: [],
  display: {
    rowId: "s1-note-66",
    centOffset: 0,
  },
  sound: {
    midi: 66,
    centOffset: 0,
  },
  effects: [],
  glissRole: null,
  glissAnchors: [
    {
      glissId: "a",
      role: "end",
      source: { rowId: "s1-note-66", col: 2 },
      time: {
        startTick: numberToTimeFraction(2),
        endTick: numberToTimeFraction(3),
      },
      display: {
        rowId: "s1-note-66",
        centOffset: 0,
      },
    },
    {
      glissId: "b",
      role: "start",
      source: { rowId: "s1-note-66", col: 3 },
      time: {
        startTick: numberToTimeFraction(3),
        endTick: numberToTimeFraction(4),
      },
      display: {
        rowId: "s1-note-66",
        centOffset: 0,
      },
    },
  ],
  tuplet: null,
};
const sharedExtensionEndNote = {
  ...createGlissAnchorNoteEvent("s1-note-69", 5, 69, "end"),
  glissRole: {
    glissId: "b",
    role: "end" as const,
  },
  glissAnchors: [
    {
      glissId: "b",
      role: "end" as const,
      source: { rowId: "s1-note-69", col: 5 },
      time: {
        startTick: numberToTimeFraction(5),
        endTick: numberToTimeFraction(6),
      },
      display: {
        rowId: "s1-note-69",
        centOffset: 0,
      },
    },
  ],
};
const sharedExtensionSecondGliss: GlissEvent = {
  ...createGlissSegmentEvent("s1-note-66", 3, 66, "start", "s1-note-69", 5, 69, "end", 3.5, 5.5),
  eventId: "basic:gliss:b:s1-note-66:3",
  glissId: "b",
};
const sharedExtensionSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 8, 120, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [
          sharedExtensionStartNote,
          sharedExtensionBridgeNote,
          sharedExtensionEndNote,
          createGlissSegmentEvent("s1-note-67", 0, 67, "start", "s1-note-66", 2, 66, "end", 0.5, 2.5),
          sharedExtensionSecondGliss,
        ],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic"],
});
const sharedExtensionChains = sharedExtensionSchedule.events.filter(
  (event) => event.sourceEventKind === "glissChain",
);
const sharedExtensionGlisses = sharedExtensionSchedule.events.filter(
  (event) => event.sourceEventKind === "gliss",
);
const sharedExtensionBridgeSchedule = sharedExtensionSchedule.events.find(
  (event) => event.eventId === sharedExtensionBridgeNote.eventId,
);

assert(
  sharedExtensionChains.length === 1,
  "Shared long note between independent gliss segments should be promoted to one continuous chain.",
);
assert(
  sharedExtensionGlisses.length === 0,
  "Independent gliss segments around a shared long note should not remain as separate fallback gliss events.",
);
assert(
  sharedExtensionBridgeSchedule === undefined,
  "Shared long note should be absorbed into the continuous gliss chain.",
);

const sharedExtensionChain = sharedExtensionChains[0];

if (sharedExtensionChain?.sourceEventKind === "glissChain") {
  const [, bridgeSegment] = sharedExtensionChain.segments;

  assert(sharedExtensionChain.segments.length === 3, "Shared extension chain should contain gliss, hold bridge, gliss segments.");
  assertNear(bridgeSegment?.startSeconds ?? -1, 0.3125, "Bridge segment should start at the first gliss end anchor.");
  assertNear(bridgeSegment?.endSeconds ?? -1, 0.4375, "Bridge segment should end at the second gliss start anchor.");
  assert(bridgeSegment?.startMidi === 66 && bridgeSegment.endMidi === 66, "Bridge segment should keep the shared hold pitch.");
  const gainScaleAutomations = sharedExtensionChain.automation.filter(
    (automation) => automation.kind === "gainScale",
  );
  assert(
    gainScaleAutomations.every((automation) => automation.startValue === 1 && automation.endValue === 1),
    "Shared extension chain should not be gain-reduced by duplicate overlap.",
  );
}

const overlapNoteEvent: NoteEvent = {
  ...effectNoteEvent,
  eventId: "basic:note:s1-note-60:8",
  time: {
    startTick: numberToTimeFraction(0),
    endTick: numberToTimeFraction(2),
  },
  sourceCells: [{ rowId: "s1-note-60", col: 8 }],
  effects: [],
  glissAnchors: [],
};
const overlapOptionalNoteEvent: NoteEvent = {
  ...overlapNoteEvent,
  eventId: "optional:note:s1-note-64:8",
  trackId: "optional",
  sourceCells: [{ rowId: "s1-note-64", col: 8 }],
  sound: {
    midi: 64,
    centOffset: 0,
  },
};
const overlapSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 4, 120, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [overlapNoteEvent],
      },
      {
        trackId: "optional",
        events: [overlapOptionalNoteEvent],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic", "optional"],
});
const overlapScaleAutomations = overlapSchedule.events.flatMap((event) =>
  event.automation.filter((automation) => automation.kind === "gainScale"),
);

assert(overlapSchedule.events.length === 2, "Overlap schedule should include both active track notes.");
assert(
  overlapScaleAutomations.length === 2,
  "Each overlapping event should receive gainScale automation.",
);
assert(
  overlapScaleAutomations.every((automation) =>
    automation.startValue === 1 && automation.endValue === 1,
  ),
  "Different-pitch simultaneous events should keep full gain.",
);

const overlapExtraNoteEvent: NoteEvent = {
  ...overlapNoteEvent,
  eventId: "extra:note:s1-note-67:8",
  trackId: "extra",
  sourceCells: [{ rowId: "s1-note-67", col: 8 }],
  sound: {
    midi: 67,
    centOffset: 0,
  },
};
const threePitchChordSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 4, 120, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [overlapNoteEvent],
      },
      {
        trackId: "optional",
        events: [overlapOptionalNoteEvent],
      },
      {
        trackId: "extra",
        events: [overlapExtraNoteEvent],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic", "optional", "extra"],
});
const threePitchChordScaleAutomations = threePitchChordSchedule.events.flatMap((event) =>
  event.automation.filter((automation) => automation.kind === "gainScale"),
);
const threePitchChordGainScale = Math.sqrt(2 / 3);

assert(threePitchChordSchedule.events.length === 3, "Three-pitch chord schedule should include all active notes.");
assert(
  threePitchChordScaleAutomations.length === 3,
  "Each event in a three-pitch chord should receive gainScale automation.",
);
assert(
  threePitchChordScaleAutomations.every((automation) =>
    Math.abs(automation.startValue - threePitchChordGainScale) <= 1e-9 &&
    Math.abs(automation.endValue - threePitchChordGainScale) <= 1e-9
  ),
  "Three different pitches should use power-based chord gain instead of full gain.",
);

const duplicatePitchOptionalNoteEvent: NoteEvent = {
  ...overlapOptionalNoteEvent,
  eventId: "optional:note:s1-note-60:8",
  sourceCells: [{ rowId: "s1-note-60", col: 8 }],
  sound: {
    midi: 60,
    centOffset: 0,
  },
};
const duplicatePitchSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 4, 120, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [overlapNoteEvent],
      },
      {
        trackId: "optional",
        events: [duplicatePitchOptionalNoteEvent],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic", "optional"],
});
const duplicatePitchScaleAutomations = duplicatePitchSchedule.events.flatMap((event) =>
  event.automation.filter((automation) => automation.kind === "gainScale"),
);

assert(duplicatePitchSchedule.events.length === 2, "Duplicate-pitch schedule should include both active track notes.");
assert(
  duplicatePitchScaleAutomations.length === 2,
  "Each duplicate-pitch event should receive gainScale automation.",
);
assert(
  duplicatePitchScaleAutomations.every((automation) =>
    automation.startValue === 0.5 && automation.endValue === 0.5,
  ),
  "Same-pitch simultaneous events should each scale to half gain.",
);

const duplicatePlusChordSchedule = buildAudioSchedule({
  analysis: {
    timingTimeline: [
      createConstantSegment(0, 4, 120, 4),
    ],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [overlapNoteEvent],
      },
      {
        trackId: "optional",
        events: [duplicatePitchOptionalNoteEvent, overlapOptionalNoteEvent],
      },
      {
        trackId: "extra",
        events: [overlapExtraNoteEvent],
      },
    ],
    analysisIssues: [],
  },
  activeTrackIds: ["basic", "optional", "extra"],
});
const duplicatePlusChordBasicScale = duplicatePlusChordSchedule.events
  .find((event) => event.eventId === overlapNoteEvent.eventId)
  ?.automation.find((automation) => automation.kind === "gainScale");
const duplicatePlusChordOptionalDuplicateScale = duplicatePlusChordSchedule.events
  .find((event) => event.eventId === duplicatePitchOptionalNoteEvent.eventId)
  ?.automation.find((automation) => automation.kind === "gainScale");
const duplicatePlusChordOptionalDifferentScale = duplicatePlusChordSchedule.events
  .find((event) => event.eventId === overlapOptionalNoteEvent.eventId)
  ?.automation.find((automation) => automation.kind === "gainScale");

assert(
  duplicatePlusChordSchedule.events.length === 4,
  "Duplicate plus chord schedule should include duplicate pitch and different pitches.",
);
assert(
  duplicatePlusChordBasicScale?.kind === "gainScale" &&
    duplicatePlusChordOptionalDuplicateScale?.kind === "gainScale" &&
    duplicatePlusChordOptionalDifferentScale?.kind === "gainScale",
  "Duplicate plus chord schedule should add gainScale to overlapping notes.",
);
assertNear(
  duplicatePlusChordBasicScale?.startValue ?? -1,
  threePitchChordGainScale / 2,
  "Duplicate C note should combine same-pitch and three-group chord gain.",
);
assertNear(
  duplicatePlusChordOptionalDuplicateScale?.startValue ?? -1,
  threePitchChordGainScale / 2,
  "Second duplicate C note should combine same-pitch and three-group chord gain.",
);
assertNear(
  duplicatePlusChordOptionalDifferentScale?.startValue ?? -1,
  threePitchChordGainScale,
  "Different pitch in duplicate plus chord should receive only chord gain.",
);

/**
 * tuplet의 시작 음, gliss, 종료 hold가 하나의 연속 재생 체인으로 변환되는지 검증한다.
 * - 인수 : sourceText : 유효한 기본 ScoreFile JSON
 * - 반환값 : 없음. 잘못된 스케줄이면 테스트를 실패시킨다.
 */
function testTupletGlissContinuousPlayback(sourceText: string): void {
  // 1tick 미만/동일/초과 슬롯과 0이 아닌 head 좌표, 그룹 밖 hold 연결을 함께 확인한다.
  for (const groupLength of [1, 3, 4]) {
    for (const headCol of [0, 7]) {
      for (const outsideHold of [false, true]) {
        const base = loadRuntimeDocument(sourceText);
        assert(base.ok, "Tuplet playback base fixture should load.");
        if (!base.ok) continue;

        const score = base.document.score;
        for (const track of score.tracks) track.cells = [];
        const track = score.tracks.find((entry) => entry.trackId === "basic");
        assert(track !== undefined, "Tuplet playback fixture requires basic track.");
        if (track === undefined) continue;

        track.cells.push({
          rowId: "s1-note-63",
          col: headCol,
          rawText: "/3(D#4@g(a,S)@n(63)|D4@g(a,E)@n(62)|-@n(62))",
        });
        for (let offset = 1; offset < groupLength; offset += 1) {
          track.cells.push({ rowId: "s1-note-63", col: headCol + offset, rawText: "/&" });
        }
        if (outsideHold) {
          track.cells.push({ rowId: "s1-note-62", col: headCol + groupLength, rawText: "-" });
        }

        // 변경한 셀의 indexes를 다시 구성하고 실제 parser/analyzer를 통과시킨다.
        const loaded = loadRuntimeDocument(JSON.stringify(score));
        assert(loaded.ok, "Tuplet playback fixture should reload.");
        if (!loaded.ok) continue;
        const analysis = analyzeDocument({
          ...loaded.document,
          parsed: buildParsedDocument(loaded.document),
        });
        assert(analysis.analysisIssues.length === 0, "Tuplet playback fixture should analyze without issues.");
        const schedule = buildAudioSchedule({ analysis, activeTrackIds: ["basic"] });
        const chain = schedule.events[0];
        assert(schedule.events.length === 1 && chain?.sourceEventKind === "glissChain",
          "Tuplet anchor notes must be absorbed into one chain without independent reattacks.");
        if (chain?.sourceEventKind !== "glissChain") continue;

        const [start, ramp, end] = chain.segments;
        assert(chain.segments.length === 3, "Tuplet chain should contain constant pitch, ramp, and hold.");
        assert(start !== undefined && ramp !== undefined && end !== undefined, "All chain segments should exist.");
        if (start === undefined || ramp === undefined || end === undefined) continue;
        const anchorOffset = Math.min(groupLength / 6, 0.5);
        assertNear(chain.startSeconds, headCol / 8, "Chain should preserve slot onset at 120 BPM.");
        assertNear(chain.endSeconds, (headCol + groupLength + Number(outsideHold)) / 8,
          "Chain should preserve the entire end hold.");
        assertNear(start.startSeconds, chain.startSeconds, "First segment should start with chain.");
        assertNear(start.endSeconds, (headCol + anchorOffset) / 8, "Start anchor timing should remain unchanged.");
        assertNear(start.endSeconds, ramp.startSeconds, "Start-to-ramp boundary should be continuous.");
        assertNear(ramp.endSeconds, (headCol + groupLength / 3 + anchorOffset) / 8,
          "End anchor timing should remain unchanged.");
        assertNear(ramp.endSeconds, end.startSeconds, "Ramp-to-hold boundary should be continuous.");
        assertNear(end.endSeconds, chain.endSeconds, "Last segment should end with chain.");
        assert(start.startMidi === 63 && start.endMidi === 63 && ramp.startMidi === 63 &&
          ramp.endMidi === 62 && end.startMidi === 62 && end.endMidi === 62,
          "Chain should preserve D#4, descending gliss, and D4 hold pitches.");
      }
    }
  }
}

const fixtureUrl = new URL("./test_cases/minimal-valid-score.json", import.meta.url);
const jsonText = readFileSync(fixtureUrl, "utf8");
testTupletGlissContinuousPlayback(jsonText);
const loadResult = loadRuntimeDocument(jsonText);

assert(loadResult.ok, "Audio schedule fixture should load.");

if (loadResult.ok) {
  const parsed = buildParsedDocument(loadResult.document);
  const analysis = analyzeDocument({
    score: loadResult.document.score,
    indexes: loadResult.document.indexes,
    parsed,
  });
  const schedule = buildAudioSchedule({
    analysis,
    activeTrackIds: ["basic"],
  });
  const queue = createAudioEventQueue(schedule);
  const firstEvent = schedule.events[0];

  assert(schedule.events.length === 6, "Audio schedule should include 6 basic note events.");
  assertNear(schedule.durationSeconds, 125, "Fixture schedule duration should follow timing timeline.");
  assert(firstEvent !== undefined, "Audio schedule should have a first event.");
  assert(firstEvent?.sourceEventKind === "note", "First fixture event should be a note.");

  if (firstEvent?.sourceEventKind === "note") {
    assert(firstEvent.eventId.length > 0, "Audio event should keep analyzer eventId.");
    assert(firstEvent.trackId === "basic", "Audio event should keep trackId.");
    assertNear(firstEvent.startSeconds, 0, "First note should start at 0s.");
    assertNear(firstEvent.endSeconds, 0.5, "First merged 4-tick note should last 0.5s.");
    assert(firstEvent.midi === 52, "First event should keep final sound MIDI.");
  }

  assert(queue.getEventCount() === schedule.events.length, "Queue should keep all schedule events.");
  assert(queue.getEventsStartingInRange(0.125, 0.25).length === 0, "Starting lookup should not repeat an already-started long note.");
  assert(queue.getEventsOverlappingRange(0.125, 0.25).length === 1, "Overlap lookup should include an already-started long note.");
  assert(queue.getEventsStartingInRange(0.5, 0.75).length >= 1, "Starting lookup should include events after first note end.");

  const scheduledEvents: Array<{ event: AudioScheduleEvent; offsetSeconds: number }> = [];
  const backend: AudioBackend = {
    ensureStarted: () => Promise.resolve(),
    scheduleEvent: (event, offsetSeconds) => {
      scheduledEvents.push({ event, offsetSeconds });
    },
    getCurrentTime: () => 0,
    setMasterVolume: () => {},
    stopAll: () => {
      scheduledEvents.length = 0;
    },
    dispose: () => {
      scheduledEvents.length = 0;
    },
  };
  const scheduler = createAudioLookaheadScheduler({
    queue,
    backend,
    lookaheadSeconds: 0.2,
  });

  assert(
    scheduler.scheduleLookahead(0, { enabled: false }) === 1,
    "Scheduler should schedule the first event at playback start.",
  );
  assertNear(scheduledEvents[0]?.offsetSeconds ?? -1, 0, "First scheduled event should start immediately.");
  assert(
    scheduler.scheduleLookahead(0.05, { enabled: false }) === 0,
    "Scheduler should not repeat an already-started event.",
  );
  assert(
    scheduler.scheduleLookahead(0.49, { enabled: false }) >= 1,
    "Scheduler should schedule the next event when it enters lookahead.",
  );

  scheduler.resetScheduledEvents();
  scheduledEvents.length = 0;

  assert(
    scheduler.scheduleLookahead(0.25, { enabled: false }) === 1,
    "Scheduler should resume an already-started event when playback begins inside it.",
  );
  assertNear(
    scheduledEvents[0]?.offsetSeconds ?? -1,
    0,
    "Resumed overlapping event should start immediately.",
  );
  assertNear(
    scheduledEvents[0]?.event.startSeconds ?? -1,
    0.25,
    "Resumed overlapping event should be clipped to the playback start time.",
  );
  assert(
    scheduledEvents[0]?.event.eventId.endsWith(":resume") ?? false,
    "Resumed overlapping event should receive a resume event id.",
  );
  assert(
    scheduler.scheduleLookahead(0.3, { enabled: false }) === 0,
    "Scheduler should not repeatedly resume the same overlapping event.",
  );

  scheduler.resetScheduledEvents();
  scheduledEvents.length = 0;

  assert(
    scheduler.scheduleLookahead(
      0.55,
      {
        enabled: true,
        startSeconds: 0,
        endSeconds: 0.6,
      },
      0,
    ) >= 1,
    "Loop wrap lookahead should schedule the first event of the next cycle.",
  );
  assert(
    scheduledEvents.some((scheduledEvent) => Math.abs(scheduledEvent.offsetSeconds - 0.05) <= 1e-9),
    "Wrapped event should be scheduled after loop end.",
  );
  assert(
    scheduler.scheduleLookahead(
      0,
      {
        enabled: true,
        startSeconds: 0,
        endSeconds: 0.6,
      },
      1,
    ) === 0,
    "Loop cycle should not duplicate an event already scheduled from wrapped lookahead.",
  );

  scheduler.resetScheduledEvents();
  scheduledEvents.length = 0;

  assert(
    scheduler.scheduleLookahead(
      0.45,
      {
        enabled: true,
        startSeconds: 0.125,
        endSeconds: 0.5,
      },
      0,
    ) >= 1,
    "Loop scheduler should schedule wrapped next-cycle events.",
  );
  assert(
    scheduledEvents.some((scheduledEvent) =>
      scheduledEvent.event.startSeconds === 0.125 &&
      scheduledEvent.event.endSeconds <= 0.5,
    ),
    "Loop start should resume an event crossing the start boundary.",
  );
  assert(
    scheduledEvents.every((scheduledEvent) => scheduledEvent.event.endSeconds <= 0.5),
    "Loop scheduler should hard-cut events at the exclusive end boundary.",
  );

  scheduler.resetScheduledEvents();
  scheduledEvents.length = 0;

  assert(
    scheduler.scheduleLookahead(
      0.49,
      {
        enabled: true,
        startSeconds: 0,
        endSeconds: 0.5,
      },
      0,
    ) >= 1,
    "Loop end lookahead should schedule the next cycle while cutting current-cycle notes.",
  );
  assert(
    scheduledEvents.every((scheduledEvent) => scheduledEvent.event.endSeconds <= 0.5),
    "A note crossing loop end should be clipped before backend scheduling.",
  );

  let fakeAudioTime = 0;
  const controllerScheduledEvents: Array<{ event: AudioScheduleEvent; offsetSeconds: number }> = [];
  const controllerBackend: AudioBackend = {
    ensureStarted: () => Promise.resolve(),
    scheduleEvent: (event, offsetSeconds) => {
      controllerScheduledEvents.push({ event, offsetSeconds });
    },
    getCurrentTime: () => fakeAudioTime,
    setMasterVolume: () => {},
    stopAll: () => {
      controllerScheduledEvents.length = 0;
    },
    dispose: () => {
      controllerScheduledEvents.length = 0;
    },
  };
  const controller = createPlaybackController({
    schedule,
    scheduler: createAudioLookaheadScheduler({
      queue,
      backend: controllerBackend,
      lookaheadSeconds: 0.2,
    }),
    backend: controllerBackend,
    schedulerIntervalMs: 25,
  });

  await controller.playFromSeconds(0.5);
  assert(controller.getState().kind === "playing", "Controller should enter playing state.");
  assertNear(controller.getCurrentScoreSeconds(), 0.5, "playFromSeconds should set playback origin.");

  fakeAudioTime = 0.25;
  assertNear(controller.getCurrentScoreSeconds(), 0.75, "Playing controller should advance with backend time.");
  controller.pause();
  assert(controller.getState().kind === "paused", "Pause should enter paused state.");
  assertNear(controller.getCurrentScoreSeconds(), 0.75, "Pause should preserve current score time.");

  await controller.resume();
  assert(controller.getState().kind === "playing", "Resume should enter playing state.");
  assertNear(controller.getCurrentScoreSeconds(), 0.75, "Resume should restart from paused score time.");

  await controller.seekToSeconds(1.25);
  assert(controller.getState().kind === "playing", "Seek during playback should keep playing state.");
  assertNear(controller.getCurrentScoreSeconds(), 1.25, "Seek should move playing origin.");

  controller.pause();
  await controller.seekToSeconds(0.25);
  assert(controller.getState().kind === "paused", "Seek while paused should keep paused state.");
  assertNear(controller.getCurrentScoreSeconds(), 0.25, "Paused seek should update paused time.");

  controller.pauseAtSeconds(0.75);
  assert(controller.getState().kind === "paused", "pauseAtSeconds should restore paused state.");
  assertNear(controller.getCurrentScoreSeconds(), 0.75, "pauseAtSeconds should preserve requested score time.");

  controller.stop();
  assert(controller.getState().kind === "stopped", "Stop should enter stopped state.");
  assertNear(controller.getCurrentScoreSeconds(), 0, "Stop should reset score time.");

  fakeAudioTime = 0;
  await controller.playFromSeconds(
    0.6,
    {
      enabled: true,
      startSeconds: 0.25,
      endSeconds: 0.75,
    },
  );
  assertNear(controller.getCurrentScoreSeconds(), 0.6, "Loop playback should start inside the loop range.");

  fakeAudioTime = 0.2;
  assertNear(controller.getCurrentScoreSeconds(), 0.3, "Loop playback should wrap at loop end.");

  await controller.seekToSeconds(
    1.25,
    {
      enabled: true,
      startSeconds: 0.25,
      endSeconds: 0.75,
    },
  );
  assertNear(controller.getCurrentScoreSeconds(), 0.25, "Loop playback should clamp outside seek to loop start.");

  controller.stop();

  fakeAudioTime = 0;
  await controller.playFromSeconds(schedule.durationSeconds - 0.01);
  fakeAudioTime = 0.02;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(controller.getState().kind === "stopped", "Natural playback end should enter stopped state.");
  assertNear(
    controller.getCurrentScoreSeconds(),
    schedule.durationSeconds,
    "Natural playback end should preserve the score duration position.",
  );
  controller.stop();
}

// 준비 중 stop/pause/새 play/dispose가 발생하면 늦은 성공과 실패 모두 무효화한다.
for (const cancelKind of ["stop", "pause", "pauseAtSeconds", "newPlay", "dispose"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    const pending: Array<{ resolve(): void; reject(error: Error): void }> = [];
    let scheduledCount = 0;
    const backend: AudioBackend = {
      ensureStarted: () => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })),
      scheduleEvent: () => { scheduledCount += 1; },
      getCurrentTime: () => 0,
      setMasterVolume: () => {},
      stopAll: () => {},
      dispose: () => {},
    };
    const controller = createPlaybackController({
      schedule: { events: [], durationSeconds: 2 },
      scheduler: createAudioLookaheadScheduler({
        queue: createAudioEventQueue({ events: [], durationSeconds: 2 }), backend, lookaheadSeconds: 0.2,
      }),
      backend,
      schedulerIntervalMs: 25,
    });
    const oldPlay = controller.playFromSeconds(0);
    let newPlay: Promise<void> | undefined;
    if (cancelKind === "newPlay") newPlay = controller.playFromSeconds(1);
    else if (cancelKind === "pauseAtSeconds") controller.pauseAtSeconds(0.5);
    else controller[cancelKind]();
    if (outcome === "resolve") pending[0].resolve();
    else pending[0].reject(new Error("obsolete preparation failure"));
    await oldPlay;
    assert(!controller.isPlaying() && scheduledCount === 0, `${cancelKind}/${outcome}: obsolete request must not start audio.`);
    if (newPlay !== undefined) {
      pending[1].resolve();
      await newPlay;
      assert(controller.isPlaying(), "Newest play must still start.");
      assertNear(controller.getCurrentScoreSeconds(), 1, "Newest play origin must be preserved.");
    }
    controller.dispose();
  }
}

console.log("Audio timing mapper and request lifecycle tests completed.");
