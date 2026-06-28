/**
 * canvas renderer 내부에서 공유하는 색상과 치수 상수를 정의한다.
 */

/**
 * renderer 공통 색상 상수.
 * - 인수 : 없음
 * - 반환값 : canvas layer별 draw 함수가 공유하는 CSS 색상 문자열 묶음
 */
export const CANVAS_COLORS = {
  rollBackground: "#525252",
  noteRowBackground: "#646464",
  gridSoft: "rgba(255,255,255,0.12)",
  gridVertical: "rgba(0,0,0,0.18)",
  labelText: "rgba(255,255,255,0.92)",
  noteLabelText: "rgba(255,255,255,0.95)",
  labelLine: "rgba(255,255,255,0.18)",
  playbackBoundary: "rgba(255,80,80,0.35)",
  noteStroke: "rgba(255,255,255,0.22)",
  extraNoteStroke: "rgba(255,255,255,0.92)",
  noteText: "#000000",
  extraNoteText: "#ffffff",
  muteText: "#ffffff",
  globalText: "#ffffff",
  beatLine: "rgba(255,255,255,0.46)",
  barLine: "rgba(255,255,255,0.68)",
  bpmInstantLine: "rgba(96,200,255,0.45)",
  bpmAccelLine: "rgba(255,80,80,0.45)",
  bpmRitLine: "rgba(80,220,130,0.45)",
  dynamicsGuide: "rgba(220,220,220,0.45)",
  extraNoteFill: "#000000",
  vibWave: "rgba(0,0,0,0.62)",
  extraVibWave: "rgba(255,255,255,0.82)",
  glissLine: "rgba(255,255,255,0.92)",
  extraGlissLine: "rgba(255,255,255,0.96)",
  tupletContainer: "rgba(190,220,255,0.95)",
  tupletLabel: "rgba(255,255,255,0.96)",
} as const;

/**
 * renderer 공통 치수 상수.
 * - 인수 : 없음
 * - 반환값 : canvas 좌표/크기 계산에 사용하는 기준 px 값 묶음
 */
export const CANVAS_METRICS = {
  baseLayoutLabelWidth: 100,
  baseLayoutPaddingWidth: 21,
  baseLayoutFontSize: 12,
  baseNoteRenderHeight: 21,
  noteInsetX: 1,
  minNoteWidth: 1,
  minNoteHeight: 1,
  tremoloChopLineWidth: 2,
  glissLineWidth: 2,
  beatLineWidth: 1.5,
  barLineWidth: 2,
  bpmChangeLineWidth: 3,
  muteTextFontSizePx: 21,
  globalTextFontSizePx: 12,
  tupletContainerLineWidth: 1,
  tupletLabelFontSizePx: 10,
  vibWaveLineWidth: 1.5,
  vibWaveMinSampleCount: 48,
  vibWaveSamplesPerCycle: 28,
  vibWavePixelsPerSample: 2,
} as const;
