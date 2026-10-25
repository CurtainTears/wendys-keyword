const novelty =
  /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Junior|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)(?:\b|$)/i;

export const voiceKey = (voice) =>
  voice.voiceURI || `${voice.name}|${voice.lang}`;

export function englishVoices(voices) {
  return voices.filter(
    (v) =>
      v.localService === true &&
      /^en(?:[-_]|$)/i.test(v.lang) &&
      !novelty.test(v.name),
  );
}

export function chooseVoice(voices, preferred = "") {
  const available = englishVoices(voices);
  const selected = available.find((v) => voiceKey(v) === preferred);
  if (selected) return selected;
  const score = (v) =>
    (/premium|enhanced|natural|neural/i.test(v.name) ? 100 : 0) +
    (/Samantha|Alex|Aria|Jenny|Guy|Zira|David|Daniel/i.test(v.name) ? 60 : 0) +
    (v.default ? 30 : 0) +
    (/^en[-_]US$/i.test(v.lang) ? 20 : 0);
  return available.sort((a, b) => score(b) - score(a))[0] || null;
}

export function speechPreferences(value = {}) {
  const number = (n, min, max, fallback) =>
    typeof n === "number" && Number.isFinite(n)
      ? Math.min(max, Math.max(min, n))
      : fallback;
  return {
    voice: typeof value?.voice === "string" ? value.voice : "",
    rate: number(value?.rate, 0.75, 1.1, 0.9),
    volume: number(value?.volume, 0.2, 1, 1),
  };
}

// One cancellable request owns both channels. Old media events must never
// restart a word or send it online after the user has moved on or opted out.
export function createPronunciation({
  synth = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  createAudio = () => new Audio(),
  onChange = () => {},
  onVoicesChanged = () => {},
  schedule = setTimeout,
  cancelTimer = clearTimeout,
} = {}) {
  let preferences = speechPreferences(),
    generation = 0,
    current = null;
  let audio = null,
    utterance = null,
    timer = null,
    cleanAudio = () => {};
  const voices = () => synth?.getVoices?.() || [];
  function emit(state, channel = "", message = "") {
    onChange({ state, channel, message });
  }
  function clearTimer() {
    cancelTimer(timer);
    timer = null;
  }
  function stop() {
    generation++;
    current = null;
    clearTimer();
    cleanAudio();
    cleanAudio = () => {};
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    if (utterance)
      utterance.onstart = utterance.onend = utterance.onerror = null;
    utterance = null;
    synth?.cancel();
    emit("idle");
  }
  function local(request, fromOnline = false) {
    if (request.id !== generation) return;
    const voice = chooseVoice(voices(), preferences.voice);
    if (!synth || !Utterance || !voice) {
      request.waiting = true;
      emit("unavailable", "local", "未找到本机英语音色 · 请检查发音设置");
      return;
    }
    request.waiting = false;
    const u = new Utterance(request.word);
    utterance = u;
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = preferences.rate;
    u.pitch = 1;
    u.volume = preferences.volume;
    const valid = () => request.id === generation && utterance === u;
    emit("loading", "local", fromOnline ? "在线发音不可用 · 改用本机英语" : "");
    const failed = () => {
      if (!valid()) return;
      clearTimer();
      u.onstart = u.onend = u.onerror = null;
      synth.cancel();
      emit("error", "local", "本机朗读未成功 · 点此重试");
    };
    u.onstart = () => {
      if (!valid()) return;
      clearTimer();
      emit(
        "speaking",
        "local",
        fromOnline ? "在线发音不可用 · 改用本机英语" : "",
      );
    };
    u.onend = () => {
      if (!valid()) return;
      clearTimer();
      utterance = null;
      emit("idle", "local", fromOnline ? "在线发音不可用 · 改用本机英语" : "");
    };
    u.onerror = failed;
    timer = schedule(failed, 3000);
    try {
      synth.resume();
      synth.speak(u);
    } catch {
      failed();
    }
  }
  function dictionary(request) {
    if (request.id !== generation) return;
    try {
      audio ||= createAudio();
      audio.preload = "auto";
      audio.volume = preferences.volume;
      audio.playbackRate = preferences.rate;
      let settled = false;
      const valid = () => request.id === generation;
      const started = () => {
        if (!valid()) return;
        clearTimer();
        emit("speaking", "dictionary");
      };
      const ended = () => {
        if (!valid() || settled) return;
        settled = true;
        clearTimer();
        cleanAudio();
        emit("idle", "dictionary");
      };
      const failed = () => {
        if (!valid() || settled) return;
        settled = true;
        clearTimer();
        cleanAudio();
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
        local(request, true);
      };
      cleanAudio = () => {
        audio.removeEventListener("playing", started);
        audio.removeEventListener("ended", ended);
        audio.removeEventListener("error", failed);
      };
      audio.addEventListener("playing", started);
      audio.addEventListener("ended", ended);
      audio.addEventListener("error", failed);
      emit("loading", "dictionary");
      // Only the current English target is shared after explicit opt-in.
      // Meanings and private library metadata are never used as fallback audio.
      audio.src = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(request.word)}&type=2`;
      timer = schedule(failed, 3000);
      audio.play()?.catch(failed);
    } catch {
      clearTimer();
      local(request, true);
    }
  }
  synth?.addEventListener?.("voiceschanged", () => {
    onVoicesChanged();
    if (current?.waiting) local(current);
  });
  return {
    voices,
    stop,
    configure(value) {
      preferences = speechPreferences({ ...preferences, ...value });
    },
    preferences: () => ({ ...preferences }),
    speak(word, { online = false } = {}) {
      stop();
      const text = String(word || "").trim();
      if (!text) return;
      current = { id: generation, word: text, waiting: false };
      if (online) dictionary(current);
      else local(current);
    },
  };
}
