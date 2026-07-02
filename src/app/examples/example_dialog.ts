/**
 * Examples dialog DOM 렌더링과 사용자 선택 상태를 관리한다.
 */

import type {
  AppDom,
  UiStatusLevel,
} from "../app_types";
import type {
  ExampleScoreManifest,
  ExampleScoreManifestItem,
} from "./example_types";

/** Examples dialog에서 선택한 action. */
export type ExampleDialogAction =
  | { kind: "loadList"; accessWord: string }
  | { kind: "loadExample"; item: ExampleScoreManifestItem }
  | { kind: "close" };

/** Examples dialog event handler 묶음. */
export type ExampleDialogHandlers = {
  onAction(action: ExampleDialogAction): void;
};

/**
 * Examples dialog의 정적 event를 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : handlers : dialog action 처리 함수
 * - 반환값 : 없음
 */
export function bindExampleDialog(
  dom: AppDom,
  handlers: ExampleDialogHandlers,
): void {
  dom.examplesCloseButton.addEventListener("click", () => {
    dom.examplesDialog.close();
    handlers.onAction({ kind: "close" });
  });

  dom.examplesDialog.addEventListener("close", () => {
    resetExampleDialog(dom);
  });

  dom.examplesLoadListButton.addEventListener("click", () => {
    handlers.onAction({
      kind: "loadList",
      accessWord: dom.examplesAccessWordInput.value,
    });
  });

  dom.examplesForm.addEventListener("submit", (event) => {
    event.preventDefault();

    if (dom.examplesLoadListButton.disabled) {
      return;
    }

    handlers.onAction({
      kind: "loadList",
      accessWord: dom.examplesAccessWordInput.value,
    });
  });

  dom.examplesLoadButton.addEventListener("click", () => {
    const selectedId = dom.examplesList.dataset.selectedExampleId ?? "";
    const selectedItem = readManifestItems(dom).find((item) => item.id === selectedId);

    if (selectedItem === undefined) {
      setExampleDialogNotice(dom, "Select an example first.", "warning");
      return;
    }

    handlers.onAction({
      kind: "loadExample",
      item: selectedItem,
    });
  });
}

/**
 * Examples dialog를 초기 상태로 열 준비를 한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
export function openExampleDialog(dom: AppDom): void {
  resetExampleDialog(dom);
  dom.examplesDialog.showModal();
  dom.examplesAccessWordInput.focus();
}

/**
 * Examples dialog에 manifest 목록을 렌더링한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : manifest : 검증된 example manifest
 * - 반환값 : 없음
 */
export function renderExampleManifest(dom: AppDom, manifest: ExampleScoreManifest): void {
  dom.examplesList.replaceChildren();
  dom.examplesList.dataset.examplesJson = JSON.stringify(manifest.examples);
  dom.examplesList.dataset.selectedExampleId = "";
  dom.examplesLoadButton.disabled = true;

  if (manifest.examples.length === 0) {
    const empty = document.createElement("p");

    empty.className = "examples-empty";
    empty.textContent = "No examples are available.";
    dom.examplesList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const item of manifest.examples) {
    fragment.append(createExampleRow(dom, item));
  }

  dom.examplesList.append(fragment);
}

/**
 * Examples dialog notice를 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : text : 표시할 문구
 * - 인수 : level : 상태 중요도
 * - 반환값 : 없음
 */
export function setExampleDialogNotice(
  dom: AppDom,
  text: string,
  level: UiStatusLevel = "info",
): void {
  dom.examplesNotice.textContent = text;
  dom.examplesNotice.dataset.level = level;
  dom.examplesNotice.title = text;
}

/**
 * Examples dialog busy 상태를 반영한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : busy : true이면 dialog 입력을 잠근다
 * - 반환값 : 없음
 */
export function setExampleDialogBusy(dom: AppDom, busy: boolean): void {
  dom.examplesAccessWordInput.disabled = busy;
  dom.examplesLoadListButton.disabled = busy;
  dom.examplesLoadButton.disabled = busy || (dom.examplesList.dataset.selectedExampleId ?? "") === "";
  dom.examplesCloseButton.disabled = busy;
  dom.examplesDialog.classList.toggle("busy", busy);
}

