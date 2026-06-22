/**
 * JSON file 입출력과 local storage 버튼 이벤트를 연결한다.
 */

import type {
  AppDom,
  AppState,
} from "./app_types";
import {
  downloadScoreJson,
  readTextFile,
} from "../infra/score_file_io";
import {
  loadScoreFromLocalStorage,
  saveScoreToLocalStorage,
} from "../infra/score_local_storage";
import { touchScoreTimestampsForSave } from "./score_timestamp";
import { syncLeftStatus } from "./app_ui_sync";

/** file/local storage binding이 app 상태를 읽고 갱신하기 위한 session 입력. */
export type FileBindingSession = {
  getState(): AppState;
  setState(nextState: AppState): void;
  loadScoreJsonText(jsonText: string, sourceLabel: string): void;
};

/**
 * file/local storage 관련 DOM event를 app 상태 변경 흐름에 연결한다.
 * - 인수 : dom : 앱에서 제어하는 DOM 요소
 * - 인수 : session : app 상태 조회/갱신과 score load callback 묶음
 * - 반환값 : 없음
 */
export function bindFileControls(
  dom: AppDom,
  session: FileBindingSession,
): void {
  dom.jsonDownloadButton.addEventListener("click", () => {
    const state = session.getState();
    const nextScore = touchScoreTimestampsForSave(
      state.document.score,
      state.scoreOrigin,
    );

    downloadScoreJson(nextScore);
    session.setState({
      ...state,
      document: {
        ...state.document,
        score: nextScore,
      },
      scoreOrigin: "saved",
      statusMessage: {
        level: "info",
        text: "JSON downloaded.",
      },
    });
    syncLeftStatus(dom, session.getState());
  });

  dom.jsonLoadButton.addEventListener("click", () => {
    dom.jsonLoadInput.click();
  });

  dom.jsonLoadInput.addEventListener("change", () => {
    const file = dom.jsonLoadInput.files?.item(0);

    if (file === null || file === undefined) {
      return;
    }

    readTextFile(file)
      .then((jsonText) => {
        session.loadScoreJsonText(jsonText, file.name);
      })
      .catch((error: unknown) => {
        const state = session.getState();
        const message = error instanceof Error ? error.message : "Unknown file read error.";

        session.setState({
          ...state,
          statusMessage: {
            level: "error",
            text: message,
          },
        });
        syncLeftStatus(dom, session.getState());
      })
      .finally(() => {
        dom.jsonLoadInput.value = "";
      });
  });

  dom.localSaveButton.addEventListener("click", () => {
    const state = session.getState();
    const nextScore = touchScoreTimestampsForSave(
      state.document.score,
      state.scoreOrigin,
    );

    try {
      saveScoreToLocalStorage(nextScore);
      session.setState({
        ...state,
        document: {
          ...state.document,
          score: nextScore,
        },
        scoreOrigin: "saved",
        statusMessage: {
          level: "info",
          text: "Score saved to local storage.",
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown local save error.";

      session.setState({
        ...state,
        statusMessage: {
          level: "error",
          text: message,
        },
      });
    }

    syncLeftStatus(dom, session.getState());
  });

  dom.localLoadButton.addEventListener("click", () => {
    try {
      const jsonText = loadScoreFromLocalStorage();

      if (jsonText === null) {
        const state = session.getState();

        session.setState({
          ...state,
          statusMessage: {
            level: "warning",
            text: "No local score is saved.",
          },
        });
        syncLeftStatus(dom, session.getState());
        return;
      }

      session.loadScoreJsonText(jsonText, "local storage");
    } catch (error: unknown) {
      const state = session.getState();
      const message = error instanceof Error ? error.message : "Unknown local load error.";

      session.setState({
        ...state,
        statusMessage: {
          level: "error",
          text: message,
        },
      });
      syncLeftStatus(dom, session.getState());
    }
  });
}
