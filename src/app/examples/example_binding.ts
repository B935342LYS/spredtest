/**
 * File > Examples 메뉴와 Examples provider, 기존 score load pipeline을 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "../app_types";
import {
  syncLeftStatus,
  syncUiControls,
} from "../app_ui_sync";
import { isGameModeLocked } from "../game/game_types";
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

/** Examples binding이 app 상태와 score load 흐름을 제어하기 위한 session 입력. */
export type ExampleBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  loadScoreJsonText(jsonText: string, sourceLabel: string): void;
};

/**
 * Examples 메뉴, dialog, provider event를 app 상태 변경 흐름에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회/갱신과 score load callback 묶음
 * - 반환값 : 없음
 */
export function bindExampleControls(
  dom: AppDom,
  session: ExampleBindingSession,
): void {
  const provider = createSupabaseExampleProvider(readExampleProviderConfig());

  dom.examplesButton.addEventListener("click", () => {
    const state = session.getState();

    if (isGameModeLocked(state.gameMode)) {
      setAppStatus(dom, session, "Exit practice mode before loading examples.", "warning");
      return;
    }

    openExampleDialog(dom);
  });

  bindExampleDialog(dom, {
    onAction(action) {
      if (action.kind === "close") {
        return;
      }

      if (isGameModeLocked(session.getState().gameMode)) {
        setExampleDialogNotice(dom, "Exit practice mode before loading examples.", "warning");
        return;
      }

      if (action.kind === "loadList") {
        void loadManifest(dom, session, provider, action.accessWord);
        return;
      }

      void loadExampleScore(dom, session, provider, action.item);
    },
  });
}

/**
 * Edge Function에서 manifest를 읽고 dialog에 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회/갱신 callback
 * - 인수 : provider : Examples provider
 * - 인수 : accessWord : 사용자가 입력한 임시 암호 단어
 * - 반환값 : 없음
 */
async function loadManifest(
  dom: AppDom,
  session: ExampleBindingSession,
  provider: ReturnType<typeof createSupabaseExampleProvider>,
  accessWord: string,
): Promise<void> {
  const trimmedAccessWord = accessWord.trim();

  if (trimmedAccessWord.length === 0) {
    setExampleDialogNotice(dom, "Enter access word.", "warning");
    return;
  }

  setExampleDialogBusy(dom, true);
  setExampleDialogNotice(dom, "Loading examples...", "info");
  setAppBusyStatus(dom, session, "Loading examples...");

  try {
    const manifest = await provider.loadManifest(trimmedAccessWord);

    renderExampleManifest(dom, manifest);
    setExampleDialogNotice(dom, `Loaded ${manifest.examples.length} example(s).`, "info");
    setAppStatus(dom, session, "Example list loaded.", "info");
  } catch (error: unknown) {
    const message = formatExampleError(error);

    setExampleDialogNotice(dom, message, "error");
    setAppStatus(dom, session, message, "error");
  } finally {
    setExampleDialogBusy(dom, false);
  }
}

/**
 * 선택한 example Score JSON을 fetch하고 기존 score load pipeline으로 전달한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회/갱신 callback
 * - 인수 : provider : Examples provider
 * - 인수 : item : 사용자가 선택한 manifest item
 * - 반환값 : 없음
 */
async function loadExampleScore(
  dom: AppDom,
  session: ExampleBindingSession,
  provider: ReturnType<typeof createSupabaseExampleProvider>,
  item: Parameters<ReturnType<typeof createSupabaseExampleProvider>["loadScoreText"]>[0],
): Promise<void> {
  if (!window.confirm(`Replace the current score with "${item.title}"?`)) {
    return;
  }

  setExampleDialogBusy(dom, true);
  setExampleDialogNotice(dom, `Loading ${item.title}...`, "info");
  setAppBusyStatus(dom, session, `Loading ${item.title}...`);

  try {
    const jsonText = await provider.loadScoreText(item);

    session.loadScoreJsonText(jsonText, `example: ${item.title}`);
    if (session.getState().statusMessage.level !== "error") {
      dom.examplesDialog.close();
    }
  } catch (error: unknown) {
    const message = formatExampleError(error);

    setExampleDialogNotice(dom, message, "error");
    setAppStatus(dom, session, message, "error");
  } finally {
    setExampleDialogBusy(dom, false);
  }
}

/**
 * Examples 작업 중 앱 busy 상태를 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회/갱신 callback
 * - 인수 : message : busy 메시지
 * - 반환값 : 없음
 */
function setAppBusyStatus(
  dom: AppDom,
  session: ExampleBindingSession,
  message: string,
): void {
  const state = session.getState();

  session.setState({
    ...state,
    busy: {
      kind: "loadingScore",
      message,
    },
  });
  syncLeftStatus(dom, session.getState());
  syncUiControls(dom, session.getState());
}

/**
 * Examples 작업 결과를 앱 status line에 표시한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회/갱신 callback
 * - 인수 : text : 표시할 문구
 * - 인수 : level : 상태 중요도
 * - 반환값 : 없음
 */
function setAppStatus(
  dom: AppDom,
  session: ExampleBindingSession,
  text: string,
  level: AppState["statusMessage"]["level"],
): void {
  const state = session.getState();

  session.setState({
    ...state,
    busy: {
      kind: "idle",
    },
    statusMessage: {
      level,
      text,
    },
  });
  syncLeftStatus(dom, session.getState());
  syncUiControls(dom, session.getState());
}

/**
 * Examples 오류를 사용자 표시 문구로 정리한다.
 * - 인수 : error : provider 또는 fetch에서 발생한 오류
 * - 반환값 : 사용자에게 표시할 오류 문구
 */
function formatExampleError(error: unknown): string {
  if (isExampleError(error)) {
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