/**
 * Examples dialog session 값을 초기화한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
function resetExampleDialog(dom: AppDom): void {
  dom.examplesAccessWordInput.value = "";
  dom.examplesList.replaceChildren();
  dom.examplesList.dataset.examplesJson = "[]";
  dom.examplesList.dataset.selectedExampleId = "";
  dom.examplesLoadButton.disabled = true;
  setExampleDialogNotice(dom, "Enter access word and load the example list.", "info");
  setExampleDialogBusy(dom, false);
}

/**
 * 단일 example row 버튼을 만든다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : item : 렌더링할 manifest item
 * - 반환값 : 목록에 추가할 row 버튼
 */
function createExampleRow(dom: AppDom, item: ExampleScoreManifestItem): HTMLButtonElement {
  const row = document.createElement("button");
  const title = document.createElement("strong");
  const meta = document.createElement("span");
  const detail = document.createElement("span");

  row.type = "button";
  row.className = "example-row";
  row.dataset.exampleId = item.id;
  row.setAttribute("aria-pressed", "false");

  title.textContent = `${item.artist} - ${item.title}`;
  title.className = "example-row-title";
  meta.textContent = formatDifficulty(item);
  meta.className = "example-row-meta";
  detail.textContent = [
    formatDuration(item.durationSeconds),
    formatSize(item.sizeBytes),
    formatDateLabel("Created", item.createdAt),
    formatDateLabel("Updated", item.updatedAt),
  ].filter((text) => text.length > 0).join(" · ");
  detail.className = "example-row-detail";

  row.append(title, meta, detail);
  row.addEventListener("click", () => {
    selectExampleRow(dom, item.id);
  });

  return row;
}

/**
 * 선택된 example row 상태를 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : itemId : 선택할 example id
 * - 반환값 : 없음
 */
function selectExampleRow(dom: AppDom, itemId: string): void {
  dom.examplesList.dataset.selectedExampleId = itemId;
  dom.examplesLoadButton.disabled = false;

  for (const element of Array.from(dom.examplesList.querySelectorAll(".example-row"))) {
    if (element instanceof HTMLButtonElement) {
      element.setAttribute("aria-pressed", String(element.dataset.exampleId === itemId));
    }
  }
}

/**
 * dialog dataset에 저장된 manifest item 목록을 읽는다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : manifest item 목록
 */
function readManifestItems(dom: AppDom): ExampleScoreManifestItem[] {
  try {
    const value = JSON.parse(dom.examplesList.dataset.examplesJson ?? "[]");

    return Array.isArray(value) ? value as ExampleScoreManifestItem[] : [];
  } catch {
    return [];
  }
}

/**
 * 난이도 표시 문자열을 만든다.
 * - 인수 : item : manifest item
 * - 반환값 : 난이도 요약
 */
function formatDifficulty(item: ExampleScoreManifestItem): string {
  const difficulty = item.difficulty;

  if (difficulty === undefined) {
    return "Difficulty --";
  }

  return item.supportedTracks
    .map((track) => `${track} ${difficulty[track] ?? 0}`)
    .join(" / ");
}

/**
 * durationSeconds 표시 문자열을 만든다.
 * - 인수 : value : duration 초 단위 값
 * - 반환값 : mm:ss 형식 또는 빈 문자열
 */
function formatDuration(value: number | undefined): string {
  if (value === undefined) {
    return "";
  }

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 파일 크기 표시 문자열을 만든다.
 * - 인수 : value : byte 단위 크기
 * - 반환값 : KiB 표시 또는 빈 문자열
 */
function formatSize(value: number | undefined): string {
  if (value === undefined) {
    return "";
  }

  return `${Math.round(value / 1024)} KiB`;
}

/**
 * 날짜 표시 문자열을 만든다.
 * - 인수 : label : 표시 label
 * - 인수 : value : 날짜 문자열
 * - 반환값 : label과 날짜 또는 빈 문자열
 */
function formatDateLabel(label: string, value: string | undefined): string {
  if (value === undefined) {
    return "";
  }

  return `${label} ${value.slice(0, 10)}`;
}
