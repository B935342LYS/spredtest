import assert from "node:assert/strict";
import { runYoutubeLifecycleTests } from "./test_youtube_lifecycle";

import {
  clampYoutubeOffsetMs,
  MAX_YOUTUBE_OFFSET_MS,
  MIN_YOUTUBE_OFFSET_MS,
} from "../src/core/score/score_limits";
import {
  canResumeYoutubeWithoutSeek,
  getEffectiveYoutubeOffsetMs,
  isYoutubeBeforeVideoStart,
  scoreSecondsToRawYoutubeSeconds,
  scoreSecondsToYoutubeSeconds,
  secondsUntilYoutubeStart,
  shouldResyncYoutubeDrift,
} from "../src/app/youtube/youtube_sync";
import { loadYoutubeLocalOffsetMs, saveYoutubeLocalOffsetMs, normalizeYoutubeLocalOffsetMs } from "../src/infra/youtube_preferences";
import { parseYoutubeVideoId } from "../src/app/youtube/youtube_url";

function runYoutubeTests(): void {
  // 합산은 곡 범위를 넘겨도 유지하고, 영상 경계와 drift가 같은 보정을 사용한다.
  assert.equal(getEffectiveYoutubeOffsetMs(60000, 5000), 65000);
  const effective = getEffectiveYoutubeOffsetMs(2000, -200);
  assert.equal(effective, 1800);
  assert.equal(isYoutubeBeforeVideoStart(1.79, effective), true);
  assert.equal(isYoutubeBeforeVideoStart(1.8, effective), false);
  assert.equal(scoreSecondsToYoutubeSeconds(10, -200), 10.2);
  assert.equal(shouldResyncYoutubeDrift(10, 10.2, -200), false);
  assert.equal(normalizeYoutubeLocalOffsetMs(-5001), -5000);
  assert.equal(normalizeYoutubeLocalOffsetMs(5001), 5000);
  assert.equal(normalizeYoutubeLocalOffsetMs(1.4), 1);
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  try {
    assert.equal(loadYoutubeLocalOffsetMs(), 0);
    assert.equal(saveYoutubeLocalOffsetMs(-201), -201);
    assert.equal(loadYoutubeLocalOffsetMs(), -201);
    for (const raw of ["", " ", "oops", "NaN", "Infinity"]) {
      values.set("regression-code:youtube-local-offset-ms", raw);
      assert.equal(loadYoutubeLocalOffsetMs(), 0);
    }
    assert.deepEqual([...values.keys()], ["regression-code:youtube-local-offset-ms"]);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    assert.equal(loadYoutubeLocalOffsetMs(), 0);
    assert.equal(saveYoutubeLocalOffsetMs(201), 201);
  } finally {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  assert.equal(parseYoutubeVideoId("abcDEF_123-"), "abcDEF_123-");
  assert.equal(parseYoutubeVideoId("https://www.youtube.com/watch?v=abcDEF_123-"), "abcDEF_123-");
  assert.equal(parseYoutubeVideoId("https://youtu.be/abcDEF_123-?si=test"), "abcDEF_123-");
  assert.equal(parseYoutubeVideoId("https://www.youtube.com/embed/abcDEF_123-"), "abcDEF_123-");
  assert.equal(parseYoutubeVideoId("https://www.youtube.com/shorts/abcDEF_123-"), "abcDEF_123-");
  assert.equal(parseYoutubeVideoId("not a youtube url"), null);
  assert.equal(parseYoutubeVideoId("https://example.com/watch?v=abcDEF_123-"), null);

  assert.equal(scoreSecondsToYoutubeSeconds(10, -12500), 22.5);
  assert.equal(scoreSecondsToYoutubeSeconds(0.1, 300), 0);
  assert.equal(scoreSecondsToYoutubeSeconds(1, 300), 0.7);
  assert.ok(Math.abs(scoreSecondsToRawYoutubeSeconds(0.1, 300) - -0.2) < 0.000001);
  assert.equal(isYoutubeBeforeVideoStart(0.1, 300), true);
  assert.equal(isYoutubeBeforeVideoStart(0.3, 300), false);
  assert.ok(Math.abs(secondsUntilYoutubeStart(0.1, 300) - 0.2) < 0.000001);
  assert.equal(secondsUntilYoutubeStart(0.3, 300), 0);

  assert.equal(shouldResyncYoutubeDrift(10, 10.2, 0), false);
  assert.equal(shouldResyncYoutubeDrift(10, 10.251, 0), true);
  assert.equal(shouldResyncYoutubeDrift(10, 22.5, -12500), false);
  assert.equal(shouldResyncYoutubeDrift(0.1, 0.25, 300), false);

  // 일시정지 재개만 50ms 이내 위치를 유지하고, 최초 재생·위치 불일치·영상 시작 전에는 seek 경로를 유지한다.
  assert.equal(canResumeYoutubeWithoutSeek(false, 10, 10, 0), false);
  assert.equal(canResumeYoutubeWithoutSeek(true, 10, 10, 0), true);
  assert.equal(canResumeYoutubeWithoutSeek(true, 10, 10.02, 0), true);
  assert.equal(canResumeYoutubeWithoutSeek(true, 0, 0.05, 0), true);
  assert.equal(canResumeYoutubeWithoutSeek(true, 10, 10.051, 0), false);
  assert.equal(canResumeYoutubeWithoutSeek(true, 10, 22.5, -12500), true);
  assert.equal(canResumeYoutubeWithoutSeek(true, 1, 0.7, 300), true);
  assert.equal(canResumeYoutubeWithoutSeek(true, 0.1, 0, 300), false);
  assert.equal(canResumeYoutubeWithoutSeek(true, NaN, 10, 0), false);
  assert.equal(canResumeYoutubeWithoutSeek(true, 10, Infinity, 0), false);
  assert.equal(canResumeYoutubeWithoutSeek(true, 10, 10, NaN), false);

  assert.equal(clampYoutubeOffsetMs(MIN_YOUTUBE_OFFSET_MS - 1), MIN_YOUTUBE_OFFSET_MS);
  assert.equal(clampYoutubeOffsetMs(MAX_YOUTUBE_OFFSET_MS + 1), MAX_YOUTUBE_OFFSET_MS);
  assert.equal(clampYoutubeOffsetMs(123.9), 123);
}

runYoutubeTests();
await runYoutubeLifecycleTests();
console.log("test_youtube passed");
