/**
 * analyzer 결과를 renderer-owned canvas item으로 변환한다.
 */

import type {
  AnalysisResult,
  AnalyzedEvent,
  GlissEvent,
  MuteEvent,
  NoteEvent,
  SourceCellRef,
  TimeFraction,
  TimeRange,
  TupletExtendGroupEvent,
  TupletGroupEvent,
} from "../core/analyze/types";
import type {
  ScoreFile,
  TrackId,
} from "../core/score/types";
import {
  DEFAULT_ACTIVE_TRACK_IDS,
  getTrackDrawOrder,
  getTrackRenderAlpha,
} from "../track/track_control";
import type {
  CanvasGlobalTextRenderItem,
  CanvasMarkerItem,
  CanvasMuteRenderItem,
  CanvasNoteRenderItem,
} from "./canvas_types";

/**
 * analyzer 결과에서 note layer가 사용할 note item 목록을 만든다.
 * - 인수 : analysis : analyzer가 확정한 문서 분석 결과
 * - 반환값 : CanvasNoteRenderItem[] : renderer-owned note 표시 item 목록
 */
export function buildCanvasNoteRenderItems(
  analysis: AnalysisResult,
  activeTrackIds: readonly TrackId[] = DEFAULT_ACTIVE_TRACK_IDS,
): CanvasNoteRenderItem[] {
  const items: CanvasNoteRenderItem[] = [];

  // trackResults를 순회하며 실제 발음 이벤트인 NoteEvent만 renderer item으로 변환한다.
  for (const trackResult of analysis.trackResults) {
    for (const event of trackResult.events) {
      if (!isNoteEvent(event)) {
        continue;
      }

      items.push({
        rowId: event.display.rowId,
        displayCentOffset: event.display.centOffset,
        startTick: timeFractionToNumber(event.time.startTick),
        endTick: timeFractionToNumber(event.time.endTick),
        midi: event.sound.midi,
        text: event.text,
        displayShape: getNoteDisplayShape(event),
        displayTextAnchors: event.displayTextAnchors.map((anchor) => ({
          sourceRowId: anchor.source.rowId,
          sourceCol: anchor.source.col,
          sourceSlotIndex: anchor.source.slotIndex,
          startTick: timeFractionToNumber(anchor.time.startTick),
          endTick: timeFractionToNumber(anchor.time.endTick),
          text: anchor.text,
        })),
        effects: event.effects.map((effect) => ({
          startTick: timeFractionToNumber(effect.time.startTick),
          endTick: timeFractionToNumber(effect.time.endTick),
          vib: effect.vib,
          tremDivision: effect.trem?.division ?? null,
        })),
        trackId: event.trackId,
        renderAlpha: getTrackRenderAlpha(activeTrackIds, event.trackId),
      });
    }
  }

  // note layer draw 순서가 입력 순서에 의존하지 않도록 시간, 행, track 순서로 정렬한다.
  return items.sort((left, right) => {
    if (left.startTick !== right.startTick) {
      return left.startTick - right.startTick;
    }
    if (left.rowId !== right.rowId) {
      return left.rowId.localeCompare(right.rowId);
    }
    return getTrackDrawOrder(left.trackId) - getTrackDrawOrder(right.trackId);
  });
}

/**
 * note event의 renderer 표시 형태를 결정한다.
 * - 인수 : event : analyzer가 확정한 note event
 * - 반환값 : 일반 사각형 또는 tuplet gliss용 시작점 정사각형 표시 형태
 */
function getNoteDisplayShape(event: NoteEvent): CanvasNoteRenderItem["displayShape"] {
  if (
    event.tuplet !== null &&
    event.tuplet !== undefined &&
    event.glissAnchors.some((anchor) =>
      (anchor.role === "start" || anchor.role === "mid") &&
      timeRangeToDuration(anchor.time) >= 1
    )
  ) {
    return "anchorSquare";
  }

  return "rect";
}

/**
 * TimeRange 길이를 renderer tick number로 계산한다.
 * - 인수 : time : 길이를 계산할 analyzer 시간 범위
 * - 반환값 : endTick - startTick 값
 */
