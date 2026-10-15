import "./test_game_input_history";
import { createGameInputHistory } from "../src/app/game/game_input_history";
import type { CanvasScoreLayout } from "../src/renderer/canvas_types";
import { getPracticeDisplaySeconds } from "../src/app/playback/app_playback_ui";
import { normalizeGameDisplayOffsetMs } from "../src/app/game/game_types";
import type { AnalysisResult, GlissEvent, NoteEvent } from "../src/core/analyze/types";
import type { GameTimingOnsetCandidate } from "../src/app/game/game_types";
import { createTickTimeMapper, numberToTimeFraction } from "../src/audio/tick_time_mapper";
import {
  applyGameEffectBonus,
  applyGameSyncOffsetSeconds,
  applyGameScoringSample,
  collectGameJudgeTargetsAtSeconds,
  hasRemainingGameJudgeTarget,
  judgeGameScoringSample,
  normalizeGameTrackDifficulty,
} from "../src/app/game/game_judge";
import {
  collectGameEffectBonusTargets,
  type GameEffectFrame,
  type GameTremRuntimeState,
  getGlissIntervalIndexAtSeconds,
  judgeGlissIntervalBonus,
  judgeTremAttackBonus,
  judgeVibWindowBonus,
  shouldLockFailedGlissBonusTarget,
} from "../src/app/game/game_effect_judge";
import {
  DEFAULT_GAME_SYNC_OFFSET_MS,
  createEmptyGameScoreSummary,
  formatGameSyncOffsetMs,
  isGameModeTrackChangeLocked,
  isFullComboSummary,
  normalizeGameSyncOffsetMs,
} from "../src/app/game/game_types";
import {
  loadGameSyncOffsetMsFromLocalStorage,
  saveGameSyncOffsetMsToLocalStorage,
  loadGameDisplayOffsetMsFromLocalStorage,
  saveGameDisplayOffsetMsToLocalStorage,
} from "../src/infra/game_preferences";
import { createPracticeRangeStateFromApp } from "../src/app/playback/app_playback";
import {
  calculateRms,
  createFrequencyRangeFromLayout,
  frequencyToMidiPitch,
} from "../src/app/game/game_pitch_math";

/**
 * 테스트 조건이 참인지 확인한다.
 * - 인수 : condition : 통과해야 하는 조건
 * - 인수 : message : 실패 시 표시할 메시지
 * - 반환값 : 없음
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * 두 숫자가 허용 오차 안에 있는지 확인한다.
 * - 인수 : actual : 실제 계산값
 * - 인수 : expected : 기대값
 * - 인수 : epsilon : 허용 오차
 * - 인수 : message : 실패 시 표시할 메시지
 * - 반환값 : 없음
 */
function assertClose(actual: number, expected: number, epsilon: number, message: string): void {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

/**
 * nullable 값을 테스트 안에서 non-null 값으로 좁힌다.
 * - 인수 : value : null일 수 있는 값
 * - 인수 : message : null일 때 표시할 실패 메시지
 * - 반환값 : null이 아닌 값
 */
function requireValue<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }

  return value;
}

/**
 * Node 테스트 환경에서 game preference storage가 사용할 localStorage mock을 설치한다.
 * - 인수 : 없음
 * - 반환값 : mock storage map
 */
function installLocalStorageMock(): Map<string, string> {
  const storage = new Map<string, string>();

  globalThis.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => {
      storage.clear();
    },
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  } as Storage;

  return storage;
}

/**
 * 테스트용 note event를 만든다.
 * - 인수 : eventId : event 식별자
 * - 인수 : trackId : 소속 track
 * - 인수 : startTick : 시작 tick
 * - 인수 : endTick : 종료 tick
 * - 인수 : midi : 발음 MIDI note
 * - 반환값 : 최소 필드만 채운 NoteEvent
 */
function createTestNoteEvent(
  eventId: string,
  trackId: "basic" | "optional" | "extra",
  startTick: number,
  endTick: number,
  midi: number,
): NoteEvent {
  return {
    eventKind: "note",
    eventId,
    trackId,
    time: {
      startTick: numberToTimeFraction(startTick),
      endTick: numberToTimeFraction(endTick),
    },
    sourceCells: [{ rowId: `row-${midi}`, col: startTick }],
    text: "",
    displayTextAnchors: [],
    display: {
      rowId: `row-${midi}`,
      centOffset: 0,
    },
    sound: {
      midi,
      centOffset: 0,
    },
    effects: [],
    glissAnchors: [],
  };
}

/**
 * 테스트용 gliss event를 만든다.
 * - 인수 : eventId : event 식별자
 * - 인수 : startTick : 시작 anchor tick
 * - 인수 : endTick : 종료 anchor tick
 * - 인수 : startMidi : 시작 목표 MIDI
 * - 인수 : endMidi : 종료 목표 MIDI
 * - 반환값 : 최소 필드만 채운 GlissEvent
 */
