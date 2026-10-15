import { readFileSync } from "node:fs";

import { analyzeDocument } from "../src/core/analyze/analyze_full";
import type {
  GlissEvent,
  AnalysisResult,
  MuteEvent,
  NoteEvent,
  RestEvent,
  TupletExtendGroupEvent,
  TupletGroupEvent,
} from "../src/core/analyze/types";
import { buildParsedDocument } from "../src/core/parse/build_parsed_document";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";
import type { ScoreFile } from "../src/core/score/types";
import { createTickTimeMapper } from "../src/audio/tick_time_mapper";
import { collectGameEffectBonusTargets } from "../src/app/game/game_effect_judge";
import {
  buildCanvasMarkerItems,
  buildCanvasMuteRenderItems,
  buildCanvasNoteRenderItems,
} from "../src/renderer/canvas_item_builder";

const fixtureUrl = new URL("./test_cases/minimal-valid-score.json", import.meta.url);
const jsonText = readFileSync(fixtureUrl, "utf8");
const result = loadRuntimeDocument(jsonText);

/**
 * TimeFraction을 테스트 비교용 number로 바꾼다.
 * - 인수 : value : analyzer 시간 분수
 * - 반환값 : number : numerator / denominator
 */
function tickToNumber(value: { numerator: number; denominator: number }): number {
  return value.numerator / value.denominator;
}

/**
 * analyzer event 목록에서 NoteEvent만 고른다.
 * - 인수 : events : analyzer event 목록
 * - 반환값 : NoteEvent[] : note event만 모은 배열
 */
function getNoteEvents(events: Array<{ eventKind: string }>): NoteEvent[] {
  return events.filter((event): event is NoteEvent => event.eventKind === "note");
}

/**
 * analyzer event 목록에서 GlissEvent만 고른다.
 * - 인수 : events : analyzer event 목록
 * - 반환값 : GlissEvent[] : gliss event만 모은 배열
 */
function getGlissEvents(events: Array<{ eventKind: string }>): GlissEvent[] {
  return events.filter((event): event is GlissEvent => event.eventKind === "gliss");
}

/**
 * analyzer event 목록에서 MuteEvent만 고른다.
 * - 인수 : events : analyzer event 목록
 * - 반환값 : MuteEvent[] : mute event만 모은 배열
 */
function getMuteEvents(events: Array<{ eventKind: string }>): MuteEvent[] {
  return events.filter((event): event is MuteEvent => event.eventKind === "mute");
}

/**
 * analyzer event 목록에서 RestEvent만 고른다.
 * - 인수 : events : analyzer event 목록
 * - 반환값 : RestEvent[] : rest event만 모은 배열
 */
function getRestEvents(events: Array<{ eventKind: string }>): RestEvent[] {
  return events.filter((event): event is RestEvent => event.eventKind === "rest");
}

/**
 * analyzer event 목록에서 TupletGroupEvent만 고른다.
 * - 인수 : events : analyzer event 목록
 * - 반환값 : TupletGroupEvent[] : tuplet group event만 모은 배열
 */
function getTupletGroupEvents(events: Array<{ eventKind: string }>): TupletGroupEvent[] {
  return events.filter((event): event is TupletGroupEvent => event.eventKind === "tupletGroup");
}

/**
 * analyzer event 목록에서 TupletExtendGroupEvent만 고른다.
 * - 인수 : events : analyzer event 목록
 * - 반환값 : TupletExtendGroupEvent[] : orphan extend group event만 모은 배열
 */
function getTupletExtendGroupEvents(
  events: Array<{ eventKind: string }>,
): TupletExtendGroupEvent[] {
  return events.filter((event): event is TupletExtendGroupEvent => event.eventKind === "tupletExtendGroup");
}

/**
 * 조건이 거짓이면 테스트 실패 상태를 기록한다.
 * - 인수 : condition : 통과 조건
 * - 인수 : message : 실패 시 출력할 메시지
 * - 반환값 : 없음
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
  }
}

/**
 * number 값이 허용 오차 안에서 같은지 검증한다.
 * - 인수 : actual : 실제 값
 * - 인수 : expected : 기대 값
 * - 인수 : message : 실패 시 출력할 메시지
 * - 반환값 : 없음
 */
function assertApproximately(actual: number, expected: number, message: string): void {
  assert(Math.abs(actual - expected) < 0.000001, message);
}

/**
 * score JSON 문자열을 복제 가능한 ScoreFile로 읽는다.
 * - 인수 : sourceText : fixture JSON 문자열
 * - 반환값 : ScoreFile : 테스트에서 수정할 score 객체
 */
function parseFixtureScore(sourceText: string): ScoreFile {
  return JSON.parse(sourceText) as ScoreFile;
}

/**
 * score 객체를 런타임 문서로 로드하고 analyzer를 실행한다.
 * - 인수 : score : 테스트용 score 객체
 * - 반환값 : analyzer 결과와 로드 성공 여부
 */
function analyzeFixtureScore(score: ScoreFile):
  | {
      ok: true;
      noteEvents: NoteEvent[];
      glissEvents: GlissEvent[];
      muteEvents: MuteEvent[];
      restEvents: RestEvent[];
      tupletGroupEvents: TupletGroupEvent[];
      tupletExtendGroupEvents: TupletExtendGroupEvent[];
      analysis: AnalysisResult;
    }
  | { ok: false } {
  const modifierResult = loadRuntimeDocument(JSON.stringify(score));

  if (!modifierResult.ok) {
    console.error("Runtime document load failed for modifier score.");
    console.error(modifierResult.error);
    return { ok: false };
  }

  const parsed = buildParsedDocument(modifierResult.document);
  const analysis = analyzeDocument({
    score: modifierResult.document.score,
    indexes: modifierResult.document.indexes,
    parsed,
  });
  const basicTrack = analysis.trackResults.find(
    (track) => track.trackId === "basic",
  );

  return {
    ok: true,
    noteEvents: getNoteEvents(basicTrack?.events ?? []),
    glissEvents: getGlissEvents(basicTrack?.events ?? []),
    muteEvents: getMuteEvents(basicTrack?.events ?? []),
    restEvents: getRestEvents(basicTrack?.events ?? []),
    tupletGroupEvents: getTupletGroupEvents(basicTrack?.events ?? []),
    tupletExtendGroupEvents: getTupletExtendGroupEvents(basicTrack?.events ?? []),
    analysis,
  };
}

/**
 * analyzer modifier 연결 동작을 검증한다.
 * - 인수 : sourceText : 기본 fixture JSON 문자열
 * - 반환값 : 없음
 */
