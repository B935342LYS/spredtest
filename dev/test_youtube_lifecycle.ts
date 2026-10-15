import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyYoutubeSyncEditToState, createInitialState } from "../src/app/app_runtime";
import type { AppDom } from "../src/app/app_types";
import type { AppPlaybackRuntime } from "../src/app/playback/app_playback";
import { bindYoutubeControls } from "../src/app/youtube/youtube_binding";
import { createYoutubePlayer, loadYoutubeIframeApi } from "../src/app/youtube/youtube_player";
import type { YoutubePlayerHandle } from "../src/app/youtube/youtube_types";
import { loadRuntimeDocument } from "../src/core/score/create_runtime_document";

/** 이벤트·소유 DOM 정리에 필요한 최소 요소 대역. */
class ElementStub extends EventTarget {
  value = ""; checked = false; hidden = false; textContent = ""; title = "";
  dataset: Record<string, string> = {}; style: Record<string, string> = {};
  attributes: Record<string, string> = {}; children: ElementStub[] = [];
  parent: ElementStub | null = null;
  onerror: (() => void) | null = null;
  /** 속성을 기록한다. - 인수 : key, value : 속성 - 반환값 : 없음 */
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  /** 자식 포함 여부. - 인수 : target : 대상 - 반환값 : 포함 여부 */
  contains(target: unknown): boolean { return target === this || this.children.some(child => child.contains(target)); }
  /** 자식을 연결한다. - 인수 : child : 대상 - 반환값 : 없음 */
  append(child: ElementStub): void { child.parent = this; this.children.push(child); }
  /** 소유 부모에서 제거한다. - 인수 : 없음 - 반환값 : 없음 */
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  /** 포커스를 옮긴다. - 인수 : 없음 - 반환값 : 없음 */
  focus(): void { fakeDocument.activeElement = this; }
}
const fakeDocument = { activeElement: null as ElementStub | null, head: new ElementStub(),
  createElement: (): ElementStub => new ElementStub() };
/** 다음 비동기 요청까지 진행한다. - 인수 : 없음 - 반환값 : 대기 완료 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));
/** change/Enter 대역을 전달한다. - 인수 : element, type, composing : 입력 이벤트 - 반환값 : 없음 */
function dispatch(element: ElementStub, type = "change", composing = false): void {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { key: "Enter", isComposing: composing });
  element.dispatchEvent(event);
}

/**
 * 실제 metadata/binding을 대역 player와 연결해 경합·상태 보존을 검증한다.
 * - 인수 : 없음
 * - 반환값 : 검증 완료
 */
