/**
 * canvas renderer 성능 측정용 debug hook을 제공한다.
 */

type CanvasPerformanceSample = {
  phase: string;
  durationMs: number;
  atMs: number;
  meta?: Record<string, number | string | boolean>;
};

/** 성능 측정 summary에서 phase별 집계를 나타낸다. */
export type CanvasPerformanceSummaryItem = {
  phase: string;
  count: number;
  totalMs: number;
  averageMs: number;
  maxMs: number;
  lastMs: number;
};

/** 브라우저 콘솔에 노출할 성능 측정 debug API. */
export type CanvasPerformanceDebugApi = {
  enable(): void;
  disable(): void;
  reset(): void;
  summary(): CanvasPerformanceSummaryItem[];
  dump(): CanvasPerformanceSample[];
};

declare global {
  interface Window {
    spredPerf?: CanvasPerformanceDebugApi;
  }
}

const MAX_SAMPLE_COUNT = 3000;

let isEnabled = false;
const samples: CanvasPerformanceSample[] = [];

/**
 * canvas 성능 측정이 켜져 있는지 반환한다.
 * - 인수 : 없음
 * - 반환값 : 성능 측정 활성 여부
 */
export function isCanvasPerformanceEnabled(): boolean {
  return isEnabled;
}

/**
 * callback 실행 시간을 지정한 phase 이름으로 기록한다.
 * - 인수 : phase : 측정 구간 이름
 * - 인수 : callback : 측정할 동작
 * - 반환값 : callback의 반환값
 */
export function measureCanvasPerformance<T>(phase: string, callback: () => T): T {
  if (!isEnabled) {
    return callback();
  }

  const startedAt = performance.now();

  try {
    return callback();
  } finally {
    recordCanvasPerformance(phase, startedAt);
  }
}

/**
 * 이미 시작 시간을 알고 있는 성능 측정값을 기록한다.
 * - 인수 : phase : 측정 구간 이름
 * - 인수 : startedAt : performance.now() 기준 시작 시각
 * - 인수 : meta : 측정 해석에 필요한 선택적 숫자/문자/boolean 정보
 * - 반환값 : 없음
 */
export function recordCanvasPerformance(
  phase: string,
  startedAt: number,
  meta?: Record<string, number | string | boolean>,
): void {
  if (!isEnabled) {
    return;
  }

  const now = performance.now();

  samples.push({
    phase,
    durationMs: now - startedAt,
    atMs: now,
    meta,
  });

  if (samples.length > MAX_SAMPLE_COUNT) {
    samples.splice(0, samples.length - MAX_SAMPLE_COUNT);
  }
}

/**
 * 브라우저 window에 성능 측정 debug API를 설치한다.
 * - 인수 : targetWindow : debug API를 노출할 window 객체
 * - 반환값 : 없음
 */
export function installCanvasPerformanceDebugTools(targetWindow: Window): void {
  targetWindow.spredPerf = {
    enable(): void {
      isEnabled = true;
      samples.length = 0;
      console.info("spredPerf enabled. Scroll the score, then run spredPerf.summary().");
    },
    disable(): void {
      isEnabled = false;
      console.info("spredPerf disabled.");
    },
    reset(): void {
      samples.length = 0;
      console.info("spredPerf samples reset.");
    },
    summary(): CanvasPerformanceSummaryItem[] {
      const summary = summarizeCanvasPerformance();

      console.table(summary);
      return summary;
    },
    dump(): CanvasPerformanceSample[] {
      const copiedSamples = samples.slice();

      console.table(copiedSamples);
      return copiedSamples;
    },
  };
}

/**
 * 현재까지 수집된 성능 측정값을 phase별 summary로 변환한다.
 * - 인수 : 없음
 * - 반환값 : phase별 count/평균/최대/합계/마지막 duration
 */
function summarizeCanvasPerformance(): CanvasPerformanceSummaryItem[] {
  const summaryByPhase = new Map<string, CanvasPerformanceSummaryItem>();

  // sample을 순회하며 phase별 누적 시간과 최대 시간을 계산한다.
  for (const sample of samples) {
    const current = summaryByPhase.get(sample.phase);

    if (current === undefined) {
      summaryByPhase.set(sample.phase, {
        phase: sample.phase,
        count: 1,
        totalMs: sample.durationMs,
        averageMs: sample.durationMs,
        maxMs: sample.durationMs,
        lastMs: sample.durationMs,
      });
      continue;
    }

    current.count += 1;
    current.totalMs += sample.durationMs;
    current.averageMs = current.totalMs / current.count;
    current.maxMs = Math.max(current.maxMs, sample.durationMs);
    current.lastMs = sample.durationMs;
  }

  return Array.from(summaryByPhase.values())
    .map((item) => ({
      phase: item.phase,
      count: item.count,
      totalMs: roundMetric(item.totalMs),
      averageMs: roundMetric(item.averageMs),
      maxMs: roundMetric(item.maxMs),
      lastMs: roundMetric(item.lastMs),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * 콘솔 출력용 성능 숫자를 읽기 쉬운 소수점 3자리로 반올림한다.
 * - 인수 : value : 반올림할 성능 측정값
 * - 반환값 : 소수점 3자리 숫자
 */
function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