function timeRangeToDuration(time: TimeRange): number {
  return timeFractionToNumber(time.endTick) - timeFractionToNumber(time.startTick);
}

/**
 * analyzer 결과에서 note layer가 사용할 mute text item 목록을 만든다.
 * - 인수 : analysis : analyzer가 확정한 문서 분석 결과
 * - 반환값 : CanvasMuteRenderItem[] : renderer-owned mute 텍스트 표시 item 목록
 */
export function buildCanvasMuteRenderItems(
  analysis: AnalysisResult,
  activeTrackIds: readonly TrackId[] = DEFAULT_ACTIVE_TRACK_IDS,
): CanvasMuteRenderItem[] {
  const items: CanvasMuteRenderItem[] = [];

  // trackResults를 순회하며 표시 전용 이벤트인 MuteEvent만 renderer item으로 변환한다.
  for (const trackResult of analysis.trackResults) {
    for (const event of trackResult.events) {
      if (!isMuteEvent(event)) {
        continue;
      }

      items.push({
        rowId: event.display.rowId,
        startTick: timeFractionToNumber(event.time.startTick),
        endTick: timeFractionToNumber(event.time.endTick),
        text: event.text,
        trackId: event.trackId,
        renderAlpha: getTrackRenderAlpha(activeTrackIds, event.trackId),
      });
    }
  }

  // mute text draw 순서가 입력 순서에 의존하지 않도록 시간, 행, track 순서로 정렬한다.
  return items.sort((left, right) => {
    if (left.startTick !== right.startTick) {
      return left.startTick - right.startTick;
    }
    if (left.rowId !== right.rowId) {
      return left.rowId.localeCompare(right.rowId);
    }
    return getTrackDrawOrder(left.trackId) - getTrackDrawOrder(right.trackId);
  });
}

/**
 * ScoreFile의 globalLines.cells 원본 문자열을 renderer 전역 텍스트 item으로 변환한다.
 * - 인수 : score : 현재 score JSON
 * - 반환값 : CanvasGlobalTextRenderItem[] : 전역 행에 표시할 rawText 목록
 */
export function buildCanvasGlobalTextRenderItems(
  score: ScoreFile,
): CanvasGlobalTextRenderItem[] {
  const items = score.globalLines.cells
    .filter((cell) => cell.rawText.trim().length > 0)
    .map((cell) => ({
      rowId: cell.rowId,
      col: cell.col,
      text: cell.rawText,
    }));

  // draw 순서가 입력 순서에 의존하지 않도록 rowId, col 순서로 정렬한다.
  return items.sort((left, right) =>
    left.rowId.localeCompare(right.rowId) || left.col - right.col
  );
}

/**
 * analyzer 결과에서 marker layer가 사용할 item 목록을 만든다.
 * - 인수 : analysis : analyzer가 확정한 문서 분석 결과
 * - 반환값 : CanvasMarkerItem[] : renderer-owned marker 표시 item 목록
 */