function testModifierAnalysis(sourceText: string): void {
  const score = parseFixtureScore(sourceText);
  const basicTrack = score.tracks.find((track) => track.trackId === "basic");

  assert(basicTrack !== undefined, "Missing basic track in modifier fixture.");

  if (basicTrack === undefined) {
    return;
  }

  // 기존 기본 fixture와 충돌하지 않는 높은 col에 modifier 전용 셀을 추가한다.
  basicTrack.cells.push(
    { rowId: "s1-note-52", col: 20, rawText: "P@p(60)@m(100)" },
    { rowId: "s1-note-53", col: 22, rawText: "T@t(3)" },
    { rowId: "s1-note-53", col: 23, rawText: "-" },
    { rowId: "s1-note-53", col: 24, rawText: "~" },
    { rowId: "s1-note-65", col: 25, rawText: "F4" },
    { rowId: "s1-note-65", col: 26, rawText: "~" },
    { rowId: "s1-note-65", col: 27, rawText: "~" },
  );

  const modifierAnalysis = analyzeFixtureScore(score);

  assert(modifierAnalysis.ok, "Modifier score should analyze.");

  if (!modifierAnalysis.ok) {
    return;
  }

  const absoluteMicroEvent = modifierAnalysis.noteEvents.find(
    (event) => tickToNumber(event.time.startTick) === 20,
  );
  const tremVibEvent = modifierAnalysis.noteEvents.find(
    (event) => tickToNumber(event.time.startTick) === 22,
  );
  const headVibEvent = modifierAnalysis.noteEvents.find(
    (event) => tickToNumber(event.time.startTick) === 25,
  );

  assert(absoluteMicroEvent !== undefined, "Missing @p/@m note event.");
  assert(tremVibEvent !== undefined, "Missing @t/~ note event.");
  assert(headVibEvent !== undefined, "Missing head-vib note event.");

  if (absoluteMicroEvent !== undefined) {
    assert(absoluteMicroEvent.sound.midi === 60, "@p should override sound midi.");
    assert(absoluteMicroEvent.sound.centOffset === 100, "@m should affect sound cents.");
    assert(
      absoluteMicroEvent.display.rowId === "s1-note-52" &&
        absoluteMicroEvent.display.centOffset === 100,
      "@m should affect display cent offset while keeping source row.",
    );
  }

  if (tremVibEvent !== undefined) {
    assert(
      tickToNumber(tremVibEvent.time.startTick) === 22 &&
        tickToNumber(tremVibEvent.time.endTick) === 25,
      "@t then hold/vib sequence should merge into 22..25.",
    );
    assert(tremVibEvent.effects.length === 3, "Merged @t/~ event should keep 3 effect segments.");
    assert(
      tremVibEvent.effects[0]?.trem?.division === 3,
      "@t should start trem segment with division 3.",
    );
    assert(
      tremVibEvent.effects[1]?.trem?.division === 3,
      "plain hold should continue previous trem segment.",
    );
    assert(
      tremVibEvent.effects[2]?.vib === true &&
        tremVibEvent.effects[2]?.trem === null,
      "~ should create vib segment and stop trem display.",
    );
  }

  if (headVibEvent !== undefined) {
    assert(
      tickToNumber(headVibEvent.time.startTick) === 25 &&
        tickToNumber(headVibEvent.time.endTick) === 28,
      "F4 then two vib holds should merge into 25..28.",
    );
    assert(headVibEvent.effects.length === 3, "Head-vib event should keep 3 effect segments.");
    assert(
      headVibEvent.effects.every((effect) => effect.vib && effect.trem === null),
      "Head note should be included in the vibrato segment when followed immediately by '~'.",
    );
  }

  const gameEffectTargets = collectGameEffectBonusTargets(
    modifierAnalysis.analysis,
    ["basic"],
    createTickTimeMapper(modifierAnalysis.analysis.timingTimeline),
  );
  const vibTargets = gameEffectTargets.filter((target) => target.kind === "vib");
  const headVibTarget = vibTargets.find((target) =>
    Math.abs(target.startSeconds - createTickTimeMapper(modifierAnalysis.analysis.timingTimeline).tickToSeconds({
      numerator: 25,
      denominator: 1,
    })) < 0.000001 &&
    Math.abs(target.endSeconds - createTickTimeMapper(modifierAnalysis.analysis.timingTimeline).tickToSeconds({
      numerator: 28,
      denominator: 1,
    })) < 0.000001
  );

  assert(vibTargets.length >= 2, "Game effect target collection should include analyzer vibrato segments.");
  assert(headVibTarget !== undefined, "Consecutive analyzer vibrato segments should merge into one game target.");
}

/**
 * mute analyzer와 renderer text DTO 변환을 검증한다.
 * - 인수 : sourceText : 기본 fixture JSON 문자열
 * - 반환값 : 없음
 */
function testMuteAnalysis(sourceText: string): void {
  const score = parseFixtureScore(sourceText);
  const basicTrack = score.tracks.find((track) => track.trackId === "basic");

  assert(basicTrack !== undefined, "Missing basic track in mute fixture.");

  if (basicTrack === undefined) {
    return;
  }

  basicTrack.cells.push(
    { rowId: "s1-note-60", col: 26, rawText: "//memo" },
  );

  const muteAnalysis = analyzeFixtureScore(score);

  assert(muteAnalysis.ok, "Mute score should analyze.");

  if (!muteAnalysis.ok) {
    return;
  }

  assert(muteAnalysis.muteEvents.length === 1, "Mute cell should create one MuteEvent.");

  const muteEvent = muteAnalysis.muteEvents[0];

  assert(muteEvent !== undefined, "Missing mute event.");

  if (muteEvent !== undefined) {
    assert(muteEvent.eventId === "basic:mute:s1-note-60:26", "MuteEvent eventId should be stable.");
    assert(muteEvent.text === "memo", "MuteEvent should keep display text without // prefix.");
    assert(muteEvent.display.rowId === "s1-note-60", "MuteEvent display row mismatch.");
    assert(
      tickToNumber(muteEvent.time.startTick) === 26 &&
        tickToNumber(muteEvent.time.endTick) === 27,
      "MuteEvent should occupy one cell tick.",
    );
  }

  const muteItems = buildCanvasMuteRenderItems({
    timingTimeline: [],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: muteAnalysis.muteEvents,
      },
    ],
    analysisIssues: [],
  });

  assert(muteItems.length === 1, "MuteEvent should convert to one mute render item.");
  assert(
    muteItems[0]?.rowId === "s1-note-60" &&
      muteItems[0].sourceEventId === "basic:mute:s1-note-60:26" &&
      muteItems[0].startTick === 26 &&
      muteItems[0].endTick === 27 &&
      muteItems[0].text === "memo",
    "Mute render item should keep row, tick range, and text.",
  );
}

/**
 * gliss analyzer와 renderer marker DTO 변환을 검증한다.
 * - 인수 : sourceText : 기본 fixture JSON 문자열
 * - 반환값 : 없음
 */
