/**
 * src/audio/tick_time_mapper.ts
 * analyzer timing timeline을 audio scheduler가 쓰는 초 단위 score time으로 변환한다.
 */

import type {
  AnalyzedTimeSegment,
  TimeFraction,
} from "../core/analyze/types";
import type {
  TempoMapSegment,
  TickTimeMapper,
} from "./audio_types";

const EPSILON = 1e-9;

/**
 * timing timeline에서 BPM 보간을 반영한 TickTimeMapper를 만든다.
 * - 인수 : segments : analyzer가 생성한 timing segment 목록
 * - 반환값 : TickTimeMapper : tick/seconds 양방향 변환기
 */
export function createTickTimeMapper(
  segments: AnalyzedTimeSegment[],
): TickTimeMapper {
  const mapSegments = buildTempoMapSegments(segments);
  const durationSeconds = mapSegments.length === 0
    ? 0
    : mapSegments[mapSegments.length - 1].endSeconds;

  return {
    tickToSeconds(tick: TimeFraction): number {
      const tickNumber = timeFractionToNumber(tick);
      const segment = findSegmentByTick(mapSegments, tickNumber);

      return segment.startSeconds +
        tickOffsetToSeconds(segment, tickNumber - segment.startTickNumber);
    },
    secondsToTick(seconds: number): TimeFraction {
      const normalizedSeconds = clampSeconds(seconds, durationSeconds);
      const segment = findSegmentBySeconds(mapSegments, normalizedSeconds);
      const tickOffset = secondsOffsetToTick(segment, normalizedSeconds - segment.startSeconds);

      return numberToTimeFraction(segment.startTickNumber + tickOffset);
    },
    getDurationSeconds(): number {
      return durationSeconds;
    },
  };
}

/**
 * TimeFraction을 number tick으로 변환한다.
 * - 인수 : value : analyzer 시간 분수
 * - 반환값 : number : numerator / denominator
 */
export function timeFractionToNumber(value: TimeFraction): number {
  if (value.denominator === 0) {
    throw new Error("TimeFraction denominator must not be 0.");
  }

  return value.numerator / value.denominator;
}

/**
 * number tick을 TimeFraction으로 변환한다.
 * - 인수 : value : number tick
 * - 반환값 : TimeFraction : audio mapper가 반환할 시간 분수
 */
