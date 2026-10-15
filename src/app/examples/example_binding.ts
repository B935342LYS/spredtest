/**
 * File > Examples 메뉴와 Examples provider, 기존 score load pipeline을 연결한다.
 */

import type {
  AppDom,
  UiStatusLevel,
} from "../app_types";
import { readExampleProviderConfig } from "./example_config";
import {
  bindExampleDialog,
  openExampleDialog,
  renderExampleManifest,
  setExampleDialogBusy,
  setExampleDialogNotice,
} from "./example_dialog";
import { createSupabaseExampleProvider } from "./example_supabase_provider";
import type { ExampleError } from "./example_types";

/** Examples에 필요한 잠금 조회·진행 보고·악보 로드만 허용하는 앱 계약. */
export type ExampleBindingSession = {
  /**
   * 현재 Practice 잠금 여부를 조회한다.
   * - 인수 : 없음
   * - 반환값 : Examples를 사용할 수 없으면 true
   */
  isPracticeLocked(): boolean;
  /**
   * 기존 상태 메시지를 유지하며 앱 입력을 잠그고 진행 문구를 표시한다.
   * - 인수 : message : 로딩 안내
   * - 반환값 : 없음
   */
  beginLoading(message: string): void;
  /**
   * 앱 busy를 해제하고 성공·실패·닫기 또는 진입 차단 결과를 표시한다.
   * - 인수 : text : 결과 문구
   * - 인수 : level : 상태 중요도
   * - 반환값 : 없음
   */
  reportIdleStatus(text: string, level: UiStatusLevel): void;
  /**
   * 기존 검증·악보 교체 경로를 실행한다. 해당 경로가 busy와 결과 표시를 맡는다.
   * - 인수 : jsonText : 받은 Score JSON
   * - 인수 : sourceLabel : 로드 출처 표시
   * - 반환값 : 로드 직후 앱 상태가 오류가 아니면 true
   */
  loadScoreJsonText(jsonText: string, sourceLabel: string): boolean;
};

/** 현재 페이지의 검증된 접근 단어와 최신 목록/악보 요청을 보관하는 임시 상태. */
type ExampleAccessSession = {
  rememberedAccessWord: string;
  requestId: number;
  loading: boolean;
  controller: AbortController | null;
};

/**
 * Examples 메뉴, dialog, provider event를 app 상태 변경 흐름에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : 잠금 조회·진행 보고와 score load callback 묶음
 * - 반환값 : 없음
 */
export function bindExampleControls(
  dom: AppDom,
  session: ExampleBindingSession,
): void {
  const provider = createSupabaseExampleProvider(readExampleProviderConfig());
  // 악보 상태와 분리한 메모리 값이므로 dialog 종료·악보 교체에는 유지되고 페이지 재로드에는 사라진다.
  const accessSession: ExampleAccessSession = {
    rememberedAccessWord: "",
    requestId: 0,
    loading: false,
    controller: null,
  };

  dom.examplesButton.addEventListener("click", () => {
    if (session.isPracticeLocked()) {
      session.reportIdleStatus("Exit practice mode before loading examples.", "warning");
      return;
    }

    openExampleDialog(dom, accessSession.rememberedAccessWord);
    void loadManifest(dom, session, provider, accessSession.rememberedAccessWord, accessSession);
  });

  bindExampleDialog(dom, {
    onAction(action) {
      if (action.kind === "close") {
        // 닫힌 창의 응답은 무효화하되 검증된 단어는 다음 재진입을 위해 유지한다.
        accessSession.requestId += 1;
        accessSession.controller?.abort();
        accessSession.controller = null;
        if (accessSession.loading) {
          accessSession.loading = false;
          session.reportIdleStatus("Example loading cancelled.", "info");
        }
        return;
      }

      if (session.isPracticeLocked()) {
        setExampleDialogNotice(dom, "Exit practice mode before loading examples.", "warning");
        return;
      }

      if (action.kind === "loadList") {
        if (action.accessWord.trim().length === 0) {
          setExampleDialogNotice(dom, "Enter access word to load extra examples.", "warning");
          return;
        }

        void loadManifest(dom, session, provider, action.accessWord, accessSession);
        return;
      }

      void loadExampleScore(dom, session, provider, action.item, accessSession);
    },
  });
}

/**
 * Edge Function에서 manifest를 읽고 dialog에 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : 잠금 조회·진행 보고와 악보 로드 계약
 * - 인수 : provider : Examples provider
 * - 인수 : accessWord : 사용자가 입력한 임시 암호 단어
 * - 인수 : accessSession : 페이지 수명의 접근 단어와 요청 순서 상태
 * - 반환값 : 없음
 */