function testGlissAnalysis(sourceText: string): void {
  const score = parseFixtureScore(sourceText);
  const basicTrack = score.tracks.find((track) => track.trackId === "basic");

  assert(basicTrack !== undefined, "Missing basic track in gliss fixture.");

  if (basicTrack === undefined) {
    return;
  }

  // gliss S-M-E anchor와 동일 열 중복 mid를 배치해 빈칸 건너뛰기와 mid 중복 제한을 검증한다.
  basicTrack.cells.push(
    { rowId: "s1-note-60", col: 30, rawText: "C4@g(a,S)@t(3)" },
    { rowId: "s1-note-64", col: 32, rawText: "E4@g(a,M)" },
    { rowId: "s1-note-62", col: 32, rawText: "D4@g(a,M)" },
    { rowId: "s1-note-67", col: 34, rawText: "G4@g(a,E)" },
    { rowId: "s1-note-69", col: 36, rawText: "A4@g(b,S)" },
    { rowId: "s1-note-71", col: 38, rawText: "B4@g(c,M)" },
    { rowId: "s1-note-72", col: 40, rawText: "C5@g(d,E)" },
    { rowId: "s1-note-60", col: 70, rawText: "C4@g(e,S)" },
    { rowId: "s1-note-62", col: 72, rawText: "D4@g(e,M)@t(3)" },
    { rowId: "s1-note-64", col: 74, rawText: "E4@g(e,E)" },
    { rowId: "s1-note-60", col: 82, rawText: "C4@g(f,S)" },
    { rowId: "s1-note-64", col: 82, rawText: "E4@g(f,S)" },
    { rowId: "s1-note-67", col: 84, rawText: "G4@g(f,E)" },
    { rowId: "s1-note-60", col: 90, rawText: "C4@g(h,S)" },
    { rowId: "s1-note-64", col: 92, rawText: "E4@g(h,E)" },
    { rowId: "s1-note-64", col: 93, rawText: "-" },
    { rowId: "s1-note-64", col: 94, rawText: "-" },
  );

  const glissAnalysis = analyzeFixtureScore(score);

  assert(glissAnalysis.ok, "Gliss score should analyze.");

  if (!glissAnalysis.ok) {
    return;
  }

  assert(glissAnalysis.glissEvents.length === 6, "S-M-E gliss chains should create six gliss segments.");

  const firstGliss = glissAnalysis.glissEvents[0];
  const secondGliss = glissAnalysis.glissEvents[1];

  assert(firstGliss !== undefined, "Missing first gliss segment.");
  assert(secondGliss !== undefined, "Missing second gliss segment.");

  if (firstGliss !== undefined && secondGliss !== undefined) {
    assert(firstGliss.glissId === "a", "First gliss id should be preserved.");
    assert(firstGliss.fromKind === "start", "First gliss should start from S anchor.");
    assert(firstGliss.toKind === "mid", "First gliss should connect to M anchor.");
    assert(firstGliss.startDisplay.rowId === "s1-note-60", "First gliss start display row mismatch.");
    assert(firstGliss.endDisplay.rowId === "s1-note-64", "Duplicate mid anchors should keep the upper display row.");
    assert(
      tickToNumber(firstGliss.time.startTick) === 30 &&
        tickToNumber(firstGliss.time.endTick) === 33,
      "First gliss should span from start anchor tick to mid anchor release.",
    );

    assert(secondGliss.fromKind === "mid", "Second gliss should start from M anchor.");
    assert(secondGliss.toKind === "end", "Second gliss should connect to E anchor.");
    assert(secondGliss.startDisplay.rowId === "s1-note-64", "Second gliss start display row mismatch.");
    assert(secondGliss.endDisplay.rowId === "s1-note-67", "Second gliss end display row mismatch.");
  }

  const duplicateStartGliss = glissAnalysis.glissEvents.find((event) => event.glissId === "f");

  assert(duplicateStartGliss !== undefined, "Duplicate start fixture should create one gliss segment.");

  if (duplicateStartGliss !== undefined) {
    assert(
      duplicateStartGliss.startDisplay.rowId === "s1-note-64",
      "Duplicate start anchors should keep the upper display row.",
    );
    assert(
      duplicateStartGliss.endDisplay.rowId === "s1-note-67",
      "Duplicate start gliss should connect to the following end anchor.",
    );
  }

  const heldEndGliss = glissAnalysis.glissEvents.find((event) => event.glissId === "h");

  assert(heldEndGliss !== undefined, "Held end anchor fixture should create one gliss segment.");

  if (heldEndGliss !== undefined) {
    assert(
      tickToNumber(heldEndGliss.endAnchorTick) === 92.5,
      "Gliss end anchor should stay at the first end cell center even when held.",
    );
  }

  const markerItems = buildCanvasMarkerItems({
    timingTimeline: [],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [
          ...glissAnalysis.noteEvents,
          ...glissAnalysis.glissEvents,
        ],
      },
    ],
    analysisIssues: [],
  });

  assert(markerItems.length === 11, "Gliss events and orphan anchors should convert to eleven marker items.");
  const glissMarkerItems = markerItems.filter((item) => item.kind === "gliss");
  const firstConnectedMarker = glissMarkerItems[0];
  const secondConnectedMarker = glissMarkerItems[1];

  assert(
    firstConnectedMarker?.kind === "gliss" &&
      firstConnectedMarker.sourceEventId === "basic:gliss:a:s1-note-60:30" &&
      firstConnectedMarker.startRowId === "s1-note-60" &&
      firstConnectedMarker.endRowId === "s1-note-64" &&
      firstConnectedMarker.startTick === 30.5 &&
      firstConnectedMarker.endTick === 32.5 &&
      firstConnectedMarker.hasTrem,
    "First gliss marker item should keep analyzer display endpoints.",
  );
  assert(
    secondConnectedMarker?.kind === "gliss" && !secondConnectedMarker.hasTrem,
    "Gliss marker should use dashed style only when trem overlaps its segment.",
  );

  const midTremMarkers = markerItems.filter(
    (item) => item.kind === "gliss" && item.startTick >= 70 && item.startTick < 80,
  );

  assert(midTremMarkers.length === 2, "Mid-trem gliss chain should create two marker items.");
  assert(
    midTremMarkers[0]?.kind === "gliss" && !midTremMarkers[0].hasTrem,
    "Trem on a mid anchor should not dash the incoming gliss segment.",
  );
  assert(
    midTremMarkers[1]?.kind === "gliss" && midTremMarkers[1].hasTrem,
    "Trem on a mid anchor should dash only the outgoing right gliss segment.",
  );

  const heldEndMarker = glissMarkerItems.find(
    (item) => item.kind === "gliss" && item.startTick === 90.5,
  );

  assert(heldEndMarker !== undefined, "Held end gliss should convert to one marker item.");

  if (heldEndMarker !== undefined && heldEndMarker.kind === "gliss") {
    assert(
      heldEndMarker.endTick === 92.5,
      "Gliss marker should end at the first end cell center instead of the held rectangle center.",
    );
  }

  const orphanItems = markerItems.filter((item) => item.kind === "glissOrphanAnchor");

  assert(orphanItems.length === 5, "Unconnected gliss anchors should create five orphan marker items.");
  assert(
    orphanItems.some((item) => item.kind === "glissOrphanAnchor" && item.rowId === "s1-note-69" && item.role === "start"),
    "Standalone start anchor should create a right-side orphan marker.",
  );
  assert(
    orphanItems.some((item) => item.kind === "glissOrphanAnchor" && item.rowId === "s1-note-71" && item.role === "mid"),
    "Standalone mid anchor should create a both-side orphan marker.",
  );
  assert(
    orphanItems.some((item) => item.kind === "glissOrphanAnchor" && item.rowId === "s1-note-72" && item.role === "end"),
    "Standalone end anchor should create a left-side orphan marker.",
  );
  assert(
    orphanItems.some((item) => item.kind === "glissOrphanAnchor" && item.rowId === "s1-note-62" && item.role === "mid"),
    "Duplicate mid anchor excluded from connection should remain visible as an orphan marker.",
  );
  assert(
    orphanItems.some((item) => item.kind === "glissOrphanAnchor" && item.rowId === "s1-note-60" && item.role === "start"),
    "Duplicate start anchor excluded from connection should remain visible as an orphan marker.",
  );
}

/**
 * tuplet analyzer가 group, slot note/rest, 유리수 tick을 생성하는지 검증한다.
 * - 인수 : sourceText : 기본 fixture JSON 문자열
 * - 반환값 : 없음
 */
