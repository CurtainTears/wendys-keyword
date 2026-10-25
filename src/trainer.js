import { createPractice } from "./practice.mjs";
import { isPracticeChar } from "../shared/words.mjs";
import {
  createPronunciation,
  englishVoices,
  chooseVoice,
  voiceKey,
} from "./pronunciation.mjs";

export function createTrainer({
  onComplete,
  onRestart,
  onWrong,
  onCheckpoint = () => {},
  onPreferences = () => {},
}) {
  const $id = (id) => document.getElementById(id);
  const engine = createPractice(),
    S = engine.state;
  let blocked = false;
  const FB = {
    shakeFire: 0.35,
    shakeWord: 1.6,
    shakeError: 7,
    shakeBreak: 13,
    hitstopWord: 0.05,
    comboMax: 60,
    multStep: 0.08,
  };
  let activeDeck = null,
    pausedByUser = false,
    completedId = null;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let speechActive = false;
  const AU = {
    ac: null,
    master: null,
    noise: null,
    ok: false,
    verb: null,
    verbGain: null,
    init() {
      if (this.ok) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ac = new AC();

        this.master = this.ac.createGain();
        this.master.gain.value = speechActive ? 0.12 : 0.5;
        const comp = this.ac.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 22;
        comp.ratio.value = 9;
        comp.attack.value = 0.003;
        comp.release.value = 0.16;
        this.master.connect(comp);
        comp.connect(this.ac.destination);

        const dly = this.ac.createDelay(0.5);
        dly.delayTime.value = 0.085;
        const fb = this.ac.createGain();
        fb.gain.value = 0.26;
        const damp = this.ac.createBiquadFilter();
        damp.type = "lowpass";
        damp.frequency.value = 2600;
        this.verbGain = this.ac.createGain();
        this.verbGain.gain.value = 0.2;
        this.verbGain.connect(dly);
        dly.connect(damp);
        damp.connect(fb);
        fb.connect(dly);
        damp.connect(this.master);
        this.verb = dly;

        const len = this.ac.sampleRate * 0.6;
        const b = this.ac.createBuffer(1, len, this.ac.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.noise = b;
        this.ok = true;
      } catch (e) {
        this.ok = false;
      }
    },
    on() {
      return this.ok && $id("cbSound").checked;
    },

    unlock() {
      this.init();
      if (!this.ac) return false;
      if (this.ac.state !== "running") {
        try {
          this.ac.resume();
        } catch (e) {}

        try {
          const s = this.ac.createBufferSource();
          const b = this.ac.createBuffer(1, 1, this.ac.sampleRate);
          s.buffer = b;
          s.connect(this.ac.destination);
          s.start(0);
        } catch (e) {}
      }
      return this.ac.state === "running";
    },
    resume() {
      this.unlock();
    },
    tone(f0, f1, dur, type, vol, q, dest) {
      if (!this.on()) return;
      const t = this.ac.currentTime;
      const o = this.ac.createOscillator(),
        g = this.ac.createGain();
      o.type = type || "square";
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0)
        o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol == null ? 0.09 : vol, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      let tail = g;
      if (q) {
        const f = this.ac.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.setValueAtTime(q, t);
        g.connect(f);
        tail = f;
      }
      tail.connect(this.master);
      if (this.verb) {
        const s = this.ac.createGain();
        s.gain.value = 0.5;
        tail.connect(s);
        s.connect(this.verb);
      }
      o.start(t);
      o.stop(t + dur + 0.02);
    },
    nz(dur, f0, f1, vol, type) {
      if (!this.on()) return;
      const t = this.ac.currentTime;
      const s = this.ac.createBufferSource();
      s.buffer = this.noise;
      const g = this.ac.createGain(),
        f = this.ac.createBiquadFilter();
      f.type = type || "lowpass";
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(vol == null ? 0.16 : vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f);
      f.connect(g);
      g.connect(this.master);
      if (this.verb) {
        const w = this.ac.createGain();
        w.gain.value = 0.35;
        g.connect(w);
        w.connect(this.verb);
      }
      s.start(t);
      s.stop(t + dur + 0.02);
    },

    hit() {
      if (!this.on()) return;
      const t = this.ac.currentTime;
      const f = comboFreq();
      const n = comboNorm();
      const dur = 0.085 + n * 0.075;

      this.nz(0.022, 5200, 1400, 0.085 + 0.05 * n, "highpass");

      const o = this.ac.createOscillator(),
        g = this.ac.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(f * 0.8, t);
      o.frequency.exponentialRampToValueAtTime(f, t + dur * 0.42);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.115 + 0.075 * n, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(this.master);
      if (this.verb) {
        const s = this.ac.createGain();
        s.gain.value = 0.42;
        g.connect(s);
        s.connect(this.verb);
      }
      o.start(t);
      o.stop(t + dur + 0.02);

      const s2 = this.ac.createOscillator(),
        g2 = this.ac.createGain();
      s2.type = "sine";
      s2.frequency.setValueAtTime(f / 2, t);
      g2.gain.setValueAtTime(0, t);
      g2.gain.linearRampToValueAtTime(0.075 + 0.05 * n, t + 0.006);
      g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.1 + n * 0.06);
      s2.connect(g2);
      g2.connect(this.master);
      s2.start(t);
      s2.stop(t + 0.22);

      if (n > 0.2) {
        const o3 = this.ac.createOscillator(),
          g3 = this.ac.createGain();
        o3.type = "sine";
        o3.frequency.setValueAtTime(f * 2, t);
        g3.gain.setValueAtTime(0, t);
        g3.gain.linearRampToValueAtTime(0.03 * n, t + 0.004);
        g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        o3.connect(g3);
        g3.connect(this.master);
        if (this.verb) {
          const w = this.ac.createGain();
          w.gain.value = 0.6;
          g3.connect(w);
          w.connect(this.verb);
        }
        o3.start(t);
        o3.stop(t + 0.1);
      }
    },

    wordDone() {
      if (!this.on()) return;
      const t = this.ac.currentTime,
        f = comboFreq();
      [1, 1.26, 1.5].forEach((m, i) => {
        const o = this.ac.createOscillator(),
          g = this.ac.createGain();
        o.type = "triangle";
        const s = t + i * 0.042;
        o.frequency.setValueAtTime(f * m * 0.85, s);
        o.frequency.exponentialRampToValueAtTime(f * m, s + 0.05);
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(0.1, s + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.2);
        o.connect(g);
        g.connect(this.master);
        if (this.verb) {
          const v = this.ac.createGain();
          v.gain.value = 0.7;
          g.connect(v);
          v.connect(this.verb);
        }
        o.start(s);
        o.stop(s + 0.24);
      });

      const b = this.ac.createOscillator(),
        bg = this.ac.createGain();
      b.type = "sine";
      b.frequency.setValueAtTime(150, t);
      b.frequency.exponentialRampToValueAtTime(48, t + 0.16);
      bg.gain.setValueAtTime(0.16, t);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      b.connect(bg);
      bg.connect(this.master);
      b.start(t);
      b.stop(t + 0.22);
    },

    miss() {
      if (!this.on()) return;
      const t = this.ac.currentTime;
      this.nz(0.16, 2600, 180, 0.2);
      this.tone(210, 68, 0.2, "sawtooth", 0.09, 900);
      this.tone(158, 52, 0.26, "square", 0.06, 700);
    },
  };

  const SCALE = [
    0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33, 36, 38, 40, 42, 44,
  ];
  const BASE = 196; // G3：起点压低一个八度，留出向上的空间
  const STEP_PER = 2; // 每 2 连击一个音级
  const CENTS_PER = 4; // 音级走完后每连击再涨多少音分（渐弱）
  const CEIL_HZ = 1850 * 2; // 约 F#6，triangle 波在此不刺耳

  function comboStep() {
    return Math.min(SCALE.length - 1, Math.floor(S.combo / STEP_PER));
  }

  function comboFreq() {
    const raw = S.combo / STEP_PER;
    const idx = Math.floor(raw);
    let hz;
    if (idx < SCALE.length - 1) {
      const lo = SCALE[idx],
        hi = SCALE[idx + 1];
      hz = BASE * Math.pow(2, (lo + (hi - lo) * (raw - idx)) / 12);
    } else {
      const top = SCALE[SCALE.length - 1];
      const over = raw - (SCALE.length - 1); // 超出音级的级数

      const semis =
        top + (over * CENTS_PER * STEP_PER) / 12 / (1 + over * 0.55);
      hz = BASE * Math.pow(2, semis / 12);
    }
    return hz > CEIL_HZ ? CEIL_HZ * (1 + Math.log(hz / CEIL_HZ) * 0.02) : hz;
  }

  function comboNorm() {
    return Math.min(1, S.combo / 40);
  }
  let speechState = { state: "idle", message: "" };
  const pronunciation = createPronunciation({
    onChange(value) {
      speechState = value;
      speechActive = ["loading", "speaking"].includes(value.state);
      if (AU.master)
        AU.master.gain.setTargetAtTime(
          speechActive ? 0.12 : 0.5,
          AU.ac.currentTime,
          0.025,
        );
      refreshTtsBadge();
    },
    onVoicesChanged: renderVoices,
  });
  function renderVoices() {
    const select = $id("ttsVoice"),
      settings = pronunciation.preferences();
    const voices = pronunciation.voices(),
      preferred = chooseVoice(voices);
    const option = (value, text) => {
      const node = document.createElement("option");
      node.value = value;
      node.textContent = text;
      return node;
    };
    select.replaceChildren(
      option(
        "",
        preferred ? `自动（${preferred.name}）` : "未找到本机英语音色",
      ),
    );
    for (const voice of englishVoices(voices))
      select.append(option(voiceKey(voice), `${voice.name} · ${voice.lang}`));
    select.value = englishVoices(voices).some(
      (v) => voiceKey(v) === settings.voice,
    )
      ? settings.voice
      : "";
  }
  function refreshTtsBadge() {
    const message = $id("cbTTS").checked ? speechState.message : "";
    $id("ttsBadge").textContent = message;
    $id("ttsBadge").classList.toggle("hide", !message);
  }
  function say(word = S.word) {
    if (
      !$id("cbTTS").checked ||
      !S.running ||
      S.done ||
      blocked ||
      S.status === "paused"
    )
      return;
    pronunciation.speak(word, { online: $id("cbOnline").checked });
  }
  function renderTTSVol() {
    const preferences = pronunciation.preferences();
    $id("ttsVol").textContent = "重听单词";
    $id("ttsVol").title =
      `重听当前词 · 音量 ${Math.round(preferences.volume * 100)}%`;
    $id("ttsVolumeLabel").textContent =
      `${Math.round(preferences.volume * 100)}%`;
  }
  function configureSpeech(value) {
    pronunciation.configure(value);
    const settings = pronunciation.preferences();
    $id("ttsRate").value = String(settings.rate);
    $id("ttsVolume").value = String(settings.volume * 100);
    renderVoices();
    renderTTSVol();
  }
  function isTouch() {
    return window.matchMedia("(hover:none) and (pointer:coarse)").matches;
  }
  function refreshAuBadge() {
    const blocked =
      !!(AU.ac && AU.ac.state !== "running") && $id("cbSound").checked;
    $id("auBadge").classList.toggle("hide", !blocked);
  }
  let shakeRAF = 0;
  function shake(amount) {
    if (reduceMotion.matches) return;
    S.shake = Math.max(S.shake, amount);
    if (shakeRAF) return;
    const step = () => {
      S.shake *= 0.65;
      $id("stage").style.transform =
        S.shake < 0.1
          ? ""
          : `translate(${((Math.random() * 2 - 1) * S.shake).toFixed(2)}px,${((Math.random() * 2 - 1) * S.shake).toFixed(2)}px)`;
      shakeRAF = S.shake < 0.1 ? 0 : requestAnimationFrame(step);
    };
    shakeRAF = requestAnimationFrame(step);
  }
  function flash(name) {
    const box = $id("wbox");
    box.classList.remove("flashGood", "flashBad");
    void box.offsetWidth;
    box.classList.add(name);
  }
  function formatTime(ms) {
    const sec = Math.floor(ms / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }
  function renderWord() {
    const node = $id("word");
    node.replaceChildren();
    [...S.word].forEach((char, i) => {
      const span = document.createElement("span"),
        punct = !/[\p{L}\p{N}]/u.test(char);
      span.className =
        "ch" +
        (char === " " ? " sp" : "") +
        (punct ? " pn" : "") +
        (i < S.typed ? " ok" : i === S.typed ? " cur" : " w");
      span.textContent =
        char === " "
          ? "␣"
          : $id("cbShow").checked && i >= S.typed && !punct
            ? "_"
            : char;
      node.append(span);
    });
    const cn = $id("cn");
    cn.textContent = S.cn || "未填写释义";
    cn.hidden = !$id("cbCn").checked;
    $id("progBar").style.width =
      (S.done ? 100 : (S.typed / Math.max(1, S.word.length)) * 100) + "%";
  }
  function renderStats() {
    const m = engine.metrics(),
      mult = (1 + Math.min(S.combo, FB.comboMax) * FB.multStep).toFixed(1);
    $id("sAcc").textContent = m.accuracy + "%";
    $id("sWpm").textContent = m.wpm;
    $id("sCombo").textContent = "×" + mult;
    $id("sWords").textContent = `${S.wordsDone} / ${S.poolLen}`;
    $id("sBest").textContent = S.best;
    $id("comboN").textContent = S.combo;
    $id("comboN").classList.toggle("zero", !S.combo);
    $id("comboMult").textContent = "×" + mult;
    $id("comboMult").classList.toggle("hot", S.combo >= 24);
    $id("metaTxt").textContent =
      S.status === "paused"
        ? "已暂停"
        : S.status === "ready"
          ? "第一个按键开始计时"
          : `${formatTime(m.duration)} · ${S.skipped} 词跳过`;
    renderTTSVol();
    refreshAuBadge();
  }
  function renderWrong() {
    const list = Object.values(S.wrong).sort((a, b) => b.n - a.n),
      box = $id("wlist");
    box.replaceChildren();
    $id("wCount").textContent = list.length;
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "本轮错词会留在这里，结束后可单独重练。";
      box.append(p);
      return;
    }
    list.forEach((w) => {
      const el = document.createElement("span");
      el.className = "witem";
      el.textContent = `${w.term} · ${w.meaning || "无释义"} ×${w.n}`;
      box.append(el);
    });
  }
  function announceComplete(notify = true) {
    if (!S.done || completedId === S.id) return;
    completedId = S.id;
    stopSpeech();
    $id("kb").blur();
    const result = engine.result(),
      m = engine.metrics();
    $id("dAcc").textContent = m.accuracy + "%";
    $id("dWpm").textContent = m.wpm;
    $id("dWords").textContent = S.wordsDone;
    $id("dCombo").textContent = S.best;
    $id("dTime").textContent = formatTime(m.duration);
    $id("done").classList.add("on");
    $id("main").hidden = true;
    const list = $id("dList");
    list.replaceChildren();
    result.words.forEach((w) => {
      const item = document.createElement("span");
      item.className = "ritem";
      item.textContent = `${w.term} · ${w.meaning || "无释义"}${w.status === "skipped" ? " · 已跳过" : w.mistakes ? " · 错 " + w.mistakes + " 次" : ""}`;
      list.append(item);
    });
    $id("btnWrong").disabled = !Object.keys(S.wrong).length;
    if (notify) onComplete(result);
  }
  function stopSpeech() {
    pronunciation.stop();
  }
  function process(out) {
    if (out.kind === "ignored") return;
    if (out.kind === "wrong") {
      AU.miss();
      shake(out.brokeCombo ? FB.shakeBreak : FB.shakeError);
      flash("flashBad");
      if (out.brokeCombo) AU.tone(220, 70, 0.18, "sawtooth", 0.1, 700);
      const ch = $id("word").children[out.index];
      ch?.classList.add("err");
      setTimeout(() => ch?.classList.remove("err"), 220);
    } else if (out.kind === "skip") {
      AU.nz(0.1, 1200, 400, 0.1);
      shake(FB.shakeError);
    } else {
      AU.hit();
      shake(
        out.kind === "word" || out.kind === "done"
          ? FB.shakeWord
          : FB.shakeFire,
      );
      if (out.kind === "word" || out.kind === "done") {
        AU.wordDone();
        flash("flashGood");
      }
    }
    if (out.kind !== "wrong") renderWord();
    renderStats();
    renderWrong();
    onCheckpoint(engine.snapshot());
    announceComplete();
    if (["correct", "word", "done"].includes(out.kind)) {
      const n = $id("comboN");
      n.classList.remove("pop");
      void n.offsetWidth;
      n.classList.add("pop");
      if (out.kind === "correct")
        $id("word").children[out.index]?.classList.add("pop");
    }
    const acc = $id("sAcc");
    acc.classList.add(out.kind === "wrong" ? "pulseBad" : "pulse");
    setTimeout(() => acc.classList.remove("pulse", "pulseBad"), 110);
    if (["word", "skip"].includes(out.kind)) say(S.word, S.cn);
  }
  function start(deck) {
    activeDeck = structuredClone(deck);
    stopSpeech();
    completedId = null;
    pausedByUser = false;
    engine.start(deck);
    $id("done").classList.remove("on");
    $id("main").hidden = false;
    $id("practiceEmpty").hidden = true;
    $id("practiceBody").hidden = false;
    $id("practiceDeckName").textContent = deck.title;
    $id("practiceVersion").textContent =
      `${deck.words.length} 词 · v${deck.version}`;
    $id("pauseButton").textContent = "暂停";
    renderWord();
    renderStats();
    renderWrong();
    say(S.word, S.cn);
    focusKeyboard();
  }
  function restore(deck, checkpoint, id) {
    activeDeck = structuredClone(deck);
    stopSpeech();
    completedId = null;
    pausedByUser = false;
    engine.restore(deck, checkpoint, id);
    $id("done").classList.remove("on");
    $id("main").hidden = false;
    $id("practiceEmpty").hidden = true;
    $id("practiceBody").hidden = false;
    $id("practiceDeckName").textContent = deck.title;
    $id("practiceVersion").textContent =
      `${deck.words.length} 词 · v${deck.version}`;
    $id("pauseButton").textContent = "暂停";
    renderWord();
    renderStats();
    renderWrong();
    if (S.done) announceComplete(false);
    else focusKeyboard();
  }
  function pause() {
    engine.pause();
    stopSpeech();
    renderStats();
    if (activeDeck && S.running) onCheckpoint(engine.snapshot());
  }
  function resume() {
    if (!pausedByUser && !blocked) {
      engine.resume();
      renderStats();
      focusKeyboard();
    }
  }
  function reset() {
    stopSpeech();
    engine.pause();
    S.running = false;
    S.status = "idle";
    activeDeck = null;
    $id("practiceBody").hidden = true;
    $id("practiceEmpty").hidden = false;
  }
  function keyInput(ch) {
    if (blocked) return;
    AU.unlock();
    process(engine.input(ch));
  }
  const kb = $id("kb");
  const typingActions = new Set([
    "ttsVol",
    "ttsBadge",
    "auBadge",
    "btnNext",
    "pauseButton",
    "btnReset",
  ]);
  for (const id of typingActions)
    $id(id).addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && document.activeElement === kb)
        event.preventDefault();
    });
  function setBlocked(value) {
    blocked = value;
    for (const id of ["kb", "btnNext", "pauseButton", "btnReset", "btnAgain"])
      $id(id).disabled = value;
    $id("btnWrong").disabled = value || !Object.keys(S.wrong).length;
    if (value) pause();
  }
  let composing = false;
  function focusKeyboard() {
    if (
      blocked ||
      !S.running ||
      S.done ||
      S.status === "paused" ||
      composing ||
      document.hidden ||
      $id("practiceView").hidden ||
      document.querySelector("dialog[open]")
    )
      return;
    kb.focus({ preventScroll: true });
    if (isTouch()) $id("wbox").scrollIntoView({ block: "center" });
  }
  $id("wbox").addEventListener("click", () => {
    AU.unlock();
    focusKeyboard();
    say();
  });
  $id("wbox").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      focusKeyboard();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (
      e.defaultPrevented ||
      $id("practiceView").hidden ||
      document.querySelector("dialog[open]") ||
      e.isComposing ||
      composing ||
      !S.running ||
      S.status === "paused"
    )
      return;
    const target = e.target,
      editing =
        target !== kb &&
        ((target.closest(
          "input,textarea,select,button,a,summary,[role=button]",
        ) &&
          target !== $id("wbox")) ||
          target.isContentEditable);
    const action = target.closest("button");
    const typingFromAction =
      typingActions.has(action?.id) &&
      (e.key === "Escape" || (e.key !== " " && isPracticeChar(e.key)));
    if ((editing && !typingFromAction) || e.ctrlKey || e.metaKey || e.altKey)
      return;
    if (e.key === "Escape") {
      e.preventDefault();
      process(engine.skip());
      return;
    }
    if (isPracticeChar(e.key)) {
      e.preventDefault();
      if (typingFromAction) focusKeyboard();
      keyInput(e.key);
    }
  });
  kb.addEventListener("beforeinput", (e) => {
    if (composing || e.isComposing || document.querySelector("dialog[open]"))
      return;
    if (isPracticeChar(e.data)) {
      e.preventDefault();
      keyInput(e.data);
    }
  });
  kb.addEventListener("input", () => {
    const value = kb.value;
    kb.value = "";
    if (!composing && isPracticeChar(value)) keyInput(value);
  });
  kb.addEventListener("compositionstart", () => {
    composing = true;
  });
  kb.addEventListener("compositionend", () => {
    composing = false;
    kb.value = "";
  });
  $id("btnNext").addEventListener("click", () => {
    process(engine.skip());
    focusKeyboard();
  });
  for (const id of ["btnReset", "btnAgain"])
    $id(id).addEventListener("click", async () => {
      if (!activeDeck) return;
      const b = $id(id);
      b.disabled = true;
      try {
        await onRestart(activeDeck.id);
      } finally {
        b.disabled = false;
        focusKeyboard();
      }
    });
  $id("btnWrong").addEventListener("click", async () => {
    if (activeDeck) {
      const ids = new Set(Object.keys(S.wrong));
      if (onWrong) {
        try {
          await onWrong([...ids]);
        } finally {
          focusKeyboard();
        }
        return;
      }
      start({
        ...activeDeck,
        words: activeDeck.words.filter((w) => ids.has(w.id)),
      });
    }
  });
  $id("pauseButton").addEventListener("click", () => {
    pausedByUser = !pausedByUser;
    if (pausedByUser) pause();
    else {
      engine.resume();
      renderStats();
    }
    $id("pauseButton").textContent = pausedByUser ? "继续练习" : "暂停";
    if (!pausedByUser) focusKeyboard();
  });
  for (const id of ["cbShow", "cbCn"])
    $id(id).addEventListener("change", () => {
      renderWord();
      onPreferences();
    });
  for (const id of ["cbSound", "cbTTS", "cbOnline"])
    $id(id).addEventListener("change", () => {
      stopSpeech();
      if ($id("cbTTS").checked && id !== "cbSound") say();
      refreshTtsBadge();
      onPreferences();
    });
  $id("auBadge").addEventListener("click", () => {
    AU.unlock();
    refreshAuBadge();
    focusKeyboard();
  });
  for (const id of ["ttsBadge", "ttsVol"])
    $id(id).addEventListener("click", () => {
      say();
      focusKeyboard();
    });
  for (const id of ["ttsVoice", "ttsRate", "ttsVolume"])
    $id(id).addEventListener("change", () => {
      pronunciation.configure({
        voice: $id("ttsVoice").value,
        rate: Number($id("ttsRate").value),
        volume: Number($id("ttsVolume").value) / 100,
      });
      renderTTSVol();
      say();
      onPreferences();
    });
  $id("ttsVolume").addEventListener("input", () => {
    pronunciation.configure({ volume: Number($id("ttsVolume").value) / 100 });
    renderTTSVol();
  });
  // Pointer changes should return to typing; Tab/arrow-key users keep their
  // chosen control. Never use a blur timer that can steal focus from a dialog.
  let pointerSettings = false;
  const settings = document.querySelector(".practice-settings");
  settings.addEventListener("pointerdown", () => {
    pointerSettings = true;
  });
  settings.addEventListener("keydown", () => {
    pointerSettings = false;
  });
  settings.addEventListener("change", () => {
    if (pointerSettings) focusKeyboard();
  });
  configureSpeech({});
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pause();
      kb.blur();
    } else if (
      !$id("practiceView").hidden &&
      !document.querySelector("dialog[open]")
    )
      resume();
  });
  setInterval(() => {
    if (!$id("practiceView").hidden && S.running) renderStats();
  }, 500);
  return {
    start,
    restore,
    setBlocked,
    configureSpeech,
    speechPreferences: pronunciation.preferences,
    snapshot: () => engine.snapshot(),
    pause,
    resume,
    reset,
    get state() {
      return S;
    },
  };
}