async function loadManifest(
  dom: AppDom,
  session: ExampleBindingSession,
  provider: ReturnType<typeof createSupabaseExampleProvider>,
  accessWord: string,
  accessSession: ExampleAccessSession,
): Promise<void> {
  const trimmedAccessWord = accessWord.trim();
  const scopeLabel = trimmedAccessWord.length === 0 ? "public examples" : "examples";
  const requestId = ++accessSession.requestId;
  accessSession.controller?.abort();
  const controller = new AbortController();
  accessSession.controller = controller;
  accessSession.loading = true;

  setExampleDialogBusy(dom, true);
  setExampleDialogNotice(dom, `Loading ${scopeLabel}...`, "info");
  session.beginLoading(`Loading ${scopeLabel}...`);

  try {
    const manifest = await provider.loadManifest(trimmedAccessWord, controller.signal);

    // 재개방·새 요청 이후 도착한 이전 응답은 목록과 보관값을 덮어쓰지 않는다.
    if (requestId !== accessSession.requestId || !dom.examplesDialog.open) {
      return;
    }
    if (trimmedAccessWord.length > 0) {
      accessSession.rememberedAccessWord = trimmedAccessWord;
    }
    renderExampleManifest(dom, manifest);
    setExampleDialogNotice(dom, `Loaded ${manifest.examples.length} example(s).`, "info");
    session.reportIdleStatus("Example list loaded.", "info");
  } catch (error: unknown) {
    if (requestId !== accessSession.requestId || !dom.examplesDialog.open) {
      return;
    }

    // 보관한 단어 자체가 거부된 경우만 비운다. 다른 단어의 오입력과 통신 실패는 보관값을 유지한다.
    if (
      isExampleError(error) && error.code === "INVALID_ACCESS_WORD" &&
      trimmedAccessWord.length > 0 &&
      trimmedAccessWord === accessSession.rememberedAccessWord
    ) {
      accessSession.rememberedAccessWord = "";
      dom.examplesAccessWordInput.value = "";
    }
    const message = formatExampleError(error, trimmedAccessWord.length === 0 ? "public" : "extra");

    setExampleDialogNotice(dom, message, "error");
    session.reportIdleStatus(message, "error");
  } finally {
    // 이전 요청의 finally가 새 요청의 입력 잠금을 해제하지 않도록 최신 요청만 정리한다.
    if (requestId === accessSession.requestId) {
      accessSession.loading = false;
      accessSession.controller = null;
      setExampleDialogBusy(dom, false);
      // close 이벤트보다 응답이 먼저 정리되는 경우에도 앱의 로딩 상태가 남지 않게 한다.
      if (!dom.examplesDialog.open) {
        session.reportIdleStatus("Example loading cancelled.", "info");
      }
    }
  }
}

/**
 * 선택한 example Score JSON을 fetch하고 기존 score load pipeline으로 전달한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : 잠금 조회·진행 보고와 악보 로드 계약
 * - 인수 : provider : Examples provider
 * - 인수 : item : 사용자가 선택한 manifest item
 * - 인수 : accessSession : 목록/악보 요청의 수명과 취소 상태
 * - 반환값 : 없음
 */
async function loadExampleScore(
  dom: AppDom,
  session: ExampleBindingSession,
  provider: ReturnType<typeof createSupabaseExampleProvider>,
  item: Parameters<ReturnType<typeof createSupabaseExampleProvider>["loadScoreText"]>[0],
  accessSession: ExampleAccessSession,
): Promise<void> {
  if (!window.confirm(`Replace the current score with "${item.title}"?`)) {
    return;
  }

  const requestId = ++accessSession.requestId;
  accessSession.controller?.abort();
  const controller = new AbortController();
  accessSession.controller = controller;
  accessSession.loading = true;
  setExampleDialogBusy(dom, true);
  setExampleDialogNotice(dom, `Loading ${item.title}...`, "info");
  session.beginLoading(`Loading ${item.title}...`);
  let scoreApplied = false;

  try {
    const jsonText = await provider.loadScoreText(item, controller.signal);

    // 취소·재개방 이후의 응답은 기존 악보와 새 요청의 상태에 영향을 주지 않는다.
    if (requestId !== accessSession.requestId || !dom.examplesDialog.open) return;

    scoreApplied = session.loadScoreJsonText(jsonText, `example: ${item.title}`);
    if (scoreApplied) {
      dom.examplesDialog.close();
    }
  } catch (error: unknown) {
    if (requestId !== accessSession.requestId || !dom.examplesDialog.open) return;
    const message = formatExampleError(error);

    setExampleDialogNotice(dom, message, "error");
    session.reportIdleStatus(message, "error");
  } finally {
    if (requestId === accessSession.requestId) {
      accessSession.loading = false;
      accessSession.controller = null;
      setExampleDialogBusy(dom, false);
      // close 이벤트보다 완료가 먼저 도착해도 취소 busy를 정리하되 정상 로드 안내는 보존한다.
      if (!dom.examplesDialog.open && !scoreApplied) {
        session.reportIdleStatus("Example loading cancelled.", "info");
      }
    }
  }
}

/**
 * Examples 오류를 사용자 표시 문구로 정리한다.
 * - 인수 : error : provider 또는 fetch에서 발생한 오류
 * - 인수 : requestScope : 공개 목록 요청 또는 추가 목록 요청 구분
 * - 반환값 : 사용자에게 표시할 오류 문구
 */
function formatExampleError(error: unknown, requestScope: "public" | "extra" = "extra"): string {
  if (isExampleError(error)) {
    if (requestScope === "public" && error.code === "INVALID_ACCESS_WORD") {
      return "Public example list is unavailable. Update the Examples Edge Function to allow empty access word requests.";
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown examples error.";
}

/**
 * unknown 값이 ExampleError인지 확인한다.
 * - 인수 : value : 검사할 값
 * - 반환값 : ExampleError이면 true
 */
function isExampleError(value: unknown): value is ExampleError {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string";
}