export function numberToTimeFraction(value: number): TimeFraction {
  if (!Number.isFinite(value)) {
    throw new Error("Tick value must be a finite number.");
  }

  const roundedInteger = Math.round(value);

  if (Math.abs(value - roundedInteger) < EPSILON) {
    return {
      numerator: roundedInteger,
      denominator: 1,
    };
  }

  const denominator = 1_000_000;
  const numerator = Math.round(value * denominator);
  const divisor = gcd(Math.abs(numerator), denominator);

  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

/**
 * timing segment 목록을 시작 초가 누적된 tempo segment 목록으로 바꾼다.
 * - 인수 : segments : analyzer timing segment 목록
 * - 반환값 : TempoMapSegment[] : tick/seconds 변환용 segment 목록
 */
function buildTempoMapSegments(
  segments: AnalyzedTimeSegment[],
): TempoMapSegment[] {
  const sortedSegments = [...segments].sort(
    (left, right) =>
      timeFractionToNumber(left.time.startTick) -
      timeFractionToNumber(right.time.startTick),
  );
  const result: TempoMapSegment[] = [];
  let nextStartSeconds = 0;

  // timing segment마다 누적 시작 초와 BPM 보간 정보를 계산해 변환 lookup 단위를 만든다.
  for (const segment of sortedSegments) {
    validateTempoSegment(segment);

    const startTickNumber = timeFractionToNumber(segment.time.startTick);
    const endTickNumber = timeFractionToNumber(segment.time.endTick);
    const mapSegment: TempoMapSegment = {
      source: segment,
      startTickNumber,
      endTickNumber,
      startSeconds: nextStartSeconds,
      endSeconds: nextStartSeconds,
      startBpm: segment.startBpm,
      endBpm: segment.endBpm,
      bpmCurve: segment.bpmCurve,
      stepsPerBeat: segment.stepsPerBeat,
    };
    const durationSeconds = tickOffsetToSeconds(
      mapSegment,
      endTickNumber - startTickNumber,
    );

    mapSegment.endSeconds = nextStartSeconds + durationSeconds;
    result.push(mapSegment);
    nextStartSeconds = mapSegment.endSeconds;
  }

  return result;
}

/**
 * timing segment가 audio mapper에 사용할 수 있는 값인지 확인한다.
 * - 인수 : segment : 검사할 analyzer timing segment
 * - 반환값 : 없음
 */
function validateTempoSegment(segment: AnalyzedTimeSegment): void {
  const startTickNumber = timeFractionToNumber(segment.time.startTick);
  const endTickNumber = timeFractionToNumber(segment.time.endTick);

  if (endTickNumber < startTickNumber) {
    throw new Error("Timing segment endTick must be greater than or equal to startTick.");
  }

  if (segment.startBpm <= 0 || segment.endBpm <= 0) {
    throw new Error("Timing segment BPM must be greater than 0.");
  }

  if (segment.stepsPerBeat <= 0) {
    throw new Error("Timing segment stepsPerBeat must be greater than 0.");
  }

  if (segment.bpmCurve !== "instant" && segment.bpmCurve !== "linear") {
    throw new Error("Unsupported timing segment BPM curve.");
  }
}

/**
 * segment 내부 tick offset을 초 offset으로 변환한다.
 * - 인수 : segment : 정규화된 tempo segment
 * - 인수 : tickOffset : segment 시작점 기준 tick offset
 * - 반환값 : number : segment 시작점 기준 seconds offset
 */
function tickOffsetToSeconds(
  segment: TempoMapSegment,
  tickOffset: number,
): number {
  validateFiniteOffset(tickOffset, "tickOffset");

  const durationTicks = segment.endTickNumber - segment.startTickNumber;

  if (
    segment.bpmCurve === "instant" ||
    Math.abs(segment.endBpm - segment.startBpm) < EPSILON ||
    durationTicks === 0
  ) {
    return tickOffset * getConstantSecondsPerTick(segment.startBpm, segment.stepsPerBeat);
  }

  const bpmSlopePerTick = (segment.endBpm - segment.startBpm) / durationTicks;
  const endBpmAtOffset = segment.startBpm + bpmSlopePerTick * tickOffset;

  return (60 / segment.stepsPerBeat / bpmSlopePerTick) *
    Math.log(endBpmAtOffset / segment.startBpm);
}

/**
 * segment 내부 seconds offset을 tick offset으로 역변환한다.
 * - 인수 : segment : 정규화된 tempo segment
 * - 인수 : secondsOffset : segment 시작점 기준 seconds offset
 * - 반환값 : number : segment 시작점 기준 tick offset
 */
function secondsOffsetToTick(
  segment: TempoMapSegment,
  secondsOffset: number,
): number {
  validateFiniteOffset(secondsOffset, "secondsOffset");

  const durationTicks = segment.endTickNumber - segment.startTickNumber;

  if (
    segment.bpmCurve === "instant" ||
    Math.abs(segment.endBpm - segment.startBpm) < EPSILON ||
    durationTicks === 0
  ) {
    return secondsOffset / getConstantSecondsPerTick(segment.startBpm, segment.stepsPerBeat);
  }

  const bpmSlopePerTick = (segment.endBpm - segment.startBpm) / durationTicks;
  const exponent = secondsOffset * segment.stepsPerBeat * bpmSlopePerTick / 60;

  return (segment.startBpm * (Math.exp(exponent) - 1)) / bpmSlopePerTick;
}

/**
 * constant BPM에서 한 tick의 초 길이를 계산한다.
 * - 인수 : bpm : BPM 값
 * - 인수 : stepsPerBeat : 1 beat당 tick 수
 * - 반환값 : number : seconds per tick
 */
function getConstantSecondsPerTick(bpm: number, stepsPerBeat: number): number {
  return 60 / bpm / stepsPerBeat;
}

/**
 * offset 계산 입력이 유한한 값인지 확인한다.
 * - 인수 : value : 검사할 값
 * - 인수 : label : 오류 메시지에 사용할 이름
 * - 반환값 : 없음
 */
function validateFiniteOffset(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

/**
 * tick 위치를 포함하는 timing segment를 찾는다.
 * - 인수 : segments : 정규화된 timing segment 목록
 * - 인수 : tickNumber : 조회할 tick number
 * - 반환값 : tick을 포함하는 segment
 */
function findSegmentByTick(
  segments: TempoMapSegment[],
  tickNumber: number,
): TempoMapSegment {
  if (segments.length === 0) {
    throw new Error("TickTimeMapper requires at least one timing segment.");
  }

  // segment 끝 tick은 다음 segment 시작으로 취급하되, 문서 끝 tick은 마지막 segment에 포함한다.
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLastSegment = index === segments.length - 1;

    if (
      tickNumber >= segment.startTickNumber &&
      (tickNumber < segment.endTickNumber ||
        (isLastSegment && tickNumber === segment.endTickNumber))
    ) {
      return segment;
    }
  }

  if (tickNumber < segments[0].startTickNumber) {
    return segments[0];
  }

  return segments[segments.length - 1];
}

/**
 * 초 위치를 포함하는 timing segment를 찾는다.
 * - 인수 : segments : 정규화된 timing segment 목록
 * - 인수 : seconds : 조회할 score seconds
 * - 반환값 : seconds를 포함하는 segment
 */
function findSegmentBySeconds(
  segments: TempoMapSegment[],
  seconds: number,
): TempoMapSegment {
  if (segments.length === 0) {
    throw new Error("TickTimeMapper requires at least one timing segment.");
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLastSegment = index === segments.length - 1;

    if (
      seconds >= segment.startSeconds &&
      (seconds < segment.endSeconds ||
        (isLastSegment && seconds === segment.endSeconds))
    ) {
      return segment;
    }
  }

  return seconds < segments[0].startSeconds
    ? segments[0]
    : segments[segments.length - 1];
}

/**
 * score seconds를 문서 길이 범위로 제한한다.
 * - 인수 : seconds : 제한할 초 단위 위치
 * - 인수 : durationSeconds : 문서 전체 길이
 * - 반환값 : 0 이상 durationSeconds 이하의 seconds
 */
function clampSeconds(seconds: number, durationSeconds: number): number {
  if (!Number.isFinite(seconds)) {
    throw new Error("Score seconds must be a finite number.");
  }

  return Math.min(Math.max(seconds, 0), durationSeconds);
}

/**
 * 두 정수의 최대공약수를 구한다.
 * - 인수 : left : 첫 번째 정수
 * - 인수 : right : 두 번째 정수
 * - 반환값 : 최대공약수
 */
function gcd(left: number, right: number): number {
  let a = left;
  let b = right;

  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }

  return a || 1;
}