function createTestGlissEvent(
  eventId: string,
  startTick: number,
  endTick: number,
  startMidi: number,
  endMidi: number,
): GlissEvent {
  return {
    eventKind: "gliss",
    eventId,
    trackId: "basic",
    time: {
      startTick: numberToTimeFraction(startTick),
      endTick: numberToTimeFraction(endTick),
    },
    sourceCells: [
      { rowId: `row-${startMidi}`, col: startTick },
      { rowId: `row-${endMidi}`, col: endTick },
    ],
    startDisplay: {
      rowId: `row-${startMidi}`,
      centOffset: 0,
    },
    endDisplay: {
      rowId: `row-${endMidi}`,
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
    glissId: "g",
    startAnchorTick: numberToTimeFraction(startTick),
    endAnchorTick: numberToTimeFraction(endTick),
    fromKind: "start",
    toKind: "end",
    startAttach: "attack",
    endAttach: "release",
  };
}

const a4 = requireValue(frequencyToMidiPitch(440), "A4 should produce a MIDI pitch.");

assert(a4.midi === 69, "A4 should be MIDI 69.");
assertClose(a4.centOffset, 0, 1e-9, "A4 cent offset should be zero.");

const a4SharpQuarter = requireValue(
  frequencyToMidiPitch(440 * 2 ** (50 / 1200)),
  "A4 + 50 cent should produce a MIDI pitch.",
);

assert(a4SharpQuarter.midi === 69 || a4SharpQuarter.midi === 70, "A4 + 50 cent should round near MIDI 69/70.");

const rms = calculateRms(new Float32Array([1, -1, 1, -1]));

assertClose(rms, 1, 1e-9, "Full-scale alternating samples should have RMS 1.");

assert(
  DEFAULT_GAME_SYNC_OFFSET_MS === 90,
  "Default practice Sync should start at +90 ms.",
);
assert(
  normalizeGameSyncOffsetMs(96) === 96,
  "Sync offset should preserve 1 ms steps.",
);
assert(
  normalizeGameSyncOffsetMs(500) === 500,
  "Sync offset should allow +500 ms.",
);
assert(
  normalizeGameSyncOffsetMs(-500) === -500,
  "Sync offset should allow -500 ms.",
);
assert(
  formatGameSyncOffsetMs(90) === "+90 ms",
  "Sync offset formatter should include a plus sign for positive values.",
);
assertClose(
  applyGameSyncOffsetSeconds(1.5, 90),
  1.41,
  1e-9,
  "Positive Sync should delay practice judge timing.",
);
assertClose(
  applyGameSyncOffsetSeconds(1.5, -40),
  1.54,
  1e-9,
  "Negative Sync should advance practice judge timing.",
);
assertClose(
  applyGameSyncOffsetSeconds(0.03, 90),
  0,
  1e-9,
  "Sync-adjusted score time should not go below zero.",
);

const preferenceStorage = installLocalStorageMock();

assert(
  loadGameSyncOffsetMsFromLocalStorage() === DEFAULT_GAME_SYNC_OFFSET_MS,
  "Missing Sync preference should load the default value.",
);
assert(
  saveGameSyncOffsetMsToLocalStorage(96) === 96 &&
    loadGameSyncOffsetMsFromLocalStorage() === 96,
  "Sync preference should save and load a normalized value.",
);

preferenceStorage.set("regression-code:game-sync-offset-ms", "999");

assert(
  loadGameSyncOffsetMsFromLocalStorage() === 500,
  "Out-of-range stored Sync preference should be clamped on load.",
);

preferenceStorage.set("regression-code:game-sync-offset-ms", "not-a-number");

assert(
  loadGameSyncOffsetMsFromLocalStorage() === DEFAULT_GAME_SYNC_OFFSET_MS,
  "Invalid stored Sync preference should fall back to the default value.",
);

const layout: CanvasScoreLayout = {
  rows: [
    { rowId: "n60", kind: "note", label: "C4", midi: 60, y: 0, height: 10 },
    { rowId: "n72", kind: "note", label: "C5", midi: 72, y: 10, height: 10 },
  ],
  columnCount: 4,
  columnWidth: 20,
  scoreContentWidth: 80,
  stageWidth: 80,
  stageHeight: 20,
  layoutWidth: 120,
  layoutLabelWidth: 100,
  layoutLeftPaddingWidth: 0,
  layoutRightPaddingWidth: 0,
  layoutPlaybackBoundaryX: 0,
  layoutFontSize: 12,
};
const range = createFrequencyRangeFromLayout(layout);

assert(range.minFrequencyHz < 261.63, "Frequency range should allow one octave below the lowest note row.");
assert(range.maxFrequencyHz > 523.25, "Frequency range should allow one octave above the highest note row.");

const emptySummary = createEmptyGameScoreSummary();

assert(
  !isGameModeTrackChangeLocked({ kind: "off" }),
  "Track change should be allowed when game mode is off.",
);
assert(
  !isGameModeTrackChangeLocked({ kind: "ready", summary: emptySummary, pitchFrame: null }),
  "Track change should be allowed while practice mode is ready/stopped.",
);
assert(
  isGameModeTrackChangeLocked({ kind: "playing", summary: emptySummary, pitchFrame: null }),
  "Track change should be locked during practice playback.",
);
assert(
  isGameModeTrackChangeLocked({ kind: "paused", summary: emptySummary, pitchFrame: null }),
  "Track change should be locked while practice playback is paused.",
);

const analysis: AnalysisResult = {
  timingTimeline: [{
    time: {
      startTick: numberToTimeFraction(0),
      endTick: numberToTimeFraction(8),
    },
    startBpm: 120,
    endBpm: 120,
    bpmCurve: "instant",
    beatsPerBar: 4,
    stepsPerBeat: 4,
    sourceCells: [],
  }],
  dynamicsTimeline: [],
  trackResults: [
    {
      trackId: "basic",
      events: [
        createTestNoteEvent("basic-c4", "basic", 0, 4, 60),
      ],
    },
    {
      trackId: "optional",
      events: [
        createTestNoteEvent("optional-d4", "optional", 0, 4, 62),
      ],
    },
    {
      trackId: "extra",
      events: [],
    },
  ],
  analysisIssues: [],
};
const mapper = createTickTimeMapper(analysis.timingTimeline);
const practiceRangeRuntime = {
  timeMapper: mapper,
};
const disabledPracticeRange = createPracticeRangeStateFromApp(
  {
    loop: {
      enabled: false,
      startTick: 1,
      endTick: 3,
      pickMode: null,
    },
    renderInput: {
      columnCount: 8,
    },
  } as never,
  practiceRangeRuntime as never,
);
const enabledPracticeRange = createPracticeRangeStateFromApp(
  {
    loop: {
      enabled: true,
      startTick: 1,
      endTick: 3,
      pickMode: null,
    },
    renderInput: {
      columnCount: 8,
    },
  } as never,
  practiceRangeRuntime as never,
);
const invalidPracticeRange = createPracticeRangeStateFromApp(
  {
    loop: {
      enabled: true,
      startTick: 4,
      endTick: 2,
      pickMode: null,
    },
    renderInput: {
      columnCount: 8,
    },
  } as never,
  practiceRangeRuntime as never,
);

assert(disabledPracticeRange.enabled === false, "Practice range should be disabled when Loop UI is off.");
assert(invalidPracticeRange.enabled === false, "Practice range should be disabled for an inverted range.");
assert(enabledPracticeRange.enabled === true, "Practice range should be enabled for a valid Loop UI range.");
if (enabledPracticeRange.enabled) {
  assertClose(enabledPracticeRange.startSeconds, 0.125, 1e-9, "Practice range should start at the selected start tick.");
  assertClose(enabledPracticeRange.endSeconds, 0.375, 1e-9, "Practice range should end at the selected end tick.");
}

const targetsAtStart = collectGameJudgeTargetsAtSeconds(
  analysis,
  ["basic", "optional"],
  mapper,
  0.1,
);

assert(targetsAtStart.length === 2, "Judge target lookup should include active track note events.");
assert(
  hasRemainingGameJudgeTarget(analysis, ["basic"], mapper, 0.1),
  "Practice finish check should detect remaining active note targets.",
);
assert(
  !hasRemainingGameJudgeTarget(analysis, ["basic"], mapper, 2),
  "Practice finish check should stop after all active note targets end.",
);

const transitionAnalysis: AnalysisResult = {
  timingTimeline: analysis.timingTimeline,
  dynamicsTimeline: [],
  trackResults: [
    {
      trackId: "basic",
      events: [
        createTestNoteEvent("transition-c4", "basic", 0, 4, 60),
        createTestNoteEvent("transition-d4", "basic", 4, 8, 62),
      ],
    },
    {
      trackId: "optional",
      events: [],
    },
    {
      trackId: "extra",
      events: [],
    },
  ],
  analysisIssues: [],
};
const transitionMapper = createTickTimeMapper(transitionAnalysis.timingTimeline);
const transitionTargetsInGrace = collectGameJudgeTargetsAtSeconds(
  transitionAnalysis,
  ["basic"],
  transitionMapper,
  0.6,
);
const transitionTargetsBeforeNextStart = collectGameJudgeTargetsAtSeconds(
  transitionAnalysis,
  ["basic"],
  transitionMapper,
  0.4,
);
const transitionTargetsAfterGrace = collectGameJudgeTargetsAtSeconds(
  transitionAnalysis,
  ["basic"],
  transitionMapper,
  0.63,
);

assert(
  transitionTargetsInGrace.some((target) => target.eventId === "transition-c4") &&
    transitionTargetsInGrace.some((target) => target.eventId === "transition-d4"),
  "Adjacent note transition should keep the previous note target briefly after its end.",
);
assert(
  transitionTargetsBeforeNextStart.some((target) => target.eventId === "transition-c4") &&
    transitionTargetsBeforeNextStart.some((target) => target.eventId === "transition-d4"),
  "Adjacent note transition should include the next note briefly before its start.",
);
assert(
  !transitionTargetsAfterGrace.some((target) => target.eventId === "transition-c4") &&
    transitionTargetsAfterGrace.some((target) => target.eventId === "transition-d4"),
  "Previous note transition grace should expire after the short release window.",
);

const difficulty = normalizeGameTrackDifficulty({
  basic: 0,
  optional: 2,
  extra: Number.NaN,
});

assertClose(difficulty.basic, 1, 1e-9, "Basic difficulty should fall back when score difficulty is 0.");
assertClose(difficulty.optional, 2, 1e-9, "Optional difficulty should use a positive score difficulty.");
assertClose(difficulty.extra, 3, 1e-9, "Extra difficulty should fall back when score difficulty is invalid.");

const perfectSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 523.25,
    frequencyHz: 523.25,
    midi: 72,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  targetsAtStart,
  0.1,
  difficulty,
);

assert(perfectSample !== null, "Voiced pitch and active target should create a scoring sample.");
assert(perfectSample?.label === "Perfect", "Same pitch class in another octave should be Perfect.");
assert(perfectSample?.trackId === "basic", "C input should select the C target instead of the D target.");

