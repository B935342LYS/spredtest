/** 첫 사용 안내와 Help 재진입을 연결하며 악보 상태는 변경하지 않는다. */

const SEEN_KEY = "spred.gettingStarted.seen";

/**
 * 첫 사용 안내의 언어 선택, 닫기 기록, Help 재열기를 연결한다.
 * - 인수 : 없음
 * - 반환값 : 없음
 */
export function bindGettingStarted(): void {
  const dialog = document.querySelector<HTMLDialogElement>("#getting-started")!;
  const trigger = document.querySelector<HTMLButtonElement>(".getting-started-button")!;
  const title = dialog.querySelector<HTMLElement>("#getting-started-title")!;
  const closeButton = dialog.querySelector<HTMLButtonElement>(".getting-started-close")!;
  const languageButtons = dialog.querySelectorAll<HTMLButtonElement>("[data-welcome-language]");
  const sections = dialog.querySelectorAll<HTMLElement>("[data-welcome-content]");

  /**
   * 표시 언어와 접근성 상태를 함께 변경한다.
   * - 인수 : language : 선택한 한국어 또는 영어
   * - 반환값 : 없음
   */
  function setLanguage(language: "ko" | "en"): void {
    dialog.lang = language;
    title.textContent = language === "ko" ? "처음 사용하시나요?" : "New to SPRED?";
    closeButton.textContent = language === "ko" ? "시작하기" : "Get started";
    // 선택한 언어만 노출하고 버튼의 선택 상태를 보조 기술에도 전달한다.
    for (const section of sections) {
      section.hidden = section.dataset.welcomeContent !== language;
    }
    for (const button of languageButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.welcomeLanguage === language));
    }
  }

  for (const button of languageButtons) {
    button.addEventListener("click", /**
     * 선택한 언어의 안내를 표시한다.
     * - 인수 : 없음
     * - 반환값 : 없음
     */ () => setLanguage(button.dataset.welcomeLanguage === "ko" ? "ko" : "en"));
  }
  trigger.addEventListener("click", /**
   * 확인 이력과 무관하게 Help에서 안내를 다시 연다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */ () => {
    if (!dialog.open) dialog.showModal();
  });
  dialog.addEventListener("close", /**
   * 시작하기 또는 Escape로 닫았을 때 확인 사실을 저장한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */ () => {
    // 저장소 접근이 차단되어도 안내 종료와 앱 사용은 계속 허용한다.
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // 저장 불가 환경에서는 다음 방문 때 다시 안내할 수 있다.
    }
  });

  setLanguage(navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en");
  let seen = false;
  try {
    seen = localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // 저장 여부를 읽지 못하면 첫 안내를 제공한다.
  }
  if (!seen) dialog.showModal();
}