export function buildCanvasMarkerItems(
  analysis: AnalysisResult,
  activeTrackIds: readonly TrackId[] = DEFAULT_ACTIVE_TRACK_IDS,
): CanvasMarkerItem[] {
  const items: CanvasMarkerItem[] = [
    ...buildDynamicsGuideMarkerItems(analysis),
    ...buildTimingLineMarkerItems(analysis),
    ...buildBpmChangeMarkerItems(analysis),
  ];
  const connectedGlissAnchorKeys = new Set<string>();
  const noteEvents = collectNoteEvents(analysis);

  // trackResults를 순회하며 관계 이벤트인 GlissEvent를 marker item으로 변환하고 연결된 anchor를 기록한다.
  for (const trackResult of analysis.trackResults) {
    for (const event of trackResult.events) {
      if (!isGlissEvent(event)) {
        if (isTupletGroupEvent(event)) {
          items.push({
            kind: "tupletContainer",
            rowId: event.containerRowId,
            startTick: timeFractionToNumber(event.time.startTick),
            endTick: timeFractionToNumber(event.time.endTick),
            divNum: event.divNum,
            trackId: event.trackId,
            renderAlpha: getTrackRenderAlpha(activeTrackIds, event.trackId),
          });
        } else if (isTupletExtendGroupEvent(event)) {
          items.push({
            kind: "tupletContainer",
            rowId: event.rowId,
            startTick: timeFractionToNumber(event.time.startTick),
            endTick: timeFractionToNumber(event.time.endTick),
            divNum: null,
            trackId: event.trackId,
            renderAlpha: getTrackRenderAlpha(activeTrackIds, event.trackId),
          });
        }

        continue;
      }

      event.sourceCells.forEach((source) => {
        connectedGlissAnchorKeys.add(createGlissAnchorKey(event.trackId, event.glissId, source));
      });
      items.push({
        kind: "gliss",
        startRowId: event.startDisplay.rowId,
        startCentOffset: event.startDisplay.centOffset,
        startTick: timeFractionToNumber(event.startAnchorTick),
        endRowId: event.endDisplay.rowId,
        endCentOffset: event.endDisplay.centOffset,
        endTick: timeFractionToNumber(event.endAnchorTick),
        hasTrem: hasTremOnStartAnchor(event, noteEvents),
        trackId: event.trackId,
        renderAlpha: getTrackRenderAlpha(activeTrackIds, event.trackId),
      });
    }
  }

  // 연결된 GlissEvent를 만들지 못한 note 내부 gliss anchor는 편집용 orphan marker로 변환한다.
  for (const trackResult of analysis.trackResults) {
    for (const event of trackResult.events) {
      if (!isNoteEvent(event)) {
        continue;
      }

      for (const anchor of event.glissAnchors) {
        const key = createGlissAnchorKey(event.trackId, anchor.glissId, anchor.source);

        if (connectedGlissAnchorKeys.has(key)) {
          continue;
        }

        items.push({
          kind: "glissOrphanAnchor",
          rowId: anchor.display.rowId,
          centOffset: anchor.display.centOffset,
          tick: timeRangeCenterToNumber(anchor.time),
          role: anchor.role,
          trackId: event.trackId,
          renderAlpha: getTrackRenderAlpha(activeTrackIds, event.trackId),
        });
      }
    }
  }

  // marker draw 순서가 입력 순서에 의존하지 않도록 시간과 행 순서로 정렬한다.
  return items.sort((left, right) => {
    const leftTick = getMarkerSortTick(left);
    const rightTick = getMarkerSortTick(right);

    if (leftTick !== rightTick) {
      return leftTick - rightTick;
    }

    const leftRowId = getMarkerSortRowId(left);
    const rightRowId = getMarkerSortRowId(right);

    if (leftRowId !== rightRowId) {
      return leftRowId.localeCompare(rightRowId);
    }
    return getTrackDrawOrder(getMarkerSortTrackId(left)) -
      getTrackDrawOrder(getMarkerSortTrackId(right));
  });
}

/**
 * timing timeline에서 BPM 변화 세로선 marker item을 만든다.
 * - 인수 : analysis : analyzer가 확정한 문서 분석 결과
 * - 반환값 : CanvasMarkerItem[] : BPM 변화 지점 marker 목록
 */
function buildBpmChangeMarkerItems(analysis: AnalysisResult): CanvasMarkerItem[] {
  const items: CanvasMarkerItem[] = [];
  const segments = analysis.timingTimeline
    .map((segment) => ({
      startTick: timeFractionToNumber(segment.time.startTick),
      endTick: timeFractionToNumber(segment.time.endTick),
      startBpm: segment.startBpm,
      endBpm: segment.endBpm,
      curve: segment.bpmCurve,
      startsAtBpmSource: isSegmentStartBpmSource(segment),
    }))
    .sort((left, right) => left.startTick - right.startTick);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];

    if (segment.startTick <= 0 || segment.endTick <= segment.startTick) {
      continue;
    }

    const previous = segments[index - 1];
    const direction = getBpmRampDirection(segment.startBpm, segment.endBpm);
    const startsNewRamp = segment.curve === "linear" &&
      direction !== null &&
      !(
        previous !== undefined &&
        isContinuingBpmRamp(previous, segment, direction)
      );

    if (
      previous !== undefined &&
      isCompletedBpmRampBoundary(previous, segment) &&
      !startsNewRamp
    ) {
      items.push({
        kind: "bpmChange",
        tick: segment.startTick,
        changeKind: "instant",
      });
    }

    if (segment.curve === "linear" && direction !== null) {
      if (!startsNewRamp) {
        continue;
      }

      items.push({
        kind: "bpmChange",
        tick: segment.startTick,
        changeKind: direction,
      });
      continue;
    }

    if (
      previous !== undefined &&
      previous.curve !== "linear" &&
      Math.abs(previous.endBpm - segment.startBpm) >= 1e-9
    ) {
      items.push({
        kind: "bpmChange",
        tick: segment.startTick,
        changeKind: "instant",
      });
    }
  }

  return items;
}