function testTupletAnalysis(sourceText: string): void {
  const score = parseFixtureScore(sourceText);
  const basicTrack = score.tracks.find((track) => track.trackId === "basic");

  assert(basicTrack !== undefined, "Missing basic track in tuplet fixture.");

  if (basicTrack === undefined) {
    return;
  }

  // head + /& 두 칸 길이에 3개 slot을 배치해 2/3 tick 단위 slot 시간을 검증한다.
  basicTrack.cells.push(
    { rowId: "s1-note-60", col: 42, rawText: "/3(C@n(60)||E@t(3)@n(64))" },
    { rowId: "s1-note-60", col: 43, rawText: "/&" },
  );

  const tupletAnalysis = analyzeFixtureScore(score);

  assert(tupletAnalysis.ok, "Tuplet score should analyze.");

  if (!tupletAnalysis.ok) {
    return;
  }

  assert(tupletAnalysis.tupletGroupEvents.length === 1, "Tuplet head should create one group event.");

  const groupEvent = tupletAnalysis.tupletGroupEvents[0];

  assert(groupEvent !== undefined, "Missing tuplet group event.");

  if (groupEvent !== undefined) {
    assert(groupEvent.groupId === "basic:tuplet:s1-note-60:42", "Tuplet group id should be stable.");
    assert(
      groupEvent.eventId === "tupletGroup:basic:tuplet:s1-note-60:42",
      "Tuplet group eventId should be stable.",
    );
    assert(groupEvent.divNum === 3, "Tuplet division should be preserved.");
    assert(groupEvent.extendCells.length === 1, "Tuplet group should include one extend cell.");
    assert(
      tickToNumber(groupEvent.time.startTick) === 42 &&
        tickToNumber(groupEvent.time.endTick) === 44,
      "Tuplet group should span head and extend columns.",
    );
    assert(
      groupEvent.slots.map((slot) => slot.parsedKind).join(",") === "note,rest,note",
      "Tuplet group should record note/rest/note slot kinds.",
    );
  }

  const tupletNotes = tupletAnalysis.noteEvents.filter(
    (event) => event.tuplet?.groupId === "basic:tuplet:s1-note-60:42",
  );
  const tupletRests = tupletAnalysis.restEvents.filter(
    (event) => event.tuplet?.groupId === "basic:tuplet:s1-note-60:42",
  );

  assert(tupletNotes.length === 2, "Tuplet should create two slot note events.");
  assert(tupletRests.length === 1, "Tuplet empty slot should create one rest event.");

  const firstSlotNote = tupletNotes.find((event) => event.tuplet?.slotIndex === 0);
  const lastSlotNote = tupletNotes.find((event) => event.tuplet?.slotIndex === 2);
  const restSlot = tupletRests[0];

  assert(firstSlotNote !== undefined, "Missing first tuplet slot note.");
  assert(lastSlotNote !== undefined, "Missing last tuplet slot note.");
  assert(restSlot !== undefined, "Missing tuplet rest slot.");

  if (firstSlotNote !== undefined) {
    assert(firstSlotNote.display.rowId === "s1-note-60", "First tuplet slot should map @n(60) to C4 row.");
    assert(firstSlotNote.sourceCells[0]?.slotIndex === 0, "First tuplet slot source should keep slotIndex 0.");
    assert(
      tickToNumber(firstSlotNote.time.startTick) === 42 &&
        tickToNumber(firstSlotNote.time.endTick) === 42 + 2 / 3,
      "First tuplet slot should occupy 42..42+2/3.",
    );
  }

  if (restSlot !== undefined) {
    assert(restSlot.eventId === "basic:rest:s1-note-60:42:slot:1", "Tuplet rest eventId should be stable.");
    assert(restSlot.display === null, "Tuplet rest slot should not have display position.");
    assert(restSlot.sourceCells[0]?.slotIndex === 1, "Rest tuplet slot source should keep slotIndex 1.");
    assert(
      tickToNumber(restSlot.time.startTick) === 42 + 2 / 3 &&
        tickToNumber(restSlot.time.endTick) === 43 + 1 / 3,
      "Rest tuplet slot should occupy 42+2/3..43+1/3.",
    );
  }

  if (lastSlotNote !== undefined) {
    assert(lastSlotNote.display.rowId === "s1-note-64", "Last tuplet slot should map @n(64) to E4 row.");
    assert(lastSlotNote.effects[0]?.trem?.division === 3, "Tuplet slot note should preserve @t(3).");
    assert(lastSlotNote.sourceCells[0]?.slotIndex === 2, "Last tuplet slot source should keep slotIndex 2.");
    assert(
      tickToNumber(lastSlotNote.time.startTick) === 43 + 1 / 3 &&
        tickToNumber(lastSlotNote.time.endTick) === 44,
      "Last tuplet slot should occupy 43+1/3..44.",
    );
  }

  const markerItems = buildCanvasMarkerItems({
    timingTimeline: [],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [
          ...tupletAnalysis.noteEvents,
          ...tupletAnalysis.restEvents,
          ...tupletAnalysis.tupletGroupEvents,
        ],
      },
    ],
    analysisIssues: [],
  });
  const tupletMarker = markerItems.find((item) => item.kind === "tupletContainer");

  assert(tupletMarker !== undefined, "Tuplet group should convert to one container marker item.");

  if (tupletMarker !== undefined && tupletMarker.kind === "tupletContainer") {
    assert(
      tupletMarker.sourceEventId === "tupletGroup:basic:tuplet:s1-note-60:42",
      "Tuplet marker should keep source eventId.",
    );
    assert(tupletMarker.rowId === "s1-note-60", "Tuplet container should use head cell row.");
    assert(tupletMarker.startTick === 42 && tupletMarker.endTick === 44, "Tuplet container should keep group span.");
    assert(tupletMarker.divNum === 3, "Tuplet container should keep division label value.");
  }
}

/**
 * tuplet container가 head cell row가 아니라 첫 slot 위치 row에 표시되는지 검증한다.
 * - 인수 : sourceText : 기본 fixture JSON 문자열
 * - 반환값 : 없음
 */
function testTupletContainerPlacementAnalysis(sourceText: string): void {
  const score = parseFixtureScore(sourceText);
  const basicTrack = score.tracks.find((track) => track.trackId === "basic");

  assert(basicTrack !== undefined, "Missing basic track in tuplet placement fixture.");

  if (basicTrack === undefined) {
    return;
  }

  basicTrack.cells.push(
    { rowId: "s1-note-67", col: 48, rawText: "/3(C@n(60)|D@n(62)|E@n(64))" },
    { rowId: "s1-note-67", col: 50, rawText: "/3(|D@n(62)|E@n(64))" },
    { rowId: "s1-note-67", col: 52, rawText: "/3(||)" },
  );

  const placementAnalysis = analyzeFixtureScore(score);

  assert(placementAnalysis.ok, "Tuplet placement score should analyze.");

  if (!placementAnalysis.ok) {
    return;
  }

  const firstSlotGroup = placementAnalysis.tupletGroupEvents.find(
    (event) => event.headCell.col === 48,
  );
  const restFirstGroup = placementAnalysis.tupletGroupEvents.find(
    (event) => event.headCell.col === 50,
  );
  const allRestGroup = placementAnalysis.tupletGroupEvents.find(
    (event) => event.headCell.col === 52,
  );

  assert(firstSlotGroup !== undefined, "Missing first-slot placement tuplet group event.");
  assert(restFirstGroup !== undefined, "Missing rest-first placement tuplet group event.");
  assert(allRestGroup !== undefined, "Missing all-rest placement tuplet group event.");

  if (
    firstSlotGroup !== undefined &&
    restFirstGroup !== undefined &&
    allRestGroup !== undefined
  ) {
    assert(firstSlotGroup.headCell.rowId === "s1-note-67", "Tuplet source head row should keep stored cell row.");
    assert(firstSlotGroup.containerRowId === "s1-note-60", "Tuplet container row should follow first slot @n row.");
    assert(restFirstGroup.containerRowId === "s1-note-62", "Rest-first tuplet container should use first non-rest slot row.");
    assert(allRestGroup.containerRowId === "s1-note-67", "All-rest tuplet container should keep head row.");
  }

  const markerItems = buildCanvasMarkerItems({
    timingTimeline: [],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: placementAnalysis.tupletGroupEvents,
      },
    ],
    analysisIssues: [],
  });
  const tupletMarkers = markerItems.filter((item) => item.kind === "tupletContainer");

  assert(
    tupletMarkers.some((item) => item.kind === "tupletContainer" && item.rowId === "s1-note-60"),
    "Tuplet marker should draw at first slot row.",
  );
  assert(
    tupletMarkers.some((item) => item.kind === "tupletContainer" && item.rowId === "s1-note-62"),
    "Rest-first tuplet marker should draw at first non-rest slot row.",
  );
  assert(
    tupletMarkers.some((item) => item.kind === "tupletContainer" && item.rowId === "s1-note-67"),
    "All-rest tuplet marker should draw at head row.",
  );
}

