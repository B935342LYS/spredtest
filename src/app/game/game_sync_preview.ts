/** Sync 설정창의 테스트 노트와 beep를 하나의 오디오 시계로 실행한다. */
export type GameSyncPreview = {
  /**
   * 예약된 소리와 화면 갱신을 중지하고 자원을 해제한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  dispose(): void;
};

/**
 * 800ms 간격의 테스트 노트와 beep를 시작한다.
 * - 인수 : container : 고정 기준선을 포함한 미리보기 영역
 * - 인수 : getOffsetMs : 최신 Display offset 조회
 * - 인수 : onBeat : Input Sync용 원래 beep 시각(performance.now 기준) 통지
 * - 인수 : onError : 오디오 초기화 실패 처리
 * - 반환값 : 미리보기 종료 핸들
 */
export function createGameSyncPreview(
  container: HTMLElement,
  getOffsetMs: () => number,
  onBeat: (atMs: number) => void,
  onError: (error: unknown) => void,
): GameSyncPreview {
  const context = new AudioContext();
  const notes = Array.from({ length: 4 }, () => {
    const note = document.createElement("span");
    note.className = "practice-preview-note";
    note.setAttribute("aria-hidden", "true");
    container.append(note);
    return note;
  });
  const voices = new Map<OscillatorNode, GainNode>();
  let disposed = false;
  let rafId: number | null = null;
  let origin = 0;
  let nextBeat = 1;
  let lastBeat = 0;
  const period = 0.8;

  /**
   * 오디오 시계의 지정 시각에 짧은 beep를 예약한다.
   * - 인수 : at : AudioContext 초 단위 시작 시각
   * - 반환값 : 없음
   */
  const scheduleBeep = (at: number): void => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
    oscillator.connect(gain);
    gain.connect(context.destination);
    voices.set(oscillator, gain);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      voices.delete(oscillator);
    };
    oscillator.start(at);
    oscillator.stop(at + 0.12);
  };

  /**
   * 같은 시계의 노트 위치·beep 예약·입력 meter 기준 시각을 갱신한다.
   * - 인수 : 없음
   * - 반환값 : 없음
   */
  const update = (): void => {
    if (disposed) return;
    const now = context.currentTime;
    const elapsed = now - origin;
    // 백그라운드에서 놓친 beep는 몰아서 재생하지 않고 다음 박자부터 예약한다.
    nextBeat = Math.max(nextBeat, Math.ceil(elapsed / period));
    if (origin + nextBeat * period <= now + 0.12) {
      scheduleBeep(origin + nextBeat * period);
      nextBeat += 1;
    }
    const beat = Math.floor(elapsed / period);
    if (beat > lastBeat) {
      lastBeat = beat;
      onBeat(performance.now() - (elapsed - beat * period) * 1000);
    }
    const offset = getOffsetMs() / 1000;
    // 화면 보정 후 노트가 기준선에 닿은 시각부터 140ms 동안 접촉 효과를 감쇠한다. 소리 예약은 변경하지 않는다.
    const displayElapsed = elapsed - offset;
    const contactBeat = Math.floor(displayElapsed / period);
    const contactAge = displayElapsed - contactBeat * period;
    const contactStrength = contactBeat >= 1 ? Math.max(0, 1 - contactAge / 0.14) : 0;
    container.style.setProperty("--practice-contact-strength", String(contactStrength));
    const first = Math.floor((elapsed - offset) / period) - 1;
    // 양수 보정은 노트의 기준선 접촉만 늦춘다. beep와 Input Sync의 기준 시각은 그대로다.
    notes.forEach((note, index) => {
      const beatIndex = first + index;
      const x = 50 + ((beatIndex * period + offset - elapsed) / 1.6) * 90;
      note.hidden = beatIndex < 1 || x < 0 || x > 100;
      note.style.left = `${x}%`;
    });
    rafId = requestAnimationFrame(update);
  };

  void context.resume().then(() => {
    if (disposed) return;
    origin = context.currentTime;
    rafId = requestAnimationFrame(update);
  }).catch(error => { if (!disposed) onError(error); });

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      // Stop/닫기 이후에도 예약된 oscillator가 울리지 않도록 연결과 스케줄을 함께 정리한다.
      for (const [oscillator, gain] of voices) {
        oscillator.stop();
        oscillator.disconnect();
        gain.disconnect();
      }
      voices.clear();
      notes.forEach(note => note.remove());
      container.style.removeProperty("--practice-contact-strength");
      void context.close();
    },
  };
}