/**
 * dynamics timeline에서 dynamics row 가이드 marker item을 만든다.
 * - 인수 : analysis : analyzer가 확정한 문서 분석 결과
 * - 반환값 : CanvasMarkerItem[] : dynamics 두께 표시 marker 목록
 */
function buildDynamicsGuideMarkerItems(analysis: AnalysisResult): CanvasMarkerItem[] {
  const items: CanvasMarkerItem[] = [];

  for (const segment of analysis.dynamicsTimeline) {
    const rowId = segment.sourceCells[0]?.rowId;
    const startTick = timeFractionToNumber(segment.time.startTick);
    const endTick = timeFractionToNumber(segment.time.endTick);

    if (rowId === undefined || endTick <= startTick) {
      continue;
    }

    items.push({
      kind: "dynamicsGuide",
      rowId,
      startTick,
      endTick,
      startValue: segment.startValue,
      endValue: segment.endValue,
    });
  }

  return items;
}

/**
 * 직전 BPM linear ramp가 현재 segment 시작점에서 종료되는지 확인한다.
 * - 인수 : previous : 직전 timing segment
 * - 인수 : current : 현재 timing segment
 * - 반환값 : ramp 종료 지점 marker를 그릴지 여부
 */
function isCompletedBpmRampBoundary(
  previous: {
    endTick: number;
    startBpm: number;
    endBpm: number;
    curve: "instant" | "linear";
  },
  current: {
    startTick: number;
    startBpm: number;
    endBpm: number;
    curve: "instant" | "linear";
  },
): boolean {
  if (
    previous.curve !== "linear" ||
    previous.endTick !== current.startTick ||
    Math.abs(previous.endBpm - current.startBpm) >= 1e-9
  ) {
    return false;
  }

  const previousDirection = getBpmRampDirection(previous.startBpm, previous.endBpm);
  const currentDirection = getBpmRampDirection(current.startBpm, current.endBpm);

  return previousDirection !== null &&
    (current.curve !== "linear" || currentDirection !== previousDirection);
}

/**
 * BPM segment의 증가/감소 방향을 marker 종류로 변환한다.
 * - 인수 : startBpm : segment 시작 BPM
 * - 인수 : endBpm : segment 종료 BPM
 * - 반환값 : accel/rit 또는 변화가 없으면 null
 */
function getBpmRampDirection(
  startBpm: number,
  endBpm: number,
): "accel" | "rit" | null {
  if (endBpm > startBpm) {
    return "accel";
  }

  if (endBpm < startBpm) {
    return "rit";
  }

  return null;
}

/**
 * 박자/step 경계 때문에 쪼개진 동일 BPM ramp의 후속 segment인지 확인한다.
 * - 인수 : previous : 직전 timing segment
 * - 인수 : current : 현재 timing segment
 * - 인수 : direction : 현재 BPM 변화 방향
 * - 반환값 : 같은 ramp의 연속 segment 여부
 */
function isContinuingBpmRamp(
  previous: {
    endTick: number;
    startBpm: number;
    endBpm: number;
    curve: "instant" | "linear";
  },
  current: {
    startTick: number;
    startBpm: number;
    startsAtBpmSource: boolean | null;
  },
  direction: "accel" | "rit",
): boolean {
  if (current.startsAtBpmSource === true) {
    return false;
  }

  return previous.curve === "linear" &&
    previous.endTick === current.startTick &&
    Math.abs(previous.endBpm - current.startBpm) < 1e-9 &&
    getBpmRampDirection(previous.startBpm, previous.endBpm) === direction;
}