/**
 * head가 삭제되고 extend만 남은 tuplet 잔여 구간 표시 이벤트를 검증한다.
 * - 인수 : sourceText : 기본 fixture JSON 문자열
 * - 반환값 : 없음
 */
function testTupletExtendOnlyAnalysis(sourceText: string): void {
  const score = parseFixtureScore(sourceText);
  const basicTrack = score.tracks.find((track) => track.trackId === "basic");

  assert(basicTrack !== undefined, "Missing basic track in tuplet extend fixture.");

  if (basicTrack === undefined) {
    return;
  }

  basicTrack.cells.push(
    { rowId: "s1-note-60", col: 52, rawText: "/&" },
    { rowId: "s1-note-60", col: 53, rawText: "/&" },
  );

  const extendAnalysis = analyzeFixtureScore(score);

  assert(extendAnalysis.ok, "Tuplet extend-only score should analyze.");

  if (!extendAnalysis.ok) {
    return;
  }

  assert(
    extendAnalysis.tupletExtendGroupEvents.length === 1,
    "Consecutive orphan extend cells should create one extend group event.",
  );

  const extendGroup = extendAnalysis.tupletExtendGroupEvents[0];

  assert(extendGroup !== undefined, "Missing tuplet extend group event.");

  if (extendGroup !== undefined) {
    assert(
      extendGroup.eventId === "tupletExtendGroup:basic:tuplet-extend:s1-note-60:52",
      "Tuplet extend group eventId should be stable.",
    );
    assert(extendGroup.rowId === "s1-note-60", "Tuplet extend group should keep extend row.");
    assert(
      tickToNumber(extendGroup.time.startTick) === 52 &&
        tickToNumber(extendGroup.time.endTick) === 54,
      "Tuplet extend group should span consecutive extend columns.",
    );
  }

  const markerItems = buildCanvasMarkerItems({
    timingTimeline: [],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: extendAnalysis.tupletExtendGroupEvents,
      },
    ],
    analysisIssues: [],
  });
  const extendMarker = markerItems.find((item) => item.kind === "tupletContainer");

  assert(extendMarker !== undefined, "Tuplet extend group should convert to a container marker.");

  if (extendMarker !== undefined && extendMarker.kind === "tupletContainer") {
    assert(
      extendMarker.sourceEventId === "tupletExtendGroup:basic:tuplet-extend:s1-note-60:52",
      "Tuplet extend marker should keep source eventId.",
    );
    assert(extendMarker.rowId === "s1-note-60", "Tuplet extend marker should keep extend row.");
    assert(extendMarker.startTick === 52 && extendMarker.endTick === 54, "Tuplet extend marker span mismatch.");
    assert(extendMarker.divNum === null, "Tuplet extend marker should not draw a division label.");
  }
}

/**
 * tuplet slot 내부 gliss anchor가 slot 시작 tick으로 marker 변환되고 note item은 정사각형 표시가 되는지 검증한다.
 * - 인수 : sourceText : 기본 fixture JSON 문자열
 * - 반환값 : 없음
 */
