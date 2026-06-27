/**
 * 브라우저 런타임 성능 병목 탐색용 lightweight profiler를 제공한다.
 */

export type PerfMeasureRecord = {
  label: string;
  durationMs: number;
  depth: number;
};

export type PerfMeasureSummary = {
  label: string;
  totalMs: number;
  count: number;
  maxMs: number;
};

type PerfSession = {
  name: string;
  startMs: number;
  records: PerfMeasureRecord[];
  depth: number;
};

type PerfProfilerConsoleApi = {
  enable(): void;
  disable(): void;
  isEnabled(): boolean;
};

declare global {
  interface Window {
    spredPerf?: PerfProfilerConsoleApi;
  }
}

const PERF_QUERY_PARAM = "perf";
const PERF_LOCAL_STORAGE_KEY = "spred:perf";
const DEFAULT_LOG_THRESHOLD_MS = 0.25;

let isPerfEnabledCache: boolean | null = null;
let activeSession: PerfSession | null = null;

/**
 * 성능 계측이 켜져 있는지 확인한다.
 * - 인수 : 없음
 * - 반환값 : `?perf=1` 또는 localStorage flag가 켜져 있으면 true
 */
export function isPerfProfilerEnabled(): boolean {
  if (isPerfEnabledCache !== null) {
    return isPerfEnabledCache;
  }

  if (typeof window === "undefined") {
    isPerfEnabledCache = false;
    return isPerfEnabledCache;
  }

  const url = new URL(window.location.href);
  const queryValue = url.searchParams.get(PERF_QUERY_PARAM);

  if (queryValue === "1" || queryValue === "true") {
    isPerfEnabledCache = true;
    return isPerfEnabledCache;
  }

  try {
    isPerfEnabledCache = window.localStorage.getItem(PERF_LOCAL_STORAGE_KEY) === "1";
  } catch {
    isPerfEnabledCache = false;
  }

  return isPerfEnabledCache;
}

/**
 * 성능 계측 session을 시작한다.
 * - 인수 : name : console 출력에서 구분할 session 이름
 * - 반환값 : profiler가 꺼져 있으면 null, 켜져 있으면 session 객체
 */
export function beginPerfSession(name: string): PerfSession | null {
  if (!isPerfProfilerEnabled()) {
    return null;
  }

  const session: PerfSession = {
    name,
    startMs: nowMs(),
    records: [],
    depth: 0,
  };

  activeSession = session;
  return session;
}

/**
 * 현재 진행 중인 profiler session이 있는지 확인한다.
 * - 인수 : 없음
 * - 반환값 : active session 존재 여부
 */
export function hasActivePerfSession(): boolean {
  return activeSession !== null;
}

/**
 * 현재 성능 계측 session을 끝내고 console에 요약을 출력한다.
 * - 인수 : session : `beginPerfSession()`이 반환한 session
 * - 반환값 : 없음
 */
export function endPerfSession(
  session: PerfSession | null,
  options: {
    minTotalMs?: number;
  } = {},
): void {
  if (session === null || activeSession !== session) {
    return;
  }

  activeSession = null;

  const totalMs = nowMs() - session.startMs;

  if (options.minTotalMs !== undefined && totalMs < options.minTotalMs) {
    return;
  }

  const records = session.records
    .filter((record) => record.durationMs >= DEFAULT_LOG_THRESHOLD_MS)
    .map((record) => ({
      step: `${"  ".repeat(record.depth)}${record.label}`,
      ms: roundDuration(record.durationMs),
    }));
  const summary = summarizePerfRecords(session.records)
    .filter((record) => record.totalMs >= DEFAULT_LOG_THRESHOLD_MS)
    .map((record) => ({
      step: record.label,
      totalMs: roundDuration(record.totalMs),
      count: record.count,
      maxMs: roundDuration(record.maxMs),
    }));

  // 병목 후보를 한눈에 볼 수 있도록 session별 상세와 label별 합산을 함께 출력한다.
  console.groupCollapsed(`[perf] ${session.name}: ${roundDuration(totalMs)} ms`);
  if (records.length > 0) {
    console.table(records);
  }
  if (summary.length > 0) {
    console.table(summary);
  }
  console.groupEnd();
}