/**
 * timing segment가 실제 BPM ramp 시작 cell에서 시작하는지 확인한다.
 * - 인수 : segment : analyzer가 만든 timing segment
 * - 반환값 : true/false 또는 source cell 정보가 없으면 null
 */
function isSegmentStartBpmSource(
  segment: AnalysisResult["timingTimeline"][number],
): boolean | null {
  const startTick = timeFractionToNumber(segment.time.startTick);
  const firstSourceCell = segment.sourceCells[0];

  if (firstSourceCell === undefined || segment.bpmCurve !== "linear") {
    return null;
  }

  return firstSourceCell.col === startTick;
}

/**
 * timing timeline에서 beat/bar 세로선 marker item을 만든다.
 * - 인수 : analysis : analyzer가 확정한 문서 분석 결과
 * - 반환값 : CanvasMarkerItem[] : score 전체에 그릴 박자선/마디선 목록
 */
function buildTimingLineMarkerItems(analysis: AnalysisResult): CanvasMarkerItem[] {
  const items: CanvasMarkerItem[] = [];
  const sections = buildTimingLineSections(analysis);

  // 박자/step 기준이 유지되는 구간별로 선을 만들고, 같은 tick에서는 bar line을 우선한다.
  for (const section of sections) {
    const beatInterval = section.stepsPerBeat;
    const barInterval = section.beatsPerBar * section.stepsPerBeat;

    if (
      section.endTick <= section.startTick ||
      !isPositiveFiniteNumber(beatInterval) ||
      !isPositiveFiniteNumber(barInterval)
    ) {
      continue;
    }

    const barTicks = collectIntervalTicks(section.startTick, section.endTick, barInterval);
    const barTickKeys = new Set(barTicks.map(createMarkerTickKey));

    for (const tick of barTicks) {
      items.push({
        kind: "bar",
        tick,
      });
    }

    for (const tick of collectIntervalTicks(section.startTick, section.endTick, beatInterval)) {
      if (barTickKeys.has(createMarkerTickKey(tick))) {
        continue;
      }

      items.push({
        kind: "beat",
        tick,
      });
    }
  }

  return items;
}

type TimingLineSection = {
  startTick: number;
  endTick: number;
  beatsPerBar: number;
  stepsPerBeat: number;
};

/**
 * BPM만 다른 timing segment를 박자선/마디선 기준 구간에서 병합한다.
 * - 인수 : analysis : analyzer가 확정한 문서 분석 결과
 * - 반환값 : TimingLineSection[] : 박자/step 값 변화에만 반응하는 표시 구간
 */
function buildTimingLineSections(analysis: AnalysisResult): TimingLineSection[] {
  const sections: TimingLineSection[] = [];

  // BPM 변화는 초 단위 재생 속도만 바꾸므로, 세로선 기준 구간을 나누지 않는다.
  for (const segment of analysis.timingTimeline) {
    const startTick = timeFractionToNumber(segment.time.startTick);
    const endTick = timeFractionToNumber(segment.time.endTick);
    const lastSection = sections[sections.length - 1];

    if (
      lastSection !== undefined &&
      lastSection.endTick === startTick &&
      lastSection.beatsPerBar === segment.beatsPerBar &&
      lastSection.stepsPerBeat === segment.stepsPerBeat
    ) {
      lastSection.endTick = endTick;
      continue;
    }

    sections.push({
      startTick,
      endTick,
      beatsPerBar: segment.beatsPerBar,
      stepsPerBeat: segment.stepsPerBeat,
    });
  }

  return sections;
}

/**
 * segment 시작점 기준 간격으로 marker tick 목록을 만든다.
 * - 인수 : startTick : segment 시작 tick
 * - 인수 : endTick : segment 배타적 끝 tick
 * - 인수 : interval : marker 간격
 * - 반환값 : number[] : segment 안에 포함되는 marker tick 목록
 */