function testTupletGlissAnalysis(sourceText: string): void {
  const score = parseFixtureScore(sourceText);
  const basicTrack = score.tracks.find((track) => track.trackId === "basic");

  assert(basicTrack !== undefined, "Missing basic track in tuplet gliss fixture.");

  if (basicTrack === undefined) {
    return;
  }

  basicTrack.cells.push(
    { rowId: "s1-note-60", col: 56, rawText: "/3(C@g(t,S)@n(60)|D@g(t,M)@n(62)|E@g(t,E)@n(64))" },
    { rowId: "s1-note-60", col: 58, rawText: "/3(C@g(u,S)@n(60)|D@g(u,M)@n(62)|E@g(u,E)@n(64))" },
    { rowId: "s1-note-60", col: 59, rawText: "/&" },
    { rowId: "s1-note-60", col: 60, rawText: "/&" },
    { rowId: "s1-note-60", col: 62, rawText: "/3(C@n(60)|-@g(v,S)@n(60)|E@g(v,E)@n(64))" },
    { rowId: "s1-note-60", col: 63, rawText: "/&" },
    { rowId: "s1-note-60", col: 64, rawText: "/&" },
  );

  const glissAnalysis = analyzeFixtureScore(score);

  assert(glissAnalysis.ok, "Tuplet gliss score should analyze.");

  if (!glissAnalysis.ok) {
    return;
  }

  assert(glissAnalysis.glissEvents.length === 5, "Tuplet S-M-E fixtures should create five gliss segments.");

  const markerItems = buildCanvasMarkerItems({
    timingTimeline: [],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: [
          ...glissAnalysis.noteEvents,
          ...glissAnalysis.glissEvents,
        ],
      },
    ],
    analysisIssues: [],
  });
  const noteItems = buildCanvasNoteRenderItems({
    timingTimeline: [],
    dynamicsTimeline: [],
    trackResults: [
      {
        trackId: "basic",
        events: glissAnalysis.noteEvents,
      },
    ],
    analysisIssues: [],
  });
  const glissMarkers = markerItems.filter((item) => item.kind === "gliss");
  const tupletGlissNoteItems = noteItems.filter((item) => item.displayShape === "anchorSquare");
  const heldStartBaseItem = noteItems.find((item) =>
    item.sourceEventId === "basic:note:s1-note-60:62:slot:0" &&
    item.displayShape === "rect"
  );
  const heldStartAnchorItem = tupletGlissNoteItems.find((item) =>
    item.rowId === "s1-note-60" &&
    item.startTick === 63 &&
    item.endTick === 64
  );

  assert(glissMarkers.length === 5, "Tuplet gliss events should convert to five gliss marker items.");
  assert(
    tupletGlissNoteItems.length === 3,
    "Long tuplet gliss start/mid slot notes should convert to three anchor-square note items.",
  );
  assert(
    tupletGlissNoteItems[0]?.sourceEventId === "basic:note:s1-note-60:58:slot:0",
    "Tuplet gliss note item should keep source eventId.",
  );

  const firstMarker = glissMarkers[0];
  const secondMarker = glissMarkers[1];
  const thirdMarker = glissMarkers[2];
  const fourthMarker = glissMarkers[3];
  const fifthMarker = glissMarkers[4];

  assert(firstMarker !== undefined, "Missing first tuplet gliss marker.");
  assert(secondMarker !== undefined, "Missing second tuplet gliss marker.");
  assert(thirdMarker !== undefined, "Missing third tuplet gliss marker.");
  assert(fourthMarker !== undefined, "Missing fourth tuplet gliss marker.");
  assert(fifthMarker !== undefined, "Missing fifth tuplet gliss marker.");

  if (firstMarker !== undefined && firstMarker.kind === "gliss") {
    assertApproximately(firstMarker.startTick, 56 + 1 / 6, "Short tuplet gliss should start at slot 0 center.");
    assertApproximately(firstMarker.endTick, 56 + 1 / 2, "Short tuplet gliss should end at slot 1 center.");
    assert(firstMarker.startRowId === "s1-note-60", "First tuplet gliss start row mismatch.");
    assert(firstMarker.endRowId === "s1-note-62", "First tuplet gliss end row mismatch.");
  }

  if (secondMarker !== undefined && secondMarker.kind === "gliss") {
    assertApproximately(secondMarker.startTick, 56 + 1 / 2, "Short tuplet gliss should start at slot 1 center.");
    assertApproximately(secondMarker.endTick, 56 + 5 / 6, "Short tuplet gliss should end at slot 2 center.");
    assert(secondMarker.startRowId === "s1-note-62", "Second tuplet gliss start row mismatch.");
    assert(secondMarker.endRowId === "s1-note-64", "Second tuplet gliss end row mismatch.");
  }

  if (thirdMarker !== undefined && thirdMarker.kind === "gliss") {
    assertApproximately(thirdMarker.startTick, 58.5, "Long tuplet gliss should start at shifted slot 0 anchor.");
    assertApproximately(thirdMarker.endTick, 59.5, "Long tuplet gliss should end at shifted slot 1 anchor.");
    assert(thirdMarker.startRowId === "s1-note-60", "Third tuplet gliss start row mismatch.");
    assert(thirdMarker.endRowId === "s1-note-62", "Third tuplet gliss end row mismatch.");
  }

  if (fourthMarker !== undefined && fourthMarker.kind === "gliss") {
    assertApproximately(fourthMarker.startTick, 59.5, "Long tuplet gliss should start at shifted slot 1 anchor.");
    assertApproximately(fourthMarker.endTick, 60.5, "Long tuplet gliss should end at shifted slot 2 anchor.");
    assert(fourthMarker.startRowId === "s1-note-62", "Fourth tuplet gliss start row mismatch.");
    assert(fourthMarker.endRowId === "s1-note-64", "Fourth tuplet gliss end row mismatch.");
  }

  if (fifthMarker !== undefined && fifthMarker.kind === "gliss") {
    assertApproximately(fifthMarker.startTick, 63.5, "Held tuplet gliss start should use the held slot anchor.");
    assertApproximately(fifthMarker.endTick, 64.5, "Held tuplet gliss end should use the end slot anchor.");
    assert(fifthMarker.startRowId === "s1-note-60", "Fifth tuplet gliss start row mismatch.");
    assert(fifthMarker.endRowId === "s1-note-64", "Fifth tuplet gliss end row mismatch.");
  }

  assert(
    noteItems.some((item) =>
      item.rowId === "s1-note-60" &&
      item.startTick === 56 &&
      item.displayShape === "rect"
    ),
    "Short tuplet gliss start note should keep the original slot rectangle.",
  );
  assert(
    noteItems.some((item) =>
      item.rowId === "s1-note-62" &&
      Math.abs(item.startTick - (56 + 1 / 3)) < 0.000001 &&
      item.displayShape === "rect"
    ),
    "Short tuplet gliss mid note should keep the original slot rectangle.",
  );
  assert(
    tupletGlissNoteItems.some((item) =>
      item.rowId === "s1-note-60" &&
      item.startTick === 58 &&
      item.displayShape === "anchorSquare"
    ),
    "Long tuplet gliss start note square should be placed at slot 0 start.",
  );
  assert(
    tupletGlissNoteItems.some((item) =>
      item.rowId === "s1-note-62" &&
      item.startTick === 59 &&
      item.displayShape === "anchorSquare"
    ),
    "Long tuplet gliss mid note square should be placed at slot 1 start.",
  );
  assert(
    noteItems.some((item) =>
      item.rowId === "s1-note-64" &&
      item.startTick === 60 &&
      item.displayShape === "rect"
    ),
    "Long tuplet gliss end note should keep the normal rectangle shape.",
  );
  assert(
    heldStartBaseItem !== undefined &&
      heldStartBaseItem.startTick === 62 &&
      heldStartBaseItem.endTick === 63,
    "Held tuplet gliss base note rectangle should stop before the anchor square.",
  );
  assert(
    heldStartBaseItem?.omittedBorders?.right === true,
    "Held tuplet gliss base note rectangle should omit the right border before the anchor square.",
  );
  assert(
    heldStartAnchorItem !== undefined,
    "Held tuplet gliss start slot should add an anchor-square item at the held slot.",
  );
  assert(
    heldStartAnchorItem?.omittedBorders?.left === true,
    "Held tuplet gliss start square should omit the left border to connect with the previous rectangle.",
  );
  assert(
    heldStartAnchorItem?.extendLeftToConnect === true,
    "Held tuplet gliss start square should extend left to cover the intentional note inset gap.",
  );
}

/**
 * 전역 행의 instant/ramp token이 timing/dynamics timeline segment로 정규화되는지 검증한다.
 * - 인수 : sourceText : 기본 fixture JSON 문자열
 * - 반환값 : 없음
 */