for (const octaveOffset of [-24, -12, 0, 12, 24]) {
  const octaveShiftedSample = judgeGameScoringSample(
    {
      capturedAtMs: 0,
      rawFrequencyHz: 261.63 * 2 ** (octaveOffset / 12),
      frequencyHz: 261.63 * 2 ** (octaveOffset / 12),
      midi: 60 + octaveOffset,
      centOffset: 0,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
    [{
      eventId: "basic-c4",
      trackId: "basic",
      startSeconds: 0,
      endSeconds: 1,
      targetMidi: 60,
      targetCentOffset: 0,
      attackRequired: true,
    }],
    0.1,
    difficulty,
  );

  assert(
    octaveShiftedSample?.label === "Perfect",
    `Pitch-class scoring should treat C${octaveOffset / 12} octave shift as Perfect.`,
  );
}

const firstFrameWrongOctaveSample = judgeGameScoringSample(
  {
    capturedAtMs: 1000,
    rawFrequencyHz: 1046.5,
    frequencyHz: 1046.5,
    midi: 84,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-c4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 60,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.1,
  difficulty,
);

assert(
  firstFrameWrongOctaveSample?.label === "Perfect",
  "Pitch-class scoring should accept a two-octave C input for a C target without changing the raw pitch.",
);

const timingTarget = [{
  eventId: "basic-c4",
  trackId: "basic" as const,
  startSeconds: 1,
  endSeconds: 2,
  targetMidi: 60,
  targetCentOffset: 0,
  attackRequired: true,
}];
const createTimingOnset = (id: number, scoreSeconds: number): GameTimingOnsetCandidate => ({
  id,
  scoreSeconds,
  midi: 60,
  centOffset: 0,
});
const createPerfectTimingFrame = (capturedAtMs: number) => ({
  capturedAtMs,
  rawFrequencyHz: 261.63,
  frequencyHz: 261.63,
  midi: 60,
  centOffset: 0,
  clarity: 1,
  rms: 0.1,
  isVoiced: true,
  rejectReason: null,
});
const onTimeSample = judgeGameScoringSample(
  createPerfectTimingFrame(1010),
  timingTarget,
  1.01,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(1, 1.03)],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
);
const earlySample = judgeGameScoringSample(
  createPerfectTimingFrame(1020),
  timingTarget,
  1.02,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(2, 0.88)],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
);
const lateSample = judgeGameScoringSample(
  createPerfectTimingFrame(1030),
  timingTarget,
  1.13,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(3, 1.13)],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
);
const timingBadSample = judgeGameScoringSample(
  createPerfectTimingFrame(1035),
  timingTarget,
  1.18,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(5, 1.18)],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
);
const timingMissSample = judgeGameScoringSample(
  createPerfectTimingFrame(1040),
  timingTarget,
  1.3,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(4, 1.3)],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
);

assert(onTimeSample?.label === "Perfect", "On-time pitch should keep the pitch judge label.");
assert(onTimeSample?.timing.kind === "none", "Timing under 80 ms should not show early or late text.");
assert(onTimeSample?.timingOnsetId === 1, "On-time timing should consume the matched onset.");
assert(earlySample?.label === "Perfect", "Early timing under 150 ms should keep the pitch judge label.");
assert(earlySample?.timing.kind === "early", "Timing before the target should show early.");
assert(lateSample?.label === "Perfect", "Late timing under 150 ms should keep the pitch judge label.");
assert(lateSample?.timing.kind === "late", "Timing after the target should show late.");
assert(timingBadSample?.label === "Bad", "Timing 150-249 ms away should downgrade the final label to Bad.");
assert(timingBadSample?.timing.kind === "bad", "Timing bad should keep direction data for the overlay.");
assertClose(timingBadSample?.pitchAccuracy ?? -1, 1 / 3, 1e-9, "Timing Bad should force one-third accuracy.");
assert(timingMissSample?.label === "Miss", "Timing 250 ms or more away should downgrade the final label to Miss.");
assertClose(timingMissSample?.pitchAccuracy ?? -1, 0, 1e-9, "Timing Miss should force 0% accuracy.");
assertClose(timingMissSample?.scoreContribution ?? -1, 0, 1e-9, "Timing Miss should force zero score.");