function collectIntervalTicks(
  startTick: number,
  endTick: number,
  interval: number,
): number[] {
  const ticks: number[] = [];

  // endTick은 다음 timing segment가 담당하므로 배타적으로 처리한다.
  for (let tick = startTick; tick < endTick; tick += interval) {
    ticks.push(tick);
  }

  return ticks;
}

/**
 * tick이 marker 간격으로 사용할 수 있는 양수인지 확인한다.
 * - 인수 : value : 검사할 tick 간격
 * - 반환값 : boolean : finite 양수 여부
 */
function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * 부동소수 tick을 중복 제거용 key로 정규화한다.
 * - 인수 : tick : marker tick
 * - 반환값 : string : 같은 위치 판정에 사용할 key
 */
function createMarkerTickKey(tick: number): string {
  return tick.toFixed(6);
}

/**
 * analyzer 결과에서 NoteEvent만 모은다.
 * - 인수 : analysis : analyzer가 확정한 문서 분석 결과
 * - 반환값 : NoteEvent[] : gliss와 trem 겹침 판정에 사용할 note event 목록
 */
function collectNoteEvents(analysis: AnalysisResult): NoteEvent[] {
  const noteEvents: NoteEvent[] = [];

  // 모든 track result를 순회하며 실제 발음 이벤트만 모은다.
  for (const trackResult of analysis.trackResults) {
    for (const event of trackResult.events) {
      if (isNoteEvent(event)) {
        noteEvents.push(event);
      }
    }
  }

  return noteEvents;
}

/**
 * gliss segment 시작 anchor의 note/slot에 trem effect가 있는지 확인한다.
 * - 인수 : glissEvent : marker로 변환할 gliss event
 * - 인수 : noteEvents : 같은 분석 결과 안의 note event 목록
 * - 반환값 : boolean : 시작 anchor가 놓인 구간에 trem이 있는지 여부
 */
function hasTremOnStartAnchor(
  glissEvent: GlissEvent,
  noteEvents: NoteEvent[],
): boolean {
  const startSource = glissEvent.sourceCells[0];

  if (startSource === undefined) {
    return false;
  }

  // trem+gliss 점선은 시작 anchor의 오른쪽 outgoing segment에만 적용한다.
  return noteEvents.some((event) => {
    if (event.trackId !== glissEvent.trackId) {
      return false;
    }

    const startAnchor = event.glissAnchors.find((anchor) =>
      anchor.glissId === glissEvent.glissId &&
      anchor.role === glissEvent.fromKind &&
      sourceCellsMatch(anchor.source, startSource)
    );

    if (startAnchor === undefined) {
      return false;
    }

    const anchorStartTick = timeFractionToNumber(startAnchor.time.startTick);
    const anchorEndTick = timeFractionToNumber(startAnchor.time.endTick);

    return event.effects.some((effect) =>
      effect.trem !== null &&
      effect.trem !== undefined &&
      rangesOverlap(
        anchorStartTick,
        anchorEndTick,
        timeFractionToNumber(effect.time.startTick),
        timeFractionToNumber(effect.time.endTick),
      ),
    );
  });
}

/**
 * 두 source cell 참조가 같은 일반 cell 또는 같은 tuplet slot을 가리키는지 확인한다.
 * - 인수 : left : 왼쪽 source cell 참조
 * - 인수 : right : 오른쪽 source cell 참조
 * - 반환값 : boolean : row/col/slotIndex가 모두 같은지 여부
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
 * - 반환값 : boolean : 두 범위에 공통 구간이 있는지 여부
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
 * gliss anchor 연결 여부 판정에 사용할 key를 만든다.
 * - 인수 : trackId : anchor가 속한 track
 * - 인수 : glissId : gliss 연결 id
 * - 인수 : rowId : anchor 원본 rowId
 * - 인수 : col : anchor 원본 col
 * - 반환값 : 연결 anchor set 조회 key
 */
function createGlissAnchorKey(
  trackId: string,
  glissId: string,
  source: SourceCellRef,
): string {
  return `${trackId}|${glissId}|${source.rowId}|${source.col}|${source.slotIndex ?? ""}`;
}