async function testBinding(): Promise<void> {
  const loaded = loadRuntimeDocument(readFileSync("./src/assets/templates/default-score.json", "utf8"));
  assert.ok(loaded.ok);
  let state = createInitialState(loaded.document);
  state = applyYoutubeSyncEditToState(state, "", 0);
  const before = state;
  const changed = applyYoutubeSyncEditToState(state, "abcDEF_123-", 120);
  assert.equal(changed.document.indexes, state.document.indexes);
  for (const key of ["parsed", "analysis", "renderInput", "history", "gameMode"] as const) assert.equal(changed[key], state[key]);
  assert.equal(changed.document.score.tracks, state.document.score.tracks);
  assert.equal(applyYoutubeSyncEditToState(changed, "abcDEF_123-", 120), changed);
  const names = ["youtubeToggle", "youtubeControls", "youtubePlayerShell", "youtubePlayer", "youtubeVideoInput",
    "youtubeOffsetInput", "youtubeLocalOffsetInput", "youtubeReloadButton", "youtubeStatus", "leftStatusLine"] as const;
  const elements = Object.fromEntries(names.map(name => [name, new ElementStub()])) as Record<typeof names[number], ElementStub>;
  const dom = elements as unknown as AppDom;
  let playing = false;
  let seconds = 10;
  const runtime = { controller: { isPlaying: () => playing, getCurrentScoreSeconds: () => seconds } } as AppPlaybackRuntime;
  const requests: Array<{ resolve: (handle: YoutubePlayerHandle) => void; error: (message: string) => void;
    signal?: AbortSignal; handle: YoutubePlayerHandle; calls: string[] }> = [];
  const control = bindYoutubeControls(dom, { getState: () => state, setState: next => { state = next; }, getPlaybackRuntime: () => runtime },
    async (_container, videoId, error, signal) => new Promise(resolve => {
      assert.equal(videoId, state.document.score.musicData.youtube.videoId);
      const calls: string[] = [];
      const handle: YoutubePlayerHandle = {
        loadVideo: async id => { calls.push(`load:${id}`); }, seekTo: t => { calls.push(`seek:${t}`); },
        play: () => { calls.push("play"); }, pause: () => { calls.push("pause"); },
        getCurrentTime: () => seconds, dispose: () => { calls.push("dispose"); },
      };
      requests.push({ resolve, error, signal, handle, calls });
    }));
  try {
    assert.equal(elements.youtubeControls.hidden, true);
    elements.youtubeToggle.checked = true; dispatch(elements.youtubeToggle); await flush();
    assert.equal(elements.youtubeControls.hidden, false);
    assert.equal(elements.youtubeStatus.textContent, "No video");
    assert.equal(requests.length, 0);
    elements.youtubeVideoInput.value = "abcDEF_123-";
    dispatch(elements.youtubeVideoInput, "keydown", true); assert.equal(state, before);
    dispatch(elements.youtubeVideoInput, "keydown"); dispatch(elements.youtubeVideoInput); await flush();
    assert.equal(requests.length, 1);
    requests[0].resolve(requests[0].handle); await flush();
    assert.equal(elements.youtubeStatus.textContent, "Ready");
    const readyState = state;
    const callsBefore = requests[0].calls.length;
    elements.youtubeOffsetInput.value = "1"; dispatch(elements.youtubeOffsetInput, "keydown"); dispatch(elements.youtubeOffsetInput);
    assert.deepEqual(requests[0].calls.slice(callsBefore), ["pause", "seek:9.999"]);
    assert.equal(requests.length, 1);
    assert.equal(state.document.indexes, readyState.document.indexes);
    assert.equal(state.history, before.history);
    const metadataState = state;
    elements.youtubeVideoInput.value = "invalid url"; dispatch(elements.youtubeVideoInput);
    assert.equal(state.document, metadataState.document);
    assert.equal(elements.youtubeToggle.checked, true);
    assert.equal(elements.youtubePlayerShell.dataset.state, "ready");
    elements.youtubeLocalOffsetInput.value = "-201"; dispatch(elements.youtubeLocalOffsetInput);
    assert.equal(state.document, metadataState.document);
    assert.equal(elements.youtubeVideoInput.value, "invalid url");
    assert.equal(state.youtubeLocalOffsetMs, -201);
    dispatch(elements.youtubeReloadButton, "click"); await flush();
    assert.equal(requests.length, 2);
    assert.equal(state.document, metadataState.document);
    requests[1].resolve(requests[1].handle); await flush();
    assert.ok(requests[1].calls.includes("load:abcDEF_123-"));
    requests[1].error("blocked");
    assert.equal(elements.youtubeToggle.checked, true);
    assert.equal(elements.youtubeControls.hidden, false);
    assert.equal(elements.youtubePlayerShell.dataset.state, "error");
    elements.youtubeVideoInput.value = "abcDEF_123-"; dispatch(elements.youtubeVideoInput); await flush();
    assert.equal(requests.length, 2, "same ID does not retry errors");
    dispatch(elements.youtubeReloadButton, "click"); await flush();
    elements.youtubeToggle.checked = false; dispatch(elements.youtubeToggle);
    assert.ok(requests[2].signal?.aborted);
    requests[2].resolve(requests[2].handle); await flush();
    assert.deepEqual(requests[2].calls, ["dispose"]);
    assert.equal(elements.youtubeControls.hidden, true);
    requests[2].error("late failure"); assert.equal(elements.youtubePlayerShell.dataset.state, "off");
    // A 준비 중 B 확정: A 완료는 정리만 하고 B의 최신 시간·offset으로 합류한다.
    elements.youtubeToggle.checked = true; dispatch(elements.youtubeToggle); await flush();
    elements.youtubeVideoInput.value = "xyzDEF_123-"; dispatch(elements.youtubeVideoInput); await flush();
    requests[3].resolve(requests[3].handle);
    seconds = 12; playing = true;
    elements.youtubeOffsetInput.value = "500"; dispatch(elements.youtubeOffsetInput);
    requests[4].resolve(requests[4].handle); await flush();
    assert.deepEqual(requests[3].calls, ["dispose"]);
    assert.ok(requests[4].calls.includes("seek:11.701"));
    assert.ok(requests[4].calls.includes("play"));
    // 빈 ID는 영상만 해제하며 패널·악보 상태를 유지한다.
    elements.youtubeVideoInput.value = ""; dispatch(elements.youtubeVideoInput);
    assert.equal(elements.youtubeToggle.checked, true); assert.equal(elements.youtubeStatus.textContent, "No video");
    assert.equal(playing, true); assert.equal(state.gameMode, before.gameMode);
    dispatch(elements.youtubeReloadButton, "click"); await flush(); assert.equal(requests.length, 5);
    // 악보 교체는 대기 중 요청을 무효화하고 입력을 새 문서에서 채운다.
    elements.youtubeVideoInput.value = "abcDEF_123-"; dispatch(elements.youtubeVideoInput); await flush();
    state = before; control.syncInputsFromScore(); requests[5].resolve(requests[5].handle); await flush();
    assert.equal(elements.youtubeControls.hidden, true); assert.equal(elements.youtubeVideoInput.value, "");
    assert.deepEqual(requests[5].calls, ["dispose"]);
  } finally { control.dispose(); }
}

