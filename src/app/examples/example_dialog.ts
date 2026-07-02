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
  ExampleTrackId,
} from "./example_types";

/** Examples 목록 정렬 기준. */
type ExampleSortMode =
  | "title"
  | "artist"
  | "difficulty-basic"
  | "difficulty-optional"
  | "difficulty-extra"
  | "updated-at";

/** Examples 목록 정렬 방향. */
type ExampleSortDirection = "asc" | "desc";

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

  dom.examplesSortSelect.addEventListener("change", () => {
    renderExampleRowsFromControls(dom);
  });

  dom.examplesSortDirectionSelect.addEventListener("change", () => {
    renderExampleRowsFromControls(dom);
  });

  dom.examplesNameSearchInput.addEventListener("input", () => {
    renderExampleRowsFromControls(dom);
  });

  dom.examplesGenreSearchInput.addEventListener("input", () => {
    renderExampleRowsFromControls(dom);
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
  dom.examplesList.dataset.examplesJson = JSON.stringify(manifest.examples);
  dom.examplesList.dataset.selectedExampleId = "";
  dom.examplesLoadButton.disabled = true;
  renderExampleRowsFromControls(dom);
}

/**
 * 현재 정렬/필터 control 값에 맞춰 Examples 목록을 다시 렌더링한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 반환값 : 없음
 */
function renderExampleRowsFromControls(dom: AppDom): void {
  const allItems = readManifestItems(dom);
  const visibleItems = sortExampleItems(
    filterExampleItems(
      allItems,
      dom.examplesNameSearchInput.value,
      dom.examplesGenreSearchInput.value,
    ),
    readExampleSortMode(dom.examplesSortSelect.value),
    readExampleSortDirection(dom.examplesSortDirectionSelect.value),
  );

  dom.examplesList.replaceChildren();

  const selectedId = dom.examplesList.dataset.selectedExampleId ?? "";
  const hasSelectedItem = visibleItems.some((item) => item.id === selectedId);

  if (!hasSelectedItem) {
    dom.examplesList.dataset.selectedExampleId = "";
    dom.examplesLoadButton.disabled = true;
  }

  if (visibleItems.length === 0) {
    const empty = document.createElement("p");

    empty.className = "examples-empty";
    empty.textContent = allItems.length === 0
      ? "No examples are available."
      : "No examples match the selected filter.";
    dom.examplesList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const item of visibleItems) {
    fragment.append(createExampleRow(dom, item));
  }

  dom.examplesList.append(fragment);
  selectVisibleExampleRow(dom, selectedId);
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
  dom.examplesNameSearchInput.value = "";
  dom.examplesGenreSearchInput.value = "";
  dom.examplesSortSelect.value = "title";
  dom.examplesSortDirectionSelect.value = "asc";
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
  meta.textContent = `Genre ${item.genre ?? "--"}`;
  meta.className = "example-row-meta";
  detail.textContent = formatDifficulty(item);
  detail.className = "example-row-detail";

  const fileMeta = document.createElement("span");

  fileMeta.textContent = [
    formatDurationLabel(item.durationSeconds),
    formatSizeLabel(item.sizeBytes),
    formatDateLabel("Created", item.createdAt),
    formatDateLabel("Updated", item.updatedAt),
  ].filter((text) => text.length > 0).join(" · ");
  fileMeta.className = "example-row-file-meta";

  row.append(title, meta, detail, fileMeta);
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
  selectVisibleExampleRow(dom, itemId);
}

/**
 * 현재 표시 중인 example row 버튼의 선택 상태만 갱신한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : itemId : 선택할 example id
 * - 반환값 : 없음
 */
function selectVisibleExampleRow(dom: AppDom, itemId: string): void {
  for (const element of Array.from(dom.examplesList.querySelectorAll(".example-row"))) {
    if (element instanceof HTMLButtonElement) {
      element.setAttribute("aria-pressed", String(element.dataset.exampleId === itemId));
    }
  }
}

/**
 * 이름/장르 검색어에 맞게 manifest item 목록을 필터링한다.
 * - 인수 : items : 전체 manifest item 목록
 * - 인수 : nameQuery : 제목 또는 아티스트 검색어
 * - 인수 : genreQuery : 장르 검색어
 * - 반환값 : 필터링된 item 목록
 */
function filterExampleItems(
  items: ExampleScoreManifestItem[],
  nameQuery: string,
  genreQuery: string,
): ExampleScoreManifestItem[] {
  const normalizedNameQuery = normalizeSearchText(nameQuery);
  const normalizedGenreQuery = normalizeSearchText(genreQuery);

  return items.filter((item) => {
    const nameText = normalizeSearchText(`${item.title} ${item.artist}`);
    const genreText = normalizeSearchText(item.genre ?? "");

    return (
      (normalizedNameQuery.length === 0 || nameText.includes(normalizedNameQuery)) &&
      (normalizedGenreQuery.length === 0 || genreText.includes(normalizedGenreQuery))
    );
  });
}

/**
 * 정렬 기준 value를 목록 정렬 모드로 정규화한다.
 * - 인수 : value : sort select value
 * - 반환값 : 정렬 모드
 */
function readExampleSortMode(value: string): ExampleSortMode {
  switch (value) {
    case "artist":
    case "difficulty-basic":
    case "difficulty-optional":
    case "difficulty-extra":
    case "updated-at":
      return value;
    default:
      return "title";
  }
}

/**
 * 정렬 방향 value를 목록 정렬 방향으로 정규화한다.
 * - 인수 : value : sort direction select value
 * - 반환값 : 정렬 방향
 */
function readExampleSortDirection(value: string): ExampleSortDirection {
  return value === "desc" ? "desc" : "asc";
}

/**
 * Examples item 목록을 지정 기준으로 정렬한다.
 * - 인수 : items : 정렬할 item 목록
 * - 인수 : sortMode : 정렬 기준
 * - 인수 : direction : 정렬 방향
 * - 반환값 : 정렬된 새 배열
 */
function sortExampleItems(
  items: ExampleScoreManifestItem[],
  sortMode: ExampleSortMode,
  direction: ExampleSortDirection,
): ExampleScoreManifestItem[] {
  return items.slice().sort((left, right) => {
    const result = compareExampleItems(left, right, sortMode, direction);

    return result !== 0 ? result : compareText(left.title, right.title);
  });
}

/**
 * 두 Examples item을 지정 기준으로 비교한다.
 * - 인수 : left : 왼쪽 item
 * - 인수 : right : 오른쪽 item
 * - 인수 : sortMode : 정렬 기준
 * - 인수 : direction : 정렬 방향
 * - 반환값 : Array.sort 비교값
 */
function compareExampleItems(
  left: ExampleScoreManifestItem,
  right: ExampleScoreManifestItem,
  sortMode: ExampleSortMode,
  direction: ExampleSortDirection,
): number {
  switch (sortMode) {
    case "artist":
      return compareTextByDirection(left.artist, right.artist, direction);
    case "difficulty-basic":
      return compareDifficulty(left, right, "basic", direction);
    case "difficulty-optional":
      return compareDifficulty(left, right, "optional", direction);
    case "difficulty-extra":
      return compareDifficulty(left, right, "extra", direction);
    case "updated-at":
      return compareDate(left.updatedAt, right.updatedAt, direction);
    case "title":
    default:
      return compareTextByDirection(left.title, right.title, direction);
  }
}

/**
 * track 난이도를 오름차순으로 비교하고 누락값은 뒤로 보낸다.
 * - 인수 : left : 왼쪽 item
 * - 인수 : right : 오른쪽 item
 * - 인수 : track : 비교할 track id
 * - 인수 : direction : 정렬 방향
 * - 반환값 : Array.sort 비교값
 */
function compareDifficulty(
  left: ExampleScoreManifestItem,
  right: ExampleScoreManifestItem,
  track: ExampleTrackId,
  direction: ExampleSortDirection,
): number {
  const leftValue = left.difficulty?.[track];
  const rightValue = right.difficulty?.[track];

  if (leftValue === undefined && rightValue === undefined) return 0;
  if (leftValue === undefined) return 1;
  if (rightValue === undefined) return -1;

  return direction === "desc" ? rightValue - leftValue : leftValue - rightValue;
}

/**
 * 날짜 문자열을 정렬 방향에 맞게 비교하고 누락값은 뒤로 보낸다.
 * - 인수 : left : 왼쪽 날짜 문자열
 * - 인수 : right : 오른쪽 날짜 문자열
 * - 인수 : direction : 정렬 방향
 * - 반환값 : Array.sort 비교값
 */
function compareDate(
  left: string | undefined,
  right: string | undefined,
  direction: ExampleSortDirection,
): number {
  const leftTime = left === undefined ? Number.NaN : Date.parse(left);
  const rightTime = right === undefined ? Number.NaN : Date.parse(right);
  const hasLeft = Number.isFinite(leftTime);
  const hasRight = Number.isFinite(rightTime);

  if (!hasLeft && !hasRight) return 0;
  if (!hasLeft) return 1;
  if (!hasRight) return -1;

  return direction === "desc" ? rightTime - leftTime : leftTime - rightTime;
}

/**
 * UI 표시 문자열을 localeCompare 기반으로 비교한다.
 * - 인수 : left : 왼쪽 문자열
 * - 인수 : right : 오른쪽 문자열
 * - 반환값 : Array.sort 비교값
 */
function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * UI 표시 문자열을 정렬 방향에 맞게 비교한다.
 * - 인수 : left : 왼쪽 문자열
 * - 인수 : right : 오른쪽 문자열
 * - 인수 : direction : 정렬 방향
 * - 반환값 : Array.sort 비교값
 */
function compareTextByDirection(
  left: string,
  right: string,
  direction: ExampleSortDirection,
): number {
  const result = compareText(left, right);

  return direction === "desc" ? -result : result;
}

/**
 * 검색용 문자열을 대소문자와 반복 공백 차이에 둔감하게 정규화한다.
 * - 인수 : value : 검색 대상 또는 입력 문자열
 * - 반환값 : 검색 비교용 문자열
 */
function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .replace(/\s+/g, " ");
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
function formatDurationLabel(value: number | undefined): string {
  if (value === undefined) {
    return "";
  }

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;

  return `Duration ${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 파일 크기 표시 문자열을 만든다.
 * - 인수 : value : byte 단위 크기
 * - 반환값 : KiB 표시 또는 빈 문자열
 */
function formatSizeLabel(value: number | undefined): string {
  if (value === undefined) {
    return "";
  }

  return `Size ${Math.round(value / 1024)} KiB`;
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