/**
 * marker item의 정렬 tick을 가져온다.
 * - 인수 : item : 정렬 대상 marker item
 * - 반환값 : number : marker 시간 순서 기준 tick
 */
function getMarkerSortTick(item: CanvasMarkerItem): number {
  if (item.kind === "gliss") {
    return item.startTick;
  }

  if (item.kind === "dynamicsGuide") {
    return item.startTick;
  }

  if (item.kind === "glissOrphanAnchor") {
    return item.tick;
  }

  if (item.kind === "tupletContainer") {
    return item.startTick;
  }

  return item.tick;
}

/**
 * marker item의 정렬 rowId를 가져온다.
 * - 인수 : item : 정렬 대상 marker item
 * - 반환값 : string : marker 행 순서 fallback 기준 rowId
 */
function getMarkerSortRowId(item: CanvasMarkerItem): string {
  if (item.kind === "gliss") {
    return item.startRowId;
  }

  if (item.kind === "dynamicsGuide") {
    return item.rowId;
  }

  if (item.kind === "glissOrphanAnchor") {
    return item.rowId;
  }

  if (item.kind === "tupletContainer") {
    return item.rowId;
  }

  return "";
}

/**
 * marker item의 정렬 trackId를 가져온다.
 * - 인수 : item : 정렬 대상 marker item
 * - 반환값 : string : marker track 순서 fallback 기준 trackId
 */
function getMarkerSortTrackId(item: CanvasMarkerItem): string {
  if (
    item.kind === "gliss" ||
    item.kind === "glissOrphanAnchor" ||
    item.kind === "tupletContainer"
  ) {
    return item.trackId ?? "";
  }

  return "";
}

/**
 * analyzer event를 NoteEvent로 좁힌다.
 * - 인수 : event : analyzer event 후보
 * - 반환값 : boolean : NoteEvent 여부
 */
function isNoteEvent(event: AnalyzedEvent): event is NoteEvent {
  return event.eventKind === "note";
}

/**
 * analyzer event를 GlissEvent로 좁힌다.
 * - 인수 : event : analyzer event 후보
 * - 반환값 : boolean : GlissEvent 여부
 */
function isGlissEvent(event: AnalyzedEvent): event is GlissEvent {
  return event.eventKind === "gliss";
}

/**
 * analyzer event를 MuteEvent로 좁힌다.
 * - 인수 : event : analyzer event 후보
 * - 반환값 : boolean : MuteEvent 여부
 */
function isMuteEvent(event: AnalyzedEvent): event is MuteEvent {
  return event.eventKind === "mute";
}

/**
 * analyzer event를 TupletGroupEvent로 좁힌다.
 * - 인수 : event : analyzer event 후보
 * - 반환값 : boolean : TupletGroupEvent 여부
 */
function isTupletGroupEvent(event: AnalyzedEvent): event is TupletGroupEvent {
  return event.eventKind === "tupletGroup";
}

/**
 * analyzer event를 TupletExtendGroupEvent로 좁힌다.
 * - 인수 : event : analyzer event 후보
 * - 반환값 : boolean : TupletExtendGroupEvent 여부
 */
function isTupletExtendGroupEvent(
  event: AnalyzedEvent,
): event is TupletExtendGroupEvent {
  return event.eventKind === "tupletExtendGroup";
}

/**
 * analyzer 시간 분수를 renderer tick number로 변환한다.
 * - 인수 : value : analyzer TimeFraction 값
 * - 반환값 : number : canvas x 좌표 계산에 사용할 tick 값
 */
function timeFractionToNumber(value: TimeFraction): number {
  return value.numerator / value.denominator;
}

/**
 * TimeRange의 중심 tick을 renderer number tick으로 변환한다.
 * - 인수 : time : analyzer TimeRange 값
 * - 반환값 : number : canvas x 좌표 계산에 사용할 중심 tick 값
 */
function timeRangeCenterToNumber(time: TimeRange): number {
  return (
    timeFractionToNumber(time.startTick) +
    timeFractionToNumber(time.endTick)
  ) / 2;
}