const missingAttackSample = judgeGameScoringSample(
  createPerfectTimingFrame(1200),
  timingTarget,
  1.2,
  difficulty,
  {
    onsetCandidates: [],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
);

assert(
  missingAttackSample?.label === "Perfect",
  "Missing attack should keep the pitch feedback label.",
);
assert(
  missingAttackSample?.scoreEligible === false,
  "Attack-required note without onset should block score eligibility.",
);
assert(
  missingAttackSample?.scoreBlockedReason === "attackRequired",
  "Missing attack should report the attackRequired block reason.",
);
assertClose(
  missingAttackSample?.scoreContribution ?? -1,
  0,
  1e-9,
  "Attack-required note without onset should not add score.",
);

const easyMissingAttackSample = judgeGameScoringSample(
  createPerfectTimingFrame(1200),
  timingTarget,
  1.2,
  difficulty,
  {
    onsetCandidates: [],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
  "easy",
);

assert(
  easyMissingAttackSample?.scoreEligible === true,
  "Easy Mode should score pitch-only samples even when the attack is missing.",
);
assert(
  easyMissingAttackSample?.scoreBlockedReason === null,
  "Easy Mode should not report attackRequired for pitch-only scoring.",
);
assertClose(
  easyMissingAttackSample?.scoreContribution ?? -1,
  1,
  1e-9,
  "Easy Mode missing-attack Perfect should add pitch score.",
);

const easyLateAttackSample = judgeGameScoringSample(
  createPerfectTimingFrame(1300),
  timingTarget,
  1.3,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(10, 1.3)],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
  "easy",
);

assert(
  easyLateAttackSample?.label === "Perfect",
  "Easy Mode should ignore timing downgrade and keep the pitch-only label.",
);
assert(
  easyLateAttackSample?.timing.kind === "none",
  "Easy Mode should not create timing judge results.",
);

const attackSatisfiedSustainSample = judgeGameScoringSample(
  createPerfectTimingFrame(1300),
  timingTarget,
  1.3,
  difficulty,
  {
    onsetCandidates: [],
    judgedEventIds: new Set(["basic-c4"]),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(["basic-c4"]),
  },
);

assert(
  attackSatisfiedSustainSample?.scoreEligible === true,
  "A note that already received attack credit should keep scoring during sustain.",
);

const glissEndLegatoSample = judgeGameScoringSample(
  createPerfectTimingFrame(1400),
  [{
    ...timingTarget[0],
    eventId: "basic-gliss-end-c4",
    attackRequired: false,
  }],
  1.4,
  difficulty,
  {
    onsetCandidates: [],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
);

assert(
  glissEndLegatoSample?.scoreEligible === true,
  "Legato gliss destination targets should not be blocked only because no onset was detected.",
);

const glissEndAdjacentSamePitchSample = judgeGameScoringSample(
  {
    capturedAtMs: 1450,
    rawFrequencyHz: 369.99,
    frequencyHz: 369.99,
    midi: 66,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [
    {
      eventId: "basic-gliss-end-fs4",
      trackId: "basic",
      startSeconds: 1,
      endSeconds: 1.5,
      targetMidi: 66,
      targetCentOffset: 0,
      attackRequired: false,
    },
    {
      eventId: "basic-adjacent-fs4",
      trackId: "basic",
      startSeconds: 1.5,
      endSeconds: 2,
      targetMidi: 66,
      targetCentOffset: 0,
      attackRequired: true,
    },
  ],
  1.52,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(31, 1.51)],
    judgedEventIds: new Set(["basic-gliss-end-fs4"]),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(["basic-gliss-end-fs4"]),
  },
);

assert(
  glissEndAdjacentSamePitchSample?.targetEventId === "basic-adjacent-fs4",
  "Same-pitch gliss end grace should not steal the adjacent active note target.",
);
assert(
  glissEndAdjacentSamePitchSample?.scoreEligible === true,
  "Adjacent same-pitch note after gliss should use its onset credit and score normally.",
);

const glissEndAdjacentSamePitchEarlyAttackSample = judgeGameScoringSample(
  {
    capturedAtMs: 1440,
    rawFrequencyHz: 369.99,
    frequencyHz: 369.99,
    midi: 66,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [
    {
      eventId: "basic-gliss-end-fs4",
      trackId: "basic",
      startSeconds: 1,
      endSeconds: 1.5,
      targetMidi: 66,
      targetCentOffset: 0,
      attackRequired: false,
    },
    {
      eventId: "basic-adjacent-fs4",
      trackId: "basic",
      startSeconds: 1.5,
      endSeconds: 2,
      targetMidi: 66,
      targetCentOffset: 0,
      attackRequired: true,
    },
  ],
  1.44,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(32, 1.44)],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
);

assert(
  glissEndAdjacentSamePitchEarlyAttackSample?.targetEventId === "basic-adjacent-fs4",
  "Early attack for an adjacent same-pitch note after gliss should select the next note target.",
);
assert(
  glissEndAdjacentSamePitchEarlyAttackSample?.label === "Perfect" &&
    glissEndAdjacentSamePitchEarlyAttackSample.timing.kind === "none",
  "Slightly early attack for an adjacent same-pitch note after gliss should keep Perfect instead of becoming Miss.",
);

const rawJumpSample = judgeGameScoringSample(
  {
    capturedAtMs: 1100,
    rawFrequencyHz: 587.33,
    frequencyHz: 587.33,
    midi: 74,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-c4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 60,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.2,
  difficulty,
);

assert(rawJumpSample?.label === "Miss", "Raw scoring should treat an unrelated detector jump as Miss.");

const lateReleaseSample = judgeGameScoringSample(
  {
    capturedAtMs: 1300,
    rawFrequencyHz: 261.63,
    frequencyHz: 261.63,
    midi: 60,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  transitionTargetsInGrace,
  0.6,
  difficulty,
);

assert(
  lateReleaseSample?.label === "Perfect" &&
    lateReleaseSample.targetEventId === "transition-c4",
  "Late release during a note transition should match the previous note instead of creating a Miss on the next note.",
);

const expiredLateReleaseSample = judgeGameScoringSample(
  {
    capturedAtMs: 1400,
    rawFrequencyHz: 261.63,
    frequencyHz: 261.63,
    midi: 60,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  transitionTargetsAfterGrace,
  0.63,
  difficulty,
);

assert(
  expiredLateReleaseSample?.label === "Miss",
  "Late release should become a Miss after the previous note grace window expires.",
);

const earlyAttackSample = judgeGameScoringSample(
  {
    capturedAtMs: 1200,
    rawFrequencyHz: 293.66,
    frequencyHz: 293.66,
    midi: 62,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  transitionTargetsBeforeNextStart,
  0.4,
  difficulty,
);

assert(
  earlyAttackSample?.label === "Perfect" &&
    earlyAttackSample.targetEventId === "transition-d4",
  "Early attack during a note transition should match the next note instead of creating a Miss on the previous note.",
);

const rawShortJumpSample = judgeGameScoringSample(
  {
    capturedAtMs: 1100,
    rawFrequencyHz: 587.33,
    frequencyHz: 587.33,
    midi: 74,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-c4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 60,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.2,
  difficulty,
);

assert(
  rawShortJumpSample?.label === "Miss",
  "Raw scoring should keep an unrelated detector jump as Miss without time-based hold.",
);

const harmonicRawSample = judgeGameScoringSample(
  {
    capturedAtMs: 1200,
    rawFrequencyHz: 987.77,
    frequencyHz: 987.77,
    midi: 83,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-e4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 64,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.3,
  difficulty,
);

assert(
  harmonicRawSample?.label === "Miss",
  "Raw scoring should treat an overtone-like high pitch as Miss without target-based adjustment.",
);

const rawExpiredJumpSample = judgeGameScoringSample(
  {
    capturedAtMs: 1600,
    rawFrequencyHz: 587.33,
    frequencyHz: 587.33,
    midi: 74,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-c4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 60,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.7,
  difficulty,
);

assert(
  rawExpiredJumpSample?.label === "Miss",
  "Raw scoring should keep an unrelated pitch as Miss without retained pitch state.",
);

const missSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 369.99,
    frequencyHz: 369.99,
    midi: 66,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-c4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 60,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.1,
  difficulty,
);

assert(missSample?.label === "Miss", "A far voiced pitch should create a Miss sample.");
assertClose(missSample?.scoreContribution ?? -1, 0, 1e-9, "Miss should not reduce or add score.");

const okSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 537.13,
    frequencyHz: 537.13,
    midi: 72,
    centOffset: 60,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-c4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 60,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.1,
  difficulty,
);

assert(okSample?.label === "Ok", "A 60 cent pitch error should create an Ok sample.");
assertClose(okSample?.scoreContribution ?? -1, 2 / 3, 1e-9, "Ok should contribute two-thirds accuracy.");

const proOkSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 533.44,
    frequencyHz: 533.44,
    midi: 72,
    centOffset: 40,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-c4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 60,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.1,
  difficulty,
  undefined,
  "pro",
);
const proMissSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 553.37,
    frequencyHz: 553.37,
    midi: 73,
    centOffset: 0,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  [{
    eventId: "basic-c4",
    trackId: "basic",
    startSeconds: 0,
    endSeconds: 1,
    targetMidi: 60,
    targetCentOffset: 0,
    attackRequired: true,
  }],
  0.1,
  difficulty,
  undefined,
  "pro",
);
const proTimingBadSample = judgeGameScoringSample(
  createPerfectTimingFrame(1060),
  timingTarget,
  1.12,
  difficulty,
  {
    onsetCandidates: [createTimingOnset(6, 1.12)],
    judgedEventIds: new Set(),
    consumedOnsetIds: new Set(),
    attackSatisfiedEventIds: new Set(),
  },
  "pro",
);

assert(proOkSample?.label === "Ok", "Pro Mode should classify 40 cent pitch error as Ok.");
assert(proMissSample?.label === "Miss", "Pro Mode should classify 100 cent or more as Miss.");
assert(proTimingBadSample?.label === "Bad", "Pro Mode should downgrade 100-149 ms timing offset to Bad.");

const silentSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: null,
    frequencyHz: null,
    midi: null,
    centOffset: null,
    clarity: 0,
    rms: 0,
    isVoiced: false,
    rejectReason: "invalid frequency",
  },
  targetsAtStart,
  0.1,
  difficulty,
);

assert(silentSample === null, "Silence should not create a Miss sample.");

const summaryAfterPerfect = perfectSample === null
  ? emptySummary
  : applyGameScoringSample(emptySummary, perfectSample);
const summaryAfterMiss = missSample === null
  ? summaryAfterPerfect
  : applyGameScoringSample(summaryAfterPerfect, missSample);
const summaryAfterTimingBad = timingBadSample === null
  ? emptySummary
  : applyGameScoringSample(emptySummary, timingBadSample);
const proSummaryAfterTimingBad = proTimingBadSample === null
  ? emptySummary
  : applyGameScoringSample(summaryAfterPerfect, proTimingBadSample, "pro");
const summaryAfterMissingAttack = missingAttackSample === null
  ? emptySummary
  : applyGameScoringSample(emptySummary, missingAttackSample);

assert(summaryAfterPerfect.perfectCount === 1, "Perfect sample should increment Perfect count.");
assert(summaryAfterPerfect.bestCombo === 1, "Perfect sample should increment combo.");
assert(isFullComboSummary(summaryAfterPerfect), "A single judged Perfect sample should count as Full Combo.");
assert(summaryAfterMiss.missCount === 1, "Miss sample should increment Miss count.");
assert(summaryAfterMiss.currentCombo === 0, "Miss sample should reset current combo.");
assert(!isFullComboSummary(summaryAfterMiss), "A judged Miss should prevent Full Combo.");
assertClose(
  summaryAfterMiss.accuracyPercent,
  50,
  1e-9,
  "Miss sample should count as 0% in the total average accuracy.",
);
assert(summaryAfterTimingBad.timingBadCount === 1, "Timing Bad should increment the timing bad count.");
assert(summaryAfterTimingBad.currentCombo === 1, "Score-eligible Bad should continue combo.");
assert(proSummaryAfterTimingBad.currentCombo === 0, "Pro Mode Bad should reset combo.");
assert(isFullComboSummary(summaryAfterTimingBad), "Standard Mode Bad should still count as Full Combo when combo continues.");
assert(!isFullComboSummary(proSummaryAfterTimingBad), "Pro Mode Bad should prevent Full Combo because combo resets.");
assertClose(
  summaryAfterTimingBad.timingAccuracyPercent,
  100 / 3,
  1e-9,
  "Timing Bad should count as one-third timing accuracy.",
);
assert(
  summaryAfterMissingAttack.perfectCount === 0,
  "Score-ineligible Perfect samples should not count as visible pitch feedback samples.",
);
assertClose(
  summaryAfterMissingAttack.score,
  0,
  1e-9,
  "Score-ineligible Perfect samples should not add score.",
);
assert(
  summaryAfterMissingAttack.currentCombo === 0,
  "Score-ineligible Perfect samples should not increase combo.",
);

const glissAnalysis: AnalysisResult = {
  timingTimeline: analysis.timingTimeline,
  dynamicsTimeline: [],
  trackResults: [
    {
      trackId: "basic",
      events: [
        createTestGlissEvent("basic-gliss-c-d", 0, 4, 60, 62),
      ],
    },
    {
      trackId: "optional",
      events: [
        createTestGlissEvent("optional-gliss-e-f", 0, 4, 64, 65),
      ],
    },
    {
      trackId: "extra",
      events: [],
    },
  ],
  analysisIssues: [],
};
const glissTargets = collectGameEffectBonusTargets(
  glissAnalysis,
  ["basic"],
  createTickTimeMapper(glissAnalysis.timingTimeline),
);
const glissTarget = glissTargets[0];

assert(glissTargets.length === 1, "Effect target collection should include only active track gliss events.");
assert(glissTarget !== undefined, "Gliss target should be collected.");
assert(glissTarget?.kind === "gliss", "Collected gliss effect should create a gliss bonus target.");

if (glissTarget !== undefined && glissTarget.kind === "gliss") {
  const createGlissFrame = (
    scoreSeconds: number,
    isVoiced: boolean,
  ): GameEffectFrame => ({
    scoreSeconds,
    frame: {
      capturedAtMs: scoreSeconds * 1000,
      rawFrequencyHz: isVoiced ? 440 : null,
      frequencyHz: isVoiced ? 440 : null,
      midi: isVoiced ? 61 : null,
      centOffset: isVoiced ? 0 : null,
      clarity: isVoiced ? 1 : 0,
      rms: isVoiced ? 0.1 : 0,
      isVoiced,
      rejectReason: isVoiced ? null : "low rms",
    },
  });
  const glissIntervalIndex = getGlissIntervalIndexAtSeconds(glissTarget, 0.26);
  const glissBonus = glissIntervalIndex === null
    ? null
    : judgeGlissIntervalBonus(
    glissTarget,
    {
      capturedAtMs: 260,
      rawFrequencyHz: 440,
      frequencyHz: 440,
      midi: 61,
      centOffset: 0,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
    0.26,
    glissIntervalIndex,
    difficulty,
    [
      createGlissFrame(0.251, true),
      createGlissFrame(0.26, true),
    ],
  );

  assert(glissIntervalIndex === 1, "Gliss interval index should advance by the fixed interval.");
  assert(glissBonus !== null, "Voiced pitch inside a gliss interval should create Gliss bonus.");
  assert(glissBonus?.displayText === "Gliss!", "Gliss bonus should use the Gliss! display text.");
  assert(
    glissBonus !== null &&
      glissBonus.targetMidi >= 60 &&
      glissBonus.targetMidi <= 62,
    "Gliss bonus overlay should use the target gliss pitch instead of the detected input octave.",
  );

  const summaryAfterGliss = glissBonus === null
    ? emptySummary
    : applyGameEffectBonus(emptySummary, glissBonus);

  assert(summaryAfterGliss.glissBonusCount === 1, "Gliss bonus should increment gliss count.");
  assert(summaryAfterGliss.vibBonusCount === 0, "Gliss bonus should not increment vib count.");
  assertClose(summaryAfterGliss.effectBonusScore, 2.5, 1e-9, "Gliss interval bonus should add effect bonus score.");
  assertClose(summaryAfterGliss.score, 2.5, 1e-9, "Gliss interval bonus should add to total score.");

  const failedGlissBonus = judgeGlissIntervalBonus(
    glissTarget,
    {
      capturedAtMs: 260,
      rawFrequencyHz: null,
      frequencyHz: null,
      midi: null,
      centOffset: null,
      clarity: 0,
      rms: 0,
      isVoiced: false,
      rejectReason: "low rms",
    },
    0.26,
    1,
    difficulty,
  );

  assert(failedGlissBonus === null, "Unvoiced frame should not create Gliss interval bonus.");

  const wrongPitchGlissBonus = judgeGlissIntervalBonus(
    glissTarget,
    {
      capturedAtMs: 260,
      rawFrequencyHz: 329.63,
      frequencyHz: 329.63,
      midi: 64,
      centOffset: 0,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
    0.26,
    1,
    difficulty,
    [
      createGlissFrame(0.251, true),
      createGlissFrame(0.26, true),
    ],
  );

  assert(wrongPitchGlissBonus === null, "Wrong pitch inside a gliss interval should not create Gliss bonus.");

  const interruptedGlissBonus = judgeGlissIntervalBonus(
    glissTarget,
    {
      capturedAtMs: 330,
      rawFrequencyHz: 440,
      frequencyHz: 440,
      midi: 61,
      centOffset: 0,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
    0.33,
    1,
    difficulty,
    [
      createGlissFrame(0.251, true),
      createGlissFrame(0.29, false),
      createGlissFrame(0.33, true),
    ],
  );

  assert(interruptedGlissBonus === null, "Interrupted gliss interval should not create Gliss bonus.");
  assert(
    shouldLockFailedGlissBonusTarget(
      glissTarget,
      {
        capturedAtMs: 330,
        rawFrequencyHz: 440,
        frequencyHz: 440,
        midi: 61,
        centOffset: 0,
        clarity: 1,
        rms: 0.1,
        isVoiced: true,
        rejectReason: null,
      },
      0.33,
      1,
      [
        createGlissFrame(0.251, true),
        createGlissFrame(0.29, false),
        createGlissFrame(0.33, true),
      ],
    ),
    "Interrupted gliss should lock the whole gliss target from later bonus success.",
  );

  const octaveShiftedGlissBonus = judgeGlissIntervalBonus(
    glissTarget,
    {
      capturedAtMs: 260,
      rawFrequencyHz: 880,
      frequencyHz: 880,
      midi: 73,
      centOffset: 0,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
    0.26,
    1,
    difficulty,
    [
      createGlissFrame(0.251, true),
      createGlissFrame(0.26, true),
    ],
  );

  assert(
    octaveShiftedGlissBonus !== null &&
      octaveShiftedGlissBonus.targetMidi >= 60 &&
      octaveShiftedGlissBonus.targetMidi <= 62,
    "Octave-shifted gliss input should still display the bonus near the score target note.",
  );

  const shortGlissTarget = {
    ...glissTarget,
    targetId: "basic-short-gliss-c-d",
    startSeconds: 0,
    endSeconds: 0.25,
  };
  const lateShortGlissIndex = getGlissIntervalIndexAtSeconds(shortGlissTarget, 0.36);
  const lateShortGlissBonus = lateShortGlissIndex === null
    ? null
    : judgeGlissIntervalBonus(
      shortGlissTarget,
      {
        capturedAtMs: 360,
        rawFrequencyHz: 293.66,
        frequencyHz: 293.66,
        midi: 62,
        centOffset: 0,
        clarity: 1,
        rms: 0.1,
        isVoiced: true,
        rejectReason: null,
      },
      0.36,
      lateShortGlissIndex,
      difficulty,
      [
        createGlissFrame(0.25, true),
        createGlissFrame(0.36, true),
      ],
    );

  assert(
    lateShortGlissIndex === 0,
    "Short gliss grace should clamp late scoring to the final gliss interval.",
  );
  assert(
    lateShortGlissBonus !== null,
    "Short gliss should accept a voiced frame inside the post-gliss grace window.",
  );
}

const vibNote = createTestNoteEvent("basic-vib-c4", "basic", 0, 8, 60);
vibNote.effects = [{
  time: {
    startTick: numberToTimeFraction(0),
    endTick: numberToTimeFraction(8),
  },
  vib: true,
  trem: null,
}];

const optionalVibNote = createTestNoteEvent("optional-vib-d4", "optional", 0, 8, 62);
optionalVibNote.effects = [{
  time: {
    startTick: numberToTimeFraction(0),
    endTick: numberToTimeFraction(8),
  },
  vib: true,
  trem: null,
}];

const vibAnalysis: AnalysisResult = {
  timingTimeline: analysis.timingTimeline,
  dynamicsTimeline: [],
  trackResults: [
    {
      trackId: "basic",
      events: [vibNote],
    },
    {
      trackId: "optional",
      events: [optionalVibNote],
    },
    {
      trackId: "extra",
      events: [],
    },
  ],
  analysisIssues: [],
};
const vibTargets = collectGameEffectBonusTargets(
  vibAnalysis,
  ["basic"],
  createTickTimeMapper(vibAnalysis.timingTimeline),
);
const vibTarget = vibTargets[0];

assert(vibTargets.length === 1, "Effect target collection should include only active track vib segments.");
assert(vibTarget?.kind === "vib", "Collected vibrato effect should create a vib bonus target.");

if (vibTarget !== undefined && vibTarget.kind === "vib") {
  const createVibFrame = (scoreSeconds: number, centOffset: number): GameEffectFrame => ({
    scoreSeconds,
    frame: {
      capturedAtMs: scoreSeconds * 1000,
      rawFrequencyHz: 261.63,
      frequencyHz: 261.63,
      midi: 60,
      centOffset,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
  });
  const vibFrames = [
    createVibFrame(0.1, -35),
    createVibFrame(0.2, 32),
    createVibFrame(0.3, -30),
    createVibFrame(0.4, 35),
    createVibFrame(0.5, -32),
    createVibFrame(0.6, 30),
  ];
  const vibBonus = judgeVibWindowBonus(
    vibTarget,
    vibFrames,
    0.6,
    difficulty,
  );
  const flatFrames = [
    createVibFrame(0.1, 4),
    createVibFrame(0.2, 5),
    createVibFrame(0.3, 4),
    createVibFrame(0.4, 5),
    createVibFrame(0.5, 4),
    createVibFrame(0.6, 5),
  ];
  const flatBonus = judgeVibWindowBonus(
    vibTarget,
    flatFrames,
    0.6,
    difficulty,
  );
  const subtleVibFrames = [
    createVibFrame(0.1, -11),
    createVibFrame(0.2, 11),
    createVibFrame(0.3, -10),
    createVibFrame(0.4, 10),
    createVibFrame(0.5, -11),
    createVibFrame(0.6, 11),
  ];
  const subtleVibBonus = judgeVibWindowBonus(
    vibTarget,
    subtleVibFrames,
    0.6,
    difficulty,
  );
  const shortTwoTickVibTarget = {
    ...vibTarget,
    targetId: "basic-vib-c4-short-two-tick",
    startSeconds: 0,
    endSeconds: 0.1875,
  };
  const shortTwoTickVibFrames = [
    createVibFrame(0.02, -14),
    createVibFrame(0.08, 13),
    createVibFrame(0.15, -12),
  ];
  const shortTwoTickVibBonus = judgeVibWindowBonus(
    shortTwoTickVibTarget,
    shortTwoTickVibFrames,
    0.16,
    difficulty,
  );
  const shortSubtleVibFrames = [
    createVibFrame(0.1, -10),
    createVibFrame(0.25, 10),
    createVibFrame(0.4, -10),
    createVibFrame(0.55, 10),
  ];
  const shortSubtleVibBonus = judgeVibWindowBonus(
    vibTarget,
    shortSubtleVibFrames,
    0.55,
    difficulty,
  );
  const wrongCenterVibFrames = [
    createVibFrame(0.1, 190),
    createVibFrame(0.2, 215),
    createVibFrame(0.3, 190),
    createVibFrame(0.4, 215),
    createVibFrame(0.5, 190),
    createVibFrame(0.6, 215),
  ];
  const wrongCenterVibBonus = judgeVibWindowBonus(
    vibTarget,
    wrongCenterVibFrames,
    0.6,
    difficulty,
  );

  assert(vibBonus !== null, "Alternating target-near pitch should create Vib bonus.");
  assert(vibBonus?.displayText === "Vib!", "Vib bonus should use the Vib! display text.");
  assertClose(vibBonus?.bonusContribution ?? -1, 5.0, 1e-9, "Vib segment bonus should add effect bonus score.");
  assert(subtleVibBonus !== null, "Alternating pitch around +/-10 cent should create Vib bonus.");
  assert(shortTwoTickVibBonus !== null, "Short 160 BPM two-tick vib should use the short-target threshold.");
  assert(shortSubtleVibBonus !== null, "Short alternating pitch around +/-10 cent should create Vib bonus.");
  assert(wrongCenterVibBonus === null, "Vib should require the average pitch to stay near the target.");
  assert(flatBonus === null, "Flat target-near pitch should not create Vib bonus.");

  const summaryAfterVib = vibBonus === null
    ? emptySummary
    : applyGameEffectBonus(emptySummary, vibBonus);

  assert(summaryAfterVib.vibBonusCount === 1, "Vib bonus should increment vib count.");
  assert(summaryAfterVib.glissBonusCount === 0, "Vib bonus should not increment gliss count.");
}

const explicitTremNote = createTestNoteEvent("basic-explicit-trem-c4", "basic", 0, 4, 60);
explicitTremNote.effects = [{
  time: {
    startTick: numberToTimeFraction(0),
    endTick: numberToTimeFraction(4),
  },
  vib: false,
  trem: {
    division: 4,
  },
}];
const rapidRepeatNotes = [
  createTestNoteEvent("basic-repeat-c4-0", "basic", 0, 1, 60),
  createTestNoteEvent("basic-repeat-c4-1", "basic", 1, 2, 60),
  createTestNoteEvent("basic-repeat-c4-2", "basic", 2, 3, 60),
];
const twoRepeatNotes = [
  createTestNoteEvent("basic-two-repeat-c4-0", "basic", 4, 5, 60),
  createTestNoteEvent("basic-two-repeat-c4-1", "basic", 5, 6, 60),
];
const mixedPitchRepeatNotes = [
  createTestNoteEvent("basic-repeat-c4-mixed-0", "basic", 7, 8, 60),
  createTestNoteEvent("basic-repeat-d4-mixed-1", "basic", 8, 9, 62),
  createTestNoteEvent("basic-repeat-c4-mixed-2", "basic", 9, 10, 60),
];
const tremAnalysis: AnalysisResult = {
  timingTimeline: [{
    time: {
      startTick: numberToTimeFraction(0),
      endTick: numberToTimeFraction(12),
    },
    startBpm: 120,
    endBpm: 120,
    bpmCurve: "instant",
    beatsPerBar: 4,
    stepsPerBeat: 4,
    sourceCells: [],
  }],
  dynamicsTimeline: [],
  trackResults: [
    {
      trackId: "basic",
      events: [
        explicitTremNote,
        ...rapidRepeatNotes,
        ...twoRepeatNotes,
        ...mixedPitchRepeatNotes,
      ],
    },
    {
      trackId: "optional",
      events: [
        createTestNoteEvent("optional-repeat-c4-0", "optional", 0, 1, 60),
        createTestNoteEvent("optional-repeat-c4-1", "optional", 1, 2, 60),
        createTestNoteEvent("optional-repeat-c4-2", "optional", 2, 3, 60),
      ],
    },
    {
      trackId: "extra",
      events: [],
    },
  ],
  analysisIssues: [],
};
const tremTargets = collectGameEffectBonusTargets(
  tremAnalysis,
  ["basic"],
  createTickTimeMapper(tremAnalysis.timingTimeline),
);
const rapidOnlyTremAnalysis: AnalysisResult = {
  ...tremAnalysis,
  trackResults: [
    {
      trackId: "basic",
      events: rapidRepeatNotes,
    },
    {
      trackId: "optional",
      events: [],
    },
    {
      trackId: "extra",
      events: [],
    },
  ],
};
const rapidOnlyTremMapper = createTickTimeMapper(rapidOnlyTremAnalysis.timingTimeline);
const rapidRepeatJudgeTargets = collectGameJudgeTargetsAtSeconds(
  rapidOnlyTremAnalysis,
  ["basic"],
  rapidOnlyTremMapper,
  rapidOnlyTremMapper.tickToSeconds(numberToTimeFraction(1)),
);
const rapidRepeatScoringSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 261.63,
    frequencyHz: 261.63,
    midi: 60,
    centOffset: 80,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  rapidRepeatJudgeTargets,
  rapidOnlyTremMapper.tickToSeconds(numberToTimeFraction(1)),
  difficulty,
  undefined,
  "standard",
);
const explicitTremMapper = createTickTimeMapper(tremAnalysis.timingTimeline);
const explicitTremJudgeTargets = collectGameJudgeTargetsAtSeconds(
  tremAnalysis,
  ["basic"],
  explicitTremMapper,
  explicitTremMapper.tickToSeconds(numberToTimeFraction(2)),
);
const explicitTremFirstHitTargets = collectGameJudgeTargetsAtSeconds(
  tremAnalysis,
  ["basic"],
  explicitTremMapper,
  explicitTremMapper.tickToSeconds(numberToTimeFraction(0.5)),
);
const explicitTremLastHitTargets = collectGameJudgeTargetsAtSeconds(
  tremAnalysis,
  ["basic"],
  explicitTremMapper,
  explicitTremMapper.tickToSeconds(numberToTimeFraction(3.5)),
);
const explicitTremScoringSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 261.63,
    frequencyHz: 261.63,
    midi: 60,
    centOffset: 80,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  explicitTremJudgeTargets,
  explicitTremMapper.tickToSeconds(numberToTimeFraction(2)),
  difficulty,
  undefined,
  "standard",
);
const explicitTremFirstHitSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 261.63,
    frequencyHz: 261.63,
    midi: 60,
    centOffset: 80,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  explicitTremFirstHitTargets,
  explicitTremMapper.tickToSeconds(numberToTimeFraction(0.5)),
  difficulty,
  undefined,
  "standard",
);
const explicitTremLastHitSample = judgeGameScoringSample(
  {
    capturedAtMs: 0,
    rawFrequencyHz: 261.63,
    frequencyHz: 261.63,
    midi: 60,
    centOffset: 80,
    clarity: 1,
    rms: 0.1,
    isVoiced: true,
    rejectReason: null,
  },
  explicitTremLastHitTargets,
  explicitTremMapper.tickToSeconds(numberToTimeFraction(3.5)),
  difficulty,
  undefined,
  "standard",
);
const explicitTremTarget = tremTargets.find((target) =>
  target.kind === "trem" && target.source === "explicit"
);
const rapidRepeatTremTarget = tremTargets.find((target) =>
  target.kind === "trem" && target.source === "rapidRepeat"
);

assert(explicitTremTarget?.kind === "trem", "Explicit trem effect should create a trem bonus target.");
assert(rapidRepeatTremTarget?.kind === "trem", "Three adjacent 1tick same-pitch notes should create a rapid repeat trem target.");
assert(
  tremTargets.filter((target) => target.kind === "trem" && target.source === "rapidRepeat").length === 1,
  "Two-note repeats and mixed-pitch 1tick runs should not create rapid repeat trem targets.",
);
assert(
  rapidRepeatJudgeTargets.some((target) => target.rapidRepeatTrem === true),
  "Rapid repeat trem note targets should be marked for relaxed scoring.",
);
assert(
  explicitTremJudgeTargets.some((target) => target.tremRelaxed === true),
  "2~4 division explicit trem note targets should be marked for relaxed scoring.",
);
assert(
  explicitTremFirstHitSample !== null &&
    explicitTremLastHitSample !== null &&
    explicitTremFirstHitSample.targetEventId.startsWith("basic-explicit-trem-c4:trem-relaxed:") &&
    explicitTremLastHitSample.targetEventId.startsWith("basic-explicit-trem-c4:trem-relaxed:") &&
    explicitTremFirstHitSample.targetEventId !== explicitTremLastHitSample.targetEventId,
  "Explicit trem divisions should split one note event into separate relaxed hit ids.",
);
assert(
  rapidRepeatScoringSample?.label === "Perfect",
  "Rapid repeat trem scoring should treat recognized pitch hits as Perfect.",
);
assert(
  explicitTremScoringSample?.label === "Perfect",
  "2~4 division explicit trem scoring should treat recognized pitch hits as Perfect.",
);
assert(
  rapidRepeatScoringSample?.scoreEligible === true,
  "Rapid repeat trem scoring should not require separate attack credit.",
);
assert(
  explicitTremScoringSample?.scoreEligible === true,
  "2~4 division explicit trem scoring should not require separate attack credit.",
);

if (rapidRepeatScoringSample !== null && explicitTremScoringSample !== null) {
  const rapidRepeatTremSummary = applyGameScoringSample(
    createEmptyGameScoreSummary(),
    rapidRepeatScoringSample,
    "standard",
  );
  const explicitTremSummary = applyGameScoringSample(
    createEmptyGameScoreSummary(),
    explicitTremScoringSample,
    "standard",
  );
  const explicitTremMultiHitSummary = explicitTremFirstHitSample !== null && explicitTremLastHitSample !== null
    ? applyGameScoringSample(
      applyGameScoringSample(createEmptyGameScoreSummary(), explicitTremFirstHitSample, "standard"),
      explicitTremLastHitSample,
      "standard",
    )
    : null;

  assertClose(
    rapidRepeatTremSummary.accuracyPercent,
    100,
    1e-9,
    "Rapid repeat trem Perfect should count as 100% pitch accuracy.",
  );
  assertClose(
    rapidRepeatTremSummary.timingAccuracyPercent,
    100,
    1e-9,
    "Rapid repeat trem Perfect should count as 100% timing accuracy.",
  );
  assertClose(
    explicitTremSummary.accuracyPercent,
    100,
    1e-9,
    "2~4 division explicit trem Perfect should count as 100% pitch accuracy.",
  );
  assertClose(
    explicitTremSummary.timingAccuracyPercent,
    100,
    1e-9,
    "2~4 division explicit trem Perfect should count as 100% timing accuracy.",
  );
  assert(
    explicitTremMultiHitSummary?.perfectCount === 2,
    "Explicit trem relaxed hit ids should allow multiple Perfect samples inside one note event.",
  );
  assertClose(
    explicitTremMultiHitSummary?.accuracyPercent ?? 0,
    100,
    1e-9,
    "Multiple explicit trem relaxed hits should keep 100% pitch accuracy.",
  );
  assertClose(
    explicitTremMultiHitSummary?.timingAccuracyPercent ?? 0,
    100,
    1e-9,
    "Multiple explicit trem relaxed hits should keep 100% timing accuracy.",
  );
}

if (rapidRepeatTremTarget !== undefined && rapidRepeatTremTarget.kind === "trem") {
  const tremRuntime: GameTremRuntimeState = {
    acceptedOnsetIds: new Set<number>(),
    lastAcceptedScoreSeconds: null,
    streakCount: 0,
    rewardedOnsetIds: new Set<number>(),
    rewardedSyntheticHitIds: new Set<string>(),
  };
  const firstTremAttack = judgeTremAttackBonus(
    rapidRepeatTremTarget,
    [
      createTimingOnset(1, rapidRepeatTremTarget.startSeconds + 0.02),
    ],
    tremRuntime,
    rapidRepeatTremTarget.startSeconds + 0.02,
    difficulty,
  );
  const secondTremAttack = judgeTremAttackBonus(
    rapidRepeatTremTarget,
    [
      createTimingOnset(1, rapidRepeatTremTarget.startSeconds + 0.02),
      createTimingOnset(2, rapidRepeatTremTarget.startSeconds + 0.14),
    ],
    tremRuntime,
    rapidRepeatTremTarget.startSeconds + 0.14,
    difficulty,
  );
  const duplicateTremAttack = judgeTremAttackBonus(
    rapidRepeatTremTarget,
    [
      createTimingOnset(2, rapidRepeatTremTarget.startSeconds + 0.14),
    ],
    tremRuntime,
    rapidRepeatTremTarget.startSeconds + 0.14,
    difficulty,
  );
  const resetRuntime: GameTremRuntimeState = {
    acceptedOnsetIds: new Set<number>(),
    lastAcceptedScoreSeconds: null,
    streakCount: 0,
    rewardedOnsetIds: new Set<number>(),
    rewardedSyntheticHitIds: new Set<string>(),
  };
  const longTremTarget = {
    ...rapidRepeatTremTarget,
    endSeconds: rapidRepeatTremTarget.startSeconds + 1,
  };
  const delayedFirstAttack = judgeTremAttackBonus(
    longTremTarget,
    [
      createTimingOnset(10, longTremTarget.startSeconds + 0.02),
    ],
    resetRuntime,
    longTremTarget.startSeconds + 0.02,
    difficulty,
  );
  const delayedSecondAttack = judgeTremAttackBonus(
    longTremTarget,
    [
      createTimingOnset(10, longTremTarget.startSeconds + 0.02),
      createTimingOnset(11, longTremTarget.startSeconds + 0.5),
    ],
    resetRuntime,
    longTremTarget.startSeconds + 0.5,
    difficulty,
  );

  assert(firstTremAttack === null, "First trem attack should start the streak without bonus.");
  assert(secondTremAttack !== null, "Second continuous trem attack should create Trem bonus.");
  assert(secondTremAttack?.displayText === "Trem!", "Trem bonus should use the Trem! display text.");
  assertClose(secondTremAttack?.bonusContribution ?? -1, 0.5, 1e-9, "Trem attack bonus should use the single multiplier.");
  assert(duplicateTremAttack === null, "Same trem onset should not be rewarded twice.");
  assert(delayedFirstAttack === null, "First delayed trem attack should not create bonus.");
  assert(delayedSecondAttack === null, "Long gap should reset trem streak instead of creating bonus.");
}

if (explicitTremTarget !== undefined && explicitTremTarget.kind === "trem") {
  const syntheticRuntime: GameTremRuntimeState = {
    acceptedOnsetIds: new Set<number>(),
    lastAcceptedScoreSeconds: null,
    streakCount: 0,
    rewardedOnsetIds: new Set<number>(),
    rewardedSyntheticHitIds: new Set<string>(),
  };
  const firstSyntheticTremHit = judgeTremAttackBonus(
    explicitTremTarget,
    [],
    syntheticRuntime,
    explicitTremTarget.startSeconds + 0.01,
    difficulty,
    {
      capturedAtMs: 0,
      rawFrequencyHz: 261.63,
      frequencyHz: 261.63,
      midi: 60,
      centOffset: 80,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
  );
  const duplicateSyntheticTremHit = judgeTremAttackBonus(
    explicitTremTarget,
    [],
    syntheticRuntime,
    explicitTremTarget.startSeconds + 0.02,
    difficulty,
    {
      capturedAtMs: 16,
      rawFrequencyHz: 261.63,
      frequencyHz: 261.63,
      midi: 60,
      centOffset: 80,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
  );
  const secondSyntheticTremHit = judgeTremAttackBonus(
    explicitTremTarget,
    [],
    syntheticRuntime,
    explicitTremTarget.endSeconds - 0.01,
    difficulty,
    {
      capturedAtMs: 320,
      rawFrequencyHz: 261.63,
      frequencyHz: 261.63,
      midi: 60,
      centOffset: 80,
      clarity: 1,
      rms: 0.1,
      isVoiced: true,
      rejectReason: null,
    },
  );

  assert(firstSyntheticTremHit !== null, "Explicit trem should create Trem bonus from a pitch hit without onset.");
  assert(duplicateSyntheticTremHit === null, "Explicit trem synthetic hit should not reward the same division twice.");
  assert(secondSyntheticTremHit !== null, "Explicit trem should reward another division hit inside one note event.");
}

// 화면 보정은 입력 Sync와 독립적이며 시작·끝 및 비정상 값에서도 유효한 시간만 반환한다.
assertClose(getPracticeDisplaySeconds(10.3, 20, 300), 10, 1e-9, "Positive display offset delays the viewport.");
assertClose(getPracticeDisplaySeconds(10, 20, -300), 10.3, 1e-9, "Negative display offset advances the viewport.");
assertClose(getPracticeDisplaySeconds(0.1, 20, 300), 0, 1e-9, "Display time clamps at score start.");
assertClose(getPracticeDisplaySeconds(19.9, 20, -300), 20, 1e-9, "Display time clamps at score end.");
assertClose(getPracticeDisplaySeconds(4, 20, 0), 4, 1e-9, "Default display offset preserves playback position.");
assertClose(getPracticeDisplaySeconds(4, 20, Number.NaN), 4, 1e-9, "Invalid display offset falls back to zero.");
assert(normalizeGameDisplayOffsetMs(999) === 500, "Display upper bound is 500ms.");
assert(normalizeGameDisplayOffsetMs(-999) === -500, "Display lower bound is -500ms.");
assert(normalizeGameDisplayOffsetMs(24) === 24, "Display offset preserves 1ms steps.");
assert(normalizeGameDisplayOffsetMs(-24.4) === -24, "Display offset rounds to integer milliseconds.");
assert(normalizeGameSyncOffsetMs(96.4) === 96, "Input Sync rounds to integer milliseconds.");
assertClose(applyGameSyncOffsetSeconds(10.3, 90), 10.21, 1e-9, "Input Sync continues to use its independent offset.");

// 입력 Sync와 별개로 화면 보정의 저장·복원·오염 값·저장소 실패를 검증한다.
const displayStorage = installLocalStorageMock();
saveGameSyncOffsetMsToLocalStorage(90);
assert(loadGameDisplayOffsetMsFromLocalStorage() === 0, "Missing display preference defaults to zero.");
assert(saveGameDisplayOffsetMsToLocalStorage(304) === 304, "Stored display preference preserves 1ms steps.");
assert(loadGameDisplayOffsetMsFromLocalStorage() === 304, "Display preference survives reload.");
assert(loadGameSyncOffsetMsFromLocalStorage() === 90, "Display preference does not overwrite input Sync.");
assert(saveGameSyncOffsetMsToLocalStorage(91) === 91, "Input Sync saves 1ms adjustments.");
assert(loadGameSyncOffsetMsFromLocalStorage() === 91, "Input Sync restores 1ms adjustments.");
displayStorage.set("regression-code:game-display-offset-ms", "broken");
assert(loadGameDisplayOffsetMsFromLocalStorage() === 0, "Invalid stored display preference defaults to zero.");
displayStorage.set("regression-code:game-display-offset-ms", "900");
assert(loadGameDisplayOffsetMsFromLocalStorage() === 500, "Stored display preference is bounded.");
saveGameDisplayOffsetMsToLocalStorage(0);
assert(loadGameDisplayOffsetMsFromLocalStorage() === 0, "Display Reset persists zero.");
const usableStorage = globalThis.localStorage;
Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
assert(loadGameDisplayOffsetMsFromLocalStorage() === 0, "Blocked storage reads use zero.");
assert(saveGameDisplayOffsetMsToLocalStorage(300) === 300, "Blocked storage writes preserve runtime adjustment.");
Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: usableStorage });

console.log("Game mode pitch math test completed.");

// 실제 입력 기록에서 만든 후보도 기존 후보 fixture와 같은 판정 결과를 반환한다.
const recordedInput = createGameInputHistory();
recordedInput.recordFrame(createPerfectTimingFrame(1010), 1.03);
const recordedSample = judgeGameScoringSample(
  createPerfectTimingFrame(1010), timingTarget, 1.01, difficulty,
  { onsetCandidates: recordedInput.getOnsets(), judgedEventIds: new Set(),
    consumedOnsetIds: new Set(), attackSatisfiedEventIds: new Set() },
);
assert(JSON.stringify(recordedSample) === JSON.stringify(onTimeSample), "Recorded onset must preserve scoring result.");
