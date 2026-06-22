/**
 * src/app/playback/app_note_preview.ts
 * score 입력 중 터치한 note row를 짧은 oscillator preview로 들려준다.
 */

import type { AudioScheduleEvent } from "../../audio/audio_types";
import { createOscillatorBackend } from "../../audio/oscillator_backend";
import type { AppDom } from "../app_types";

const PREVIEW_DURATION_SECONDS = 0.12;
const PREVIEW_VOLUME_SCALE = 0.65;
const PREVIEW_MIN_INTERVAL_MS = 60;

/** note row 입력 preview runtime 계약. */
export type AppNotePreviewRuntime = {
  previewMidi(midi: number): void;
  dispose(): void;
};

/**
 * 현재 UI 파형/볼륨 설정으로 note preview runtime을 만든다.
 * - 인수 : dom : preview 설정을 읽을 DOM 묶음
 * - 반환값 : AppNotePreviewRuntime : 짧은 note preview 실행 객체
 */
export function createAppNotePreviewRuntime(dom: AppDom): AppNotePreviewRuntime {
  const backend = createOscillatorBackend({
    waveType: dom.waveSelect.value as OscillatorType,
    masterVolume: (Number(dom.volumeInput.value) / 100) * PREVIEW_VOLUME_SCALE,
    attackSeconds: 0.003,
    releaseSeconds: 0.035,
  });
  let lastPreviewAtMs = 0;

  return {
    previewMidi(midi: number): void {
      const nowMs = performance.now();

      if (!Number.isFinite(midi)) {
        return;
      }
      if (nowMs - lastPreviewAtMs < PREVIEW_MIN_INTERVAL_MS) {
        return;
      }

      lastPreviewAtMs = nowMs;

      // 입력 preview는 짧은 단발음이므로 이전 음은 release에 맡기고 새 음을 최소 간격으로 제한한다.
      backend.ensureStarted()
        .then(() => {
          backend.scheduleEvent(createPreviewScheduleEvent(midi), 0);
        })
        .catch(() => {
          // 브라우저가 AudioContext 생성을 거부한 경우 입력 동작 자체는 막지 않는다.
        });
    },
    dispose(): void {
      backend.dispose();
    },
  };
}

/**
 * MIDI preview용 최소 audio schedule event를 만든다.
 * - 인수 : midi : 들려줄 note row MIDI 번호
 * - 반환값 : AudioScheduleEvent : oscillator backend가 재생할 단발 이벤트
 */
function createPreviewScheduleEvent(midi: number): AudioScheduleEvent {
  return {
    eventId: `preview:${midi}:${Date.now()}`,
    trackId: "basic",
    startTick: {
      numerator: 0,
      denominator: 1,
    },
    endTick: {
      numerator: 1,
      denominator: 1,
    },
    startSeconds: 0,
    endSeconds: PREVIEW_DURATION_SECONDS,
    midi,
    centOffset: 0,
    velocity: 1,
    effects: [],
    automation: [],
    sourceEventKind: "note",
  };
}
