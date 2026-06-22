/**
 * src/audio/audio_event_queue.ts
 * lookahead scheduler가 초 단위 범위로 audio schedule event를 조회할 수 있게 한다.
 */

import type {
  AudioEventQueue,
  AudioSchedule,
  AudioScheduleEvent,
} from "./audio_types";

/**
 * AudioSchedule에서 시간 범위 조회용 event queue를 만든다.
 * - 인수 : schedule : 초 단위로 정규화된 audio schedule
 * - 반환값 : AudioEventQueue : lookahead 범위 조회 인터페이스
 */
export function createAudioEventQueue(schedule: AudioSchedule): AudioEventQueue {
  const events = [...schedule.events].sort(compareAudioScheduleEvents);

  return {
    getEventsStartingInRange(startSeconds: number, endSeconds: number): AudioScheduleEvent[] {
      validateRange(startSeconds, endSeconds);

      // scheduler 반복 조회에서 같은 긴 note를 계속 반환하지 않도록 startSeconds 기준으로만 찾는다.
      return events.filter((event) =>
        event.startSeconds >= startSeconds && event.startSeconds < endSeconds,
      );
    },
    getEventsOverlappingRange(startSeconds: number, endSeconds: number): AudioScheduleEvent[] {
      validateRange(startSeconds, endSeconds);

      // seek 직후처럼 이미 시작했지만 아직 끝나지 않은 긴 note를 복구할 때 사용한다.
      return events.filter((event) =>
        event.endSeconds > startSeconds && event.startSeconds < endSeconds,
      );
    },
    getEventCount(): number {
      return events.length;
    },
  };
}

/**
 * lookahead 조회 범위가 유효한지 확인한다.
 * - 인수 : startSeconds : 조회 시작 초
 * - 인수 : endSeconds : 조회 끝 초
 * - 반환값 : 없음
 */
function validateRange(startSeconds: number, endSeconds: number): void {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    throw new Error("Audio event queue range must be finite.");
  }

  if (endSeconds < startSeconds) {
    throw new Error("Audio event queue endSeconds must be greater than or equal to startSeconds.");
  }
}

/**
 * audio schedule event를 시간순으로 정렬한다.
 * - 인수 : left : 왼쪽 event
 * - 인수 : right : 오른쪽 event
 * - 반환값 : 정렬 비교값
 */
function compareAudioScheduleEvents(
  left: AudioScheduleEvent,
  right: AudioScheduleEvent,
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