/**
 * 함수 실행 시간을 현재 profiler session에 기록한다.
 * - 인수 : label : 측정 구간 이름
 * - 인수 : callback : 측정할 동기 함수
 * - 반환값 : callback 반환값
 */
export function measurePerf<T>(label: string, callback: () => T): T {
  const session = activeSession;

  if (session === null) {
    return callback();
  }

  const depth = session.depth;
  const startMs = nowMs();

  session.depth += 1;

  try {
    return callback();
  } finally {
    session.depth = depth;
    session.records.push({
      label,
      durationMs: nowMs() - startMs,
      depth,
    });
  }
}

/**
 * async 함수 실행 시간을 현재 profiler session에 기록한다.
 * - 인수 : label : 측정 구간 이름
 * - 인수 : callback : 측정할 async 함수
 * - 반환값 : callback 반환값 Promise
 */
export async function measurePerfAsync<T>(label: string, callback: () => Promise<T>): Promise<T> {
  const session = activeSession;

  if (session === null) {
    return callback();
  }

  const depth = session.depth;
  const startMs = nowMs();

  session.depth += 1;

  try {
    return await callback();
  } finally {
    session.depth = depth;
    session.records.push({
      label,
      durationMs: nowMs() - startMs,
      depth,
    });
  }
}

/**
 * profiler flag cache를 지운다.
 * - 인수 : 없음
 * - 반환값 : 없음
 */
export function resetPerfProfilerFlagCache(): void {
  isPerfEnabledCache = null;
}

/**
 * 브라우저 console에서 profiler를 켜고 끌 수 있는 API를 설치한다.
 * - 인수 : 없음
 * - 반환값 : 없음
 */
export function installPerfProfilerConsoleApi(): void {
  if (typeof window === "undefined" || window.spredPerf !== undefined) {
    return;
  }

  window.spredPerf = {
    enable(): void {
      try {
        window.localStorage.setItem(PERF_LOCAL_STORAGE_KEY, "1");
      } catch {
        console.warn("[perf] localStorage is unavailable. Use ?perf=1 in the URL instead.");
      }
      resetPerfProfilerFlagCache();
      console.info("[perf] enabled. Reload or continue interacting to collect measurements.");
    },
    disable(): void {
      try {
        window.localStorage.removeItem(PERF_LOCAL_STORAGE_KEY);
      } catch {
        console.warn("[perf] localStorage is unavailable.");
      }
      resetPerfProfilerFlagCache();
      console.info("[perf] disabled.");
    },
    isEnabled(): boolean {
      resetPerfProfilerFlagCache();
      return isPerfProfilerEnabled();
    },
  };
}

/**
 * browser/node 환경 모두에서 쓸 수 있는 현재 시각 ms를 반환한다.
 * - 인수 : 없음
 * - 반환값 : monotonic time에 가까운 ms 값
 */
function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

/**
 * 같은 label의 측정값을 합산한다.
 * - 인수 : records : session 안에 쌓인 측정 기록
 * - 반환값 : label별 합산 측정값
 */
function summarizePerfRecords(records: readonly PerfMeasureRecord[]): PerfMeasureSummary[] {
  const summaryByLabel = new Map<string, PerfMeasureSummary>();

  for (const record of records) {
    const previous = summaryByLabel.get(record.label);

    if (previous === undefined) {
      summaryByLabel.set(record.label, {
        label: record.label,
        totalMs: record.durationMs,
        count: 1,
        maxMs: record.durationMs,
      });
      continue;
    }

    previous.totalMs += record.durationMs;
    previous.count += 1;
    previous.maxMs = Math.max(previous.maxMs, record.durationMs);
  }

  return [...summaryByLabel.values()].sort((left, right) => right.totalMs - left.totalMs);
}

/**
 * console 표시에 사용할 소수점 2자리 duration을 만든다.
 * - 인수 : durationMs : 원본 ms 값
 * - 반환값 : 반올림된 ms 값
 */
function roundDuration(durationMs: number): number {
  return Math.round(durationMs * 100) / 100;
}