/**
 * 실제 wrapper의 API 실패 재시도·준비 취소·소유 mount 정리를 검증한다.
 * - 인수 : 없음
 * - 반환값 : 검증 완료
 */
async function testPlayer(): Promise<void> {
  const timers = new Map<number, () => void>();
  let timerId = 0;
  const fakeWindow = { YT: undefined as unknown, onYouTubeIframeAPIReady: undefined as (() => void) | undefined,
    setTimeout: (fn: () => void): number => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id: number): void => { timers.delete(id); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  // script 실패와 timeout 모두 캐시를 해제한다.
  const failed = loadYoutubeIframeApi();
  const same = loadYoutubeIframeApi(); assert.equal(failed, same);
  fakeDocument.head.children.at(-1)!.onerror!();
  await assert.rejects(failed, /load failed/);
  const timeout = loadYoutubeIframeApi(); assert.notEqual(timeout, failed);
  [...timers.values()][0](); await assert.rejects(timeout, /timeout/);
  assert.equal(fakeDocument.head.children.length, 0);
  const container = new ElementStub();
  const apiAbort = new AbortController();
  const apiWait = createYoutubePlayer(container as unknown as HTMLElement, "gpcRRvCuXfs", () => {}, apiAbort.signal);
  apiAbort.abort(); await assert.rejects(apiWait, { name: "AbortError" });
  assert.equal(container.children.length, 0);
  fakeDocument.head.children.at(-1)!.onerror!(); await flush();

  type Options = ConstructorParameters<NonNullable<Window["YT"]>["Player"]>[1];
  const instances: PlayerStub[] = [];
  class PlayerStub {
    destroyed = false; calls: string[] = [];
    /** player 생성 기록. - 인수 : element, options : API 입력 - 반환값 : 인스턴스 */
    constructor(_element: HTMLElement, public options: Options) {
      // 실제 API는 빈 embed로 생성하면 ready 이후 error:2를 전달할 수 있다.
      assert.equal(options.videoId, "gpcRRvCuXfs", "player must start with the confirmed video ID");
      instances.push(this);
    }
    /** cue 기록. - 인수 : input : 영상 - 반환값 : 없음 */
    cueVideoById(input: { videoId: string }): void { this.calls.push(input.videoId); }
    /** seek 대역. - 인수 : 없음 - 반환값 : 없음 */
    seekTo(): void {}
    /** play 대역. - 인수 : 없음 - 반환값 : 없음 */
    playVideo(): void {}
    /** pause 대역. - 인수 : 없음 - 반환값 : 없음 */
    pauseVideo(): void {}
    /** 시간 대역. - 인수 : 없음 - 반환값 : 영상 초 */
    getCurrentTime(): number { return 0; }
    /** 소유 자원 제거 기록. - 인수 : 없음 - 반환값 : 없음 */
    destroy(): void { this.destroyed = true; }
  }
  fakeWindow.YT = { Player: PlayerStub };
  const errors: string[] = [];
  const abort = new AbortController();
  const pending = createYoutubePlayer(container as unknown as HTMLElement, "gpcRRvCuXfs", message => errors.push(message), abort.signal);
  await flush(); assert.equal(container.children.length, 1);
  abort.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(instances[0].destroyed, true); assert.equal(container.children.length, 0);
  const fresh = createYoutubePlayer(container as unknown as HTMLElement, "gpcRRvCuXfs", message => errors.push(message));
  await flush();
  instances[0].options.events.onReady({ target: instances[0] });
  instances[0].options.events.onError({ data: 150, target: instances[0] });
  assert.equal(container.children.length, 1); assert.equal(errors.length, 0);
  instances[1].options.events.onReady({ target: instances[1] });
  const handle = await fresh;
  await handle.loadVideo("abcDEF_123-", 0);
  instances[1].options.events.onError({ data: 100, target: instances[1] });
  assert.deepEqual(errors, ["YouTube player error: 100"]);
  handle.dispose(); handle.dispose();
  assert.equal(container.children.length, 0); assert.equal(timers.size, 0);
  const readyTimeout = createYoutubePlayer(container as unknown as HTMLElement, "gpcRRvCuXfs", () => {});
  await flush(); [...timers.values()][0](); await assert.rejects(readyTimeout, /timeout/);
  assert.equal(instances[2].destroyed, true); assert.equal(container.children.length, 0);
}

/** 전체 lifecycle 검증 후 global 대역을 복원한다. - 인수 : 없음 - 반환값 : 검증 완료 */
export async function runYoutubeLifecycleTests(): Promise<void> {
  const originals = new Map(["document", "window"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDocument });
  try { await testBinding(); await testPlayer(); }
  finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
  console.log("YouTube binding/player lifecycle tests passed");
}
