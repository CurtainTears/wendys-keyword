import { createPractice } from "./practice.mjs";
import { isPracticeChar, targetFor } from "../shared/words.mjs";

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
        this.master.gain.value = 0.5;
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
  const TTS_MIN = 0.55,
    TTS_PROG_GAIN = 0.15,
    TTS_COMBO_LIN = 0.28,
    TTS_COMBO_SQR = 0.24;
  function ttsVolume() {
    const prog = Math.min(1, S.wordsDone / Math.max(1, S.poolLen)); // 本轮 30 词进度
    const k = Math.min(1, S.combo / 60); // 连击 60 封顶（60 键≈12 个词，不容易打满）
    return Math.min(
      1,
      TTS_MIN +
        prog * TTS_PROG_GAIN +
        k * TTS_COMBO_LIN +
        k * k * TTS_COMBO_SQR,
    );
  }

  let ttsUnlocked = false;
  let justUnlockedTap = false; // 解锁那个手势已经补播过，词框 click 别再重复念
  function ttsUnlock() {
    if (ttsUnlocked) return;

    ttsUnlocked = true;
    auUnlock(); // 手势内解锁音频通道（兜底通道要用）
    try {
      // 预读嗓音表：安卓嗓音是异步填的，读一下能催它加载
      if (window.speechSynthesis && window.speechSynthesis.getVoices)
        window.speechSynthesis.getVoices();
    } catch (e) {}

    if (isTouch() && $id("cbTTS").checked && S.running && !S.done && S.word) {
      justUnlockedTap = true;
      say(S.word, S.cn, true);
    }
  }

  let ttsAttempts = 0,
    ttsStarts = 0,
    ttsLastErr = "";
  const ttsSupported = () =>
    !!window.speechSynthesis &&
    typeof window.SpeechSynthesisUtterance === "function";
  function refreshTtsBadge() {
    const el = $id("ttsBadge");
    const unavailable = !ttsSupported() || (ttsAttempts > 0 && ttsStarts === 0);
    const msg =
      $id("cbTTS").checked && unavailable
        ? $id("cbOnline").checked
          ? "朗读未就绪 · 点此重试"
          : "本机语音未就绪 · 点此重试"
        : "";
    el.textContent = msg;
    el.classList.toggle("hide", !msg);
  }

  const DICT_AUDIO = "https://dict.youdao.com/dictvoice?audio=";

  const SILENT_WAV =
    "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA==";
  let auEl = null,
    auUnlocked = false,
    auFail = 0,
    auPlay = 0;
  function auGet() {
    if (!auEl) {
      auEl = new Audio();
      auEl.preload = "auto";

      auEl.addEventListener("error", () => {
        if (auUnlocked) {
          auFail++;
          refreshTtsBadge();
        }
      });
      auEl.addEventListener("playing", () => {
        auPlay++;
        ttsStarts++;
        refreshTtsBadge();
      });
    }
    return auEl;
  }

  function auUnlock() {
    if (auUnlocked) return;
    auUnlocked = true;
    try {
      const a = auGet();
      a.volume = 0;
      a.src = SILENT_WAV;
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  const AU_MEM = new Map(); // 词 -> 成功过的方案下标
  let auTok = 0; // 新请求作废旧请求：打字快时后词直接覆盖前词
  function auPlans(word, cn) {
    const w = String(word || "").trim(),
      P = [];
    if (!w) return P;
    P.push({ k: "one", u: DICT_AUDIO + encodeURIComponent(w) + "&type=2" });
    P.push({ k: "one", u: DICT_AUDIO + encodeURIComponent(w) + "&type=1" });

    const parts = w
      .replace(/[-—–\/]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length > 1) P.push({ k: "seq", p: parts });
    if (cn && String(cn).trim())
      P.push({
        k: "one",
        u: DICT_AUDIO + encodeURIComponent(String(cn).trim()) + "&le=zh",
      });
    return P;
  }

  function playOne(a, url, mode, onOK, onFail) {
    let settled = false,
      started = false,
      to = 0;
    const fin = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      a.removeEventListener("error", hErr);
      a.removeEventListener("playing", hPlay);
      a.removeEventListener("ended", hEnd);
      ok ? onOK && onOK() : onFail && onFail();
    };
    const hErr = () => fin(false);
    const hPlay = () => {
      started = true;
      if (mode === "start") fin(true);
    };
    const hEnd = () => {
      if (mode === "end") fin(true);
    };
    a.addEventListener("error", hErr);
    a.addEventListener("playing", hPlay);
    a.addEventListener("ended", hEnd);

    to = setTimeout(() => fin(started), mode === "end" ? 4000 : 2500);
    try {
      a.src = url;
      const p = a.play();
      if (p && p.catch) p.catch(() => fin(false));
    } catch (e) {
      fin(false);
    }
    renderTTSVol();
  }
  function runPlan(a, plan, onOK, onFail) {
    if (plan.k === "one") {
      playOne(a, plan.u, "start", onOK, onFail);
      return;
    }
    const parts = plan.p;
    let idx = 0;
    (function next() {
      if (idx >= parts.length) {
        onOK && onOK();
        return;
      }
      const last = idx === parts.length - 1;
      playOne(
        a,
        DICT_AUDIO + encodeURIComponent(parts[idx]) + "&type=2",
        last ? "start" : "end",
        () => {
          idx++;
          next();
        },
        onFail,
      );
    })();
  }
  function auRun(word, cn) {
    const w = String(word || "").trim();
    const P = auPlans(w, cn);
    if (!P.length) return;
    const memo = AU_MEM.get(w);
    const start = typeof memo === "number" && memo < P.length ? memo : 0;
    const my = ++auTok;
    let i = start,
      tries = 0;
    (function attempt() {
      if (my !== auTok) return; // 被后一个词作废
      if (tries++ >= P.length) return; // 全链失败：这个词确实念不了，放弃
      const pl = P[i];
      const a = auGet();
      a.volume = ttsVolume(); // 同样「越打越响」
      runPlan(
        a,
        pl,
        () => {
          if (my === auTok) AU_MEM.set(w, i);
        }, // 记住这一级，下次直接走
        () => {
          if (my !== auTok) return;
          i = (i + 1) % P.length;
          attempt();
        },
      );
    })();
  }
  function sayAudio(t, cn) {
    if (!$id("cbOnline").checked) return;
    try {
      auRun(t, cn === undefined ? S.cn : cn);
    } catch (e) {
      if (auUnlocked) auFail++;
    }
  }
  let ttsVoice = null,
    ttsTok = 0,
    ttsChannel = null,
    ttsLastText = "";

  try {
    if (window.speechSynthesis && window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener("voiceschanged", function () {
        ttsVoice = null;
        pickVoice();
      });
    }
  } catch (e) {}
  function pickVoice() {
    try {
      const ss = window.speechSynthesis;
      const vs = ss && ss.getVoices ? ss.getVoices() : [];
      if (!vs || !vs.length) return ttsVoice; // 列表还没就绪：沿用上次选中的，别漂移
      const v =
        vs.find((x) => /^en[-_]?US/i.test(x.lang)) ||
        vs.find((x) => /^en/i.test(x.lang)) ||
        null;
      if (v) ttsVoice = v;
      return ttsVoice;
    } catch (e) {
      return ttsVoice;
    }
  }

  function stopDict() {
    try {
      auTok++;
    } catch (e) {}
    try {
      if (auEl) {
        auEl.pause();
        try {
          auEl.currentTime = 0;
        } catch (e) {}
      }
    } catch (e) {}
  }
  function say(t, cn, force) {
    try {
      if (!$id("cbTTS").checked) return; // 开关关了就不念
      const cnx = cn === undefined ? S.cn : cn;
      const txt = String(t == null ? "" : t);

      if (!ttsSupported()) {
        stopDict();
        ttsChannel = "dict";
        ttsLastText = txt;
        sayAudio(t, cnx);
        return;
      }
      const ss = window.speechSynthesis;

      if (!force && txt && txt === ttsLastText && (ss.speaking || ss.pending))
        return;
      const my = ++ttsTok; // 新的一句：作废上一句的 watchdog / 延迟 speak / 回调
      stopDict(); // 开 Web Speech 前先停掉可能在响的词典音频
      const u = new SpeechSynthesisUtterance(t);
      u.lang = "en-US";
      u.rate = 0.92;
      u.volume = ttsVolume(); // 越打越响
      const v = pickVoice();
      if (v) u.voice = v; // 显式选 en-US 嗓音，避开默认语种缺失

      ttsAttempts++;
      const wd = setTimeout(() => {
        if (my !== ttsTok) return; // 已被更新的朗读取代：不兜底、不叠播
        if (u.__started || ss.speaking || ss.pending) {
          u.__started = true;
          refreshTtsBadge();
          return;
        }

        if (!u.__fb) {
          u.__fb = true;
          try {
            ss.cancel();
          } catch (e) {}
          ttsChannel = "dict";
          sayAudio(t, cnx);
        }
        refreshTtsBadge();
      }, 1800);
      u.onstart = () => {
        if (my !== ttsTok) return;
        u.__started = true;
        ttsStarts++;
        ttsLastErr = "";
        clearTimeout(wd);
        try {
          ss.resume();
        } catch (e) {}
        refreshTtsBadge();
      };
      u.onerror = (e) => {
        if (my !== ttsTok) return;
        ttsLastErr = (e && e.error) || "error";
        if (!u.__fb) {
          u.__fb = true;
          try {
            ss.cancel();
          } catch (e) {}
          ttsChannel = "dict";
          sayAudio(t, cnx);
        }
        refreshTtsBadge();
      };
      u.onend = () => {
        if (my !== ttsTok) return;
        clearTimeout(wd);
        try {
          ss.resume();
        } catch (e) {}
      };

      ttsLastText = txt;
      const busy = !!(ss.speaking || ss.pending);
      if (!busy) {
        ttsChannel = "web";
        try {
          ss.speak(u);
        } catch (e) {}
      } else {
        try {
          ss.cancel();
        } catch (e) {}
        setTimeout(() => {
          if (my !== ttsTok) return;
          ttsChannel = "web";
          try {
            ss.speak(u);
          } catch (e) {}
        }, 30);
      }
      renderTTSVol();
      refreshTtsBadge();
    } catch (e) {}
  }

  function renderTTSVol() {
    const el = $id("ttsVol");
    if (!el) return;
    const v = ttsVolume();
    el.textContent = "🔊 " + Math.round(v * 100) + "%";
    el.style.opacity = v >= 1 ? "1" : ".62";
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
    ttsTok++;
    stopDict();
    try {
      window.speechSynthesis?.cancel();
    } catch {}
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
  function setBlocked(value) {
    blocked = value;
    for (const id of ["kb", "btnNext", "pauseButton", "btnReset", "btnAgain"])
      $id(id).disabled = value;
    $id("btnWrong").disabled = value || !Object.keys(S.wrong).length;
    if (value) pause();
  }
  let composing = false;
  function focusKeyboard() {
    if (!S.running || S.done || S.status === "paused") return;
    kb.focus({ preventScroll: true });
    if (isTouch()) $id("wbox").scrollIntoView({ block: "center" });
  }
  $id("wbox").addEventListener("click", () => {
    const wasUnlocked = ttsUnlocked;
    AU.unlock();
    ttsUnlock();
    focusKeyboard();
    if (S.running && (wasUnlocked || !isTouch())) say(S.word, S.cn, true);
    justUnlockedTap = false;
  });
  $id("wbox").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      focusKeyboard();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (
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
        (target.matches("input,textarea,select,button,a") ||
          target.isContentEditable);
    if (editing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      process(engine.skip());
      return;
    }
    if (isPracticeChar(e.key)) {
      e.preventDefault();
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
      }
    });
  $id("btnWrong").addEventListener("click", () => {
    if (activeDeck) {
      const ids = new Set(Object.keys(S.wrong));
      if (onWrong) {
        onWrong([...ids]);
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
  });
  for (const id of ["cbShow", "cbCn"])
    $id(id).addEventListener("change", () => {
      renderWord();
      onPreferences();
    });
  for (const id of ["cbSound", "cbTTS", "cbOnline"])
    $id(id).addEventListener("change", () => {
      if (!$id("cbTTS").checked) stopSpeech();
      refreshTtsBadge();
      onPreferences();
    });
  $id("auBadge").addEventListener("click", () => {
    AU.unlock();
    refreshAuBadge();
  });
  $id("ttsBadge").addEventListener("click", () => {
    ttsUnlock();
    say(S.word, S.cn, true);
  });
  $id("ttsVol").addEventListener("click", () => say(S.word, S.cn, true));
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
    snapshot: () => engine.snapshot(),
    pause,
    resume,
    reset,
    get state() {
      return S;
    },
  };
}