function testGlobalTimelineAnalysis(sourceText: string): void {
  const score = parseFixtureScore(sourceText);

  score.globalLines.cells = score.globalLines.cells.map((cell) => {
    if (cell.rowId === "global-bpm" && cell.col === 0) {
      return { ...cell, rawText: "120<" };
    }

    if (cell.rowId === "global-dyn" && cell.col === 0) {
      return { ...cell, rawText: "100<" };
    }

    return cell;
  });
  score.globalLines.cells.push(
    { rowId: "global-spb", col: 4, rawText: "2" },
    { rowId: "global-bpm", col: 8, rawText: "240><" },
    { rowId: "global-dyn", col: 8, rawText: "60>" },
    { rowId: "global-bpb", col: 12, rawText: "3" },
    { rowId: "global-dyn", col: 12, rawText: "80<" },
    { rowId: "global-bpm", col: 16, rawText: "120>" },
  );

  const timelineAnalysis = analyzeFixtureScore(score);

  assert(timelineAnalysis.ok, "Global timeline fixture should analyze.");

  if (!timelineAnalysis.ok) {
    return;
  }

  const timing = timelineAnalysis.analysis.timingTimeline;
  const dynamics = timelineAnalysis.analysis.dynamicsTimeline;

  assert(timing.length === 5, "Timing boundaries should split BPM ramp around step and beat changes.");
  assert(dynamics.length === 3, "Dynamics boundaries should follow dynamics cells only.");

  const firstTiming = timing[0];
  const secondTiming = timing[1];
  const thirdTiming = timing[2];
  const fourthTiming = timing[3];
  const finalTiming = timing[4];

  if (
    firstTiming !== undefined &&
    secondTiming !== undefined &&
    thirdTiming !== undefined &&
    fourthTiming !== undefined &&
    finalTiming !== undefined
  ) {
    assert(tickToNumber(firstTiming.time.startTick) === 0, "First timing segment should start at 0.");
    assert(tickToNumber(firstTiming.time.endTick) === 4, "First timing segment should end at SPB change.");
    assertApproximately(firstTiming.startBpm, 120, "First ramp start BPM mismatch.");
    assertApproximately(firstTiming.endBpm, 180, "First ramp end BPM mismatch.");
    assert(firstTiming.bpmCurve === "linear", "First timing segment should be linear.");
    assert(firstTiming.stepsPerBeat === 4, "First timing segment should keep initial SPB.");

    assert(tickToNumber(secondTiming.time.startTick) === 4, "Second timing segment should start at SPB change.");
    assert(tickToNumber(secondTiming.time.endTick) === 8, "Second timing segment should end at endStart BPM.");
    assertApproximately(secondTiming.startBpm, 180, "Second ramp start BPM mismatch.");
    assertApproximately(secondTiming.endBpm, 240, "Second ramp end BPM mismatch.");
    assert(secondTiming.stepsPerBeat === 2, "Second timing segment should use changed SPB.");

    assert(tickToNumber(thirdTiming.time.startTick) === 8, "Third timing segment should start at endStart BPM.");
    assert(tickToNumber(thirdTiming.time.endTick) === 12, "Third timing segment should end at BPB change.");
    assertApproximately(thirdTiming.startBpm, 240, "Third ramp start BPM mismatch.");
    assertApproximately(thirdTiming.endBpm, 180, "Third ramp end BPM mismatch.");
    assert(thirdTiming.beatsPerBar === 4, "Third timing segment should keep initial BPB.");

    assert(tickToNumber(fourthTiming.time.startTick) === 12, "Fourth timing segment should start at BPB change.");
    assert(tickToNumber(fourthTiming.time.endTick) === 16, "Fourth timing segment should end at BPM end.");
    assertApproximately(fourthTiming.startBpm, 180, "Fourth ramp start BPM mismatch.");
    assertApproximately(fourthTiming.endBpm, 120, "Fourth ramp end BPM mismatch.");
    assert(fourthTiming.beatsPerBar === 3, "Fourth timing segment should use changed BPB.");

    assert(finalTiming.bpmCurve === "instant", "Completed BPM end should become constant after its col.");
    assert(finalTiming.startBpm === 120, "Final timing segment should keep BPM end value.");
  }

  const firstDynamics = dynamics[0];
  const secondDynamics = dynamics[1];
  const thirdDynamics = dynamics[2];

  if (
    firstDynamics !== undefined &&
    secondDynamics !== undefined &&
    thirdDynamics !== undefined
  ) {
    assert(firstDynamics.curve === "linear", "Completed dynamics ramp should be linear.");
    assert(firstDynamics.startValue === 100, "Dynamics ramp start mismatch.");
    assert(firstDynamics.endValue === 60, "Dynamics ramp end mismatch.");
    assert(secondDynamics.curve === "instant", "Dynamics after ramp end should be instant.");
    assert(secondDynamics.startValue === 60, "Dynamics after ramp end should keep end value.");
    assert(thirdDynamics.curve === "instant", "Unmatched dynamics start should degrade to instant.");
    assert(thirdDynamics.startValue === 80, "Unmatched dynamics start should use its numeric value.");
  }

  const markerItems = buildCanvasMarkerItems(timelineAnalysis.analysis);
  const bpmMarkers = markerItems.filter((item) => item.kind === "bpmChange");
  const dynamicsGuides = markerItems.filter((item) => item.kind === "dynamicsGuide");

  assert(bpmMarkers.length === 2, "Fixture should draw one BPM marker per change column except the initial col 0 start.");
  assert(
    bpmMarkers[0]?.kind === "bpmChange" &&
      bpmMarkers[0].tick === 8 &&
      bpmMarkers[0].changeKind === "rit",
    "BPM endStart marker should collapse to one green rit marker at the new ramp start column.",
  );
  assert(
    bpmMarkers[1]?.kind === "bpmChange" &&
      bpmMarkers[1].tick === 16 &&
      bpmMarkers[1].changeKind === "instant",
    "BPM ramp end should draw a sky-blue marker at the final end column.",
  );
  assert(dynamicsGuides.length === 3, "Dynamics timeline should convert to three dynamics guide markers.");
  assert(
    dynamicsGuides[0]?.kind === "dynamicsGuide" &&
      dynamicsGuides[0].rowId === "global-dyn" &&
      dynamicsGuides[0].startTick === 0 &&
      dynamicsGuides[0].endTick === 8 &&
      dynamicsGuides[0].startValue === 100 &&
      dynamicsGuides[0].endValue === 60,
    "First dynamics guide should keep row, tick range, and ramp values.",
  );
}

/**
 * BPM marker 변환이 초기값 제외, instant, accel, rit, ramp split 중복 제거를 지키는지 검증한다.
 * - 반환값 : 없음
 */
function testBpmMarkerConversion(): void {
  const markerItems = buildCanvasMarkerItems({
    timingTimeline: [
      {
        time: { startTick: { numerator: 0, denominator: 1 }, endTick: { numerator: 4, denominator: 1 } },
        startBpm: 120,
        endBpm: 120,
        bpmCurve: "instant",
        beatsPerBar: 4,
        stepsPerBeat: 4,
        sourceCells: [],
      },
      {
        time: { startTick: { numerator: 4, denominator: 1 }, endTick: { numerator: 8, denominator: 1 } },
        startBpm: 140,
        endBpm: 140,
        bpmCurve: "instant",
        beatsPerBar: 4,
        stepsPerBeat: 4,
        sourceCells: [],
      },
      {
        time: { startTick: { numerator: 8, denominator: 1 }, endTick: { numerator: 12, denominator: 1 } },
        startBpm: 140,
        endBpm: 160,
        bpmCurve: "linear",
        beatsPerBar: 4,
        stepsPerBeat: 4,
        sourceCells: [],
      },
      {
        time: { startTick: { numerator: 12, denominator: 1 }, endTick: { numerator: 16, denominator: 1 } },
        startBpm: 160,
        endBpm: 180,
        bpmCurve: "linear",
        beatsPerBar: 3,
        stepsPerBeat: 4,
        sourceCells: [],
      },
      {
        time: { startTick: { numerator: 16, denominator: 1 }, endTick: { numerator: 20, denominator: 1 } },
        startBpm: 180,
        endBpm: 120,
        bpmCurve: "linear",
        beatsPerBar: 3,
        stepsPerBeat: 4,
        sourceCells: [],
      },
    ],
    dynamicsTimeline: [],
    trackResults: [],
    analysisIssues: [],
  });
  const bpmMarkers = markerItems.filter((item) => item.kind === "bpmChange");

  assert(bpmMarkers.length === 3, "Synthetic timing should create one BPM marker per instant/ramp-start column.");
  assert(
    bpmMarkers[0]?.kind === "bpmChange" &&
      bpmMarkers[0].tick === 4 &&
      bpmMarkers[0].changeKind === "instant",
    "Instant BPM change should draw a sky-blue marker at tick 4.",
  );
  assert(
    bpmMarkers[1]?.kind === "bpmChange" &&
      bpmMarkers[1].tick === 8 &&
      bpmMarkers[1].changeKind === "accel",
    "Increasing BPM ramp should draw a red marker at tick 8.",
  );
  assert(
    bpmMarkers[2]?.kind === "bpmChange" &&
      bpmMarkers[2].tick === 16 &&
      bpmMarkers[2].changeKind === "rit",
    "BPM ramp endStart should collapse to one green marker at tick 16.",
  );

  const sameDirectionEndStartMarkers = buildCanvasMarkerItems({
    timingTimeline: [
      {
        time: { startTick: { numerator: 0, denominator: 1 }, endTick: { numerator: 4, denominator: 1 } },
        startBpm: 100,
        endBpm: 110,
        bpmCurve: "linear",
        beatsPerBar: 4,
        stepsPerBeat: 4,
        sourceCells: [
          { rowId: "global-bpm", col: 0 },
          { rowId: "global-bpm", col: 8 },
        ],
      },
      {
        time: { startTick: { numerator: 4, denominator: 1 }, endTick: { numerator: 8, denominator: 1 } },
        startBpm: 110,
        endBpm: 120,
        bpmCurve: "linear",
        beatsPerBar: 3,
        stepsPerBeat: 4,
        sourceCells: [
          { rowId: "global-bpm", col: 0 },
          { rowId: "global-bpm", col: 8 },
          { rowId: "global-bpb", col: 4 },
        ],
      },
      {
        time: { startTick: { numerator: 8, denominator: 1 }, endTick: { numerator: 16, denominator: 1 } },
        startBpm: 120,
        endBpm: 150,
        bpmCurve: "linear",
        beatsPerBar: 3,
        stepsPerBeat: 4,
        sourceCells: [
          { rowId: "global-bpm", col: 8 },
          { rowId: "global-bpm", col: 16 },
        ],
      },
    ],
    dynamicsTimeline: [],
    trackResults: [],
    analysisIssues: [],
  }).filter((item) => item.kind === "bpmChange");

  assert(
    sameDirectionEndStartMarkers.length === 1 &&
      sameDirectionEndStartMarkers[0]?.kind === "bpmChange" &&
      sameDirectionEndStartMarkers[0].tick === 8 &&
      sameDirectionEndStartMarkers[0].changeKind === "accel",
    "Same-direction BPM endStart should draw one accel marker while split continuation stays hidden.",
  );
}

if (!result.ok) {
  console.error("Runtime document load failed.");
  console.error(result.error);
  process.exitCode = 1;
} else {
  const parsed = buildParsedDocument(result.document);
  const analysis = analyzeDocument({
    score: result.document.score,
    indexes: result.document.indexes,
    parsed,
  });
  const basicTrack = analysis.trackResults.find(
    (track) => track.trackId === "basic",
  );
  const optionalTrack = analysis.trackResults.find(
    (track) => track.trackId === "optional",
  );
  const extraTrack = analysis.trackResults.find(
    (track) => track.trackId === "extra",
  );
  const basicNoteEvents = getNoteEvents(basicTrack?.events ?? []);

  console.log("Analyze document completed.");
  console.log(`track results: ${analysis.trackResults.length}`);
  console.log(`basic note events: ${basicNoteEvents.length}`);
  console.log(`timing segments: ${analysis.timingTimeline.length}`);
  console.log(`dynamics segments: ${analysis.dynamicsTimeline.length}`);
  console.log(`issues: ${analysis.analysisIssues.length}`);

  assert(basicTrack !== undefined, "Missing basic track analysis result.");
  assert(optionalTrack !== undefined, "Missing optional track analysis result.");
  assert(extraTrack !== undefined, "Missing extra track analysis result.");
  assert(optionalTrack?.events.length === 0, "Optional track should have no MVP events.");
  assert(extraTrack?.events.length === 0, "Extra track should have no MVP events.");
  assert(basicNoteEvents.length === 6, "Basic track should produce 6 note events.");

  const firstEvent = basicNoteEvents[0];
  const secondEvent = basicNoteEvents[1];
  const thirdEvent = basicNoteEvents[2];
  const fourthEvent = basicNoteEvents[3];

  assert(firstEvent !== undefined, "Missing first note event.");
  assert(secondEvent !== undefined, "Missing second note event.");
  assert(thirdEvent !== undefined, "Missing third note event.");
  assert(fourthEvent !== undefined, "Missing fourth note event.");

  if (
    firstEvent !== undefined &&
    secondEvent !== undefined &&
    thirdEvent !== undefined &&
    fourthEvent !== undefined
  ) {
    assert(
      tickToNumber(firstEvent.time.startTick) === 0 &&
        tickToNumber(firstEvent.time.endTick) === 4,
      "E3 hold sequence should merge into 0..4.",
    );
    assert(firstEvent.sourceCells.length === 4, "E3 merged note should keep 4 source cells.");
    assert(firstEvent.text === "E3", "E3 merged note should keep display text.");
    assert(
      firstEvent.displayTextAnchors.map((anchor) => anchor.text).join(" ") === "E3 - - -",
      "E3 merged note should keep per-anchor display text.",
    );
    assert(
      firstEvent.displayTextAnchors.map((anchor) => tickToNumber(anchor.time.startTick)).join(",") === "0,1,2,3",
      "E3 merged note should keep per-anchor start ticks.",
    );
    assert(firstEvent.sound.midi === 52, "E3 merged note should use MIDI 52.");
    assert(firstEvent.display.rowId === "s1-note-52", "E3 merged note display row mismatch.");

    assert(
      tickToNumber(secondEvent.time.startTick) === 4 &&
        tickToNumber(secondEvent.time.endTick) === 6,
      "First F3 hold sequence should merge into 4..6.",
    );
    assert(secondEvent.sourceCells.length === 2, "First F3 merged note should keep 2 source cells.");

    assert(
      tickToNumber(thirdEvent.time.startTick) === 6 &&
        tickToNumber(thirdEvent.time.endTick) === 8,
      "Second F3 hold sequence should merge into 6..8.",
    );
    assert(thirdEvent.sourceCells.length === 2, "Second F3 merged note should keep 2 source cells.");

    assert(
      tickToNumber(fourthEvent.time.startTick) === 8 &&
        tickToNumber(fourthEvent.time.endTick) === 9,
      "F#3 note should occupy 8..9.",
    );
    assert(fourthEvent.sound.midi === 54, "F#3 note should use MIDI 54.");
  }

  const timing = analysis.timingTimeline[0];
  const dynamics = analysis.dynamicsTimeline[0];

  assert(timing !== undefined, "Missing MVP timing segment.");
  assert(dynamics !== undefined, "Missing MVP dynamics segment.");

  if (timing !== undefined) {
    assert(timing.startBpm === 120, "MVP timing should use BPM 120.");
    assert(timing.endBpm === 120, "MVP timing should keep BPM 120.");
    assert(timing.beatsPerBar === 4, "MVP timing should use beatsPerBar 4.");
    assert(timing.stepsPerBeat === 4, "MVP timing should use stepsPerBeat 4.");
    assert(
      tickToNumber(timing.time.endTick) === result.document.score.globalLines.columnCount,
      "MVP timing should cover the full document length.",
    );
  }

  if (dynamics !== undefined) {
    assert(dynamics.startValue === 100, "MVP dynamics should use value 100.");
    assert(dynamics.endValue === 100, "MVP dynamics should keep value 100.");
  }

  testModifierAnalysis(jsonText);
  testMuteAnalysis(jsonText);
  testGlissAnalysis(jsonText);
  testTupletAnalysis(jsonText);
  testTupletContainerPlacementAnalysis(jsonText);
  testTupletExtendOnlyAnalysis(jsonText);
  testTupletGlissAnalysis(jsonText);
  testGlobalTimelineAnalysis(jsonText);
  testBpmMarkerConversion();
}
