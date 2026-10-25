import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooseVoice,
  englishVoices,
  speechPreferences,
  createPronunciation,
} from "../src/pronunciation.mjs";

const voice = (name, lang = "en-US", extra = {}) => ({
  name,
  lang,
  voiceURI: name,
  localService: true,
  ...extra,
});
const samantha = voice("Samantha");
function fixture(list = [samantha]) {
  const timers = new Map(),
    states = [],
    played = [];
  let next = 0;
  class Synth extends EventTarget {
    list = list;
    getVoices() {
      return this.list;
    }
    cancel() {
      this.last?.onerror?.({ error: "interrupted" });
    }
    resume() {}
    speak(u) {
      this.last = u;
      played.push(u);
    }
  }
  class Media extends EventTarget {
    requests = [];
    pause() {}
    load() {}
    removeAttribute() {
      this.src = "";
    }
    play() {
      this.requests.push(this.src);
      return new Promise((resolve, reject) => {
        this.reject = reject;
      });
    }
  }
  const synth = new Synth(),
    media = new Media();
  const speech = createPronunciation({
    synth,
    Utterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    createAudio: () => media,
    onChange: (value) => states.push(value),
    schedule: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    cancelTimer: (id) => timers.delete(id),
  });
  return { speech, synth, media, states, played, timers };
}
test("Automatic English voice excludes Mac novelty, Chinese and remote voices", () => {
  const voices = [
    voice("Albert"),
    voice("Bells"),
    voice("Tingting", "zh-CN"),
    voice("Cloud", "en-US", { localService: false }),
    voice("Fred"),
    samantha,
  ];
  assert.deepEqual(
    englishVoices(voices).map((v) => v.name),
    ["Fred", "Samantha"],
  );
  assert.equal(chooseVoice(voices).name, "Samantha");
  assert.equal(chooseVoice(voices, "Fred").name, "Fred");
  assert.equal(chooseVoice([voice("Albert")]), null);
});
test("Volume and rate are fixed preferences, not combo-dependent; default is local only", () => {
  const { speech, played, media } = fixture();
  speech.speak("clear");
  assert.equal(played[0].voice, samantha);
  assert.equal(played[0].volume, 1);
  assert.equal(played[0].rate, 0.9);
  assert.equal(played[0].pitch, 1);
  speech.configure({ rate: 0.75, volume: 0.8 });
  speech.speak("again");
  assert.equal(played[1].volume, 0.8);
  assert.equal(played[1].rate, 0.75);
  assert.deepEqual(media.requests, []);
  assert.deepEqual(speechPreferences({ rate: Infinity, volume: -4 }), {
    voice: "",
    rate: 0.9,
    volume: 0.2,
  });
});
test("Explicit online opt-in uses only the English target and falls back locally once", async () => {
  const { speech, media, synth, played, states } = fixture();
  speech.speak("river bank", { online: true });
  assert.match(media.requests[0], /audio=river%20bank&type=2$/);
  assert.equal(played.length, 0);
  media.dispatchEvent(new Event("error"));
  media.reject(new Error("network"));
  await Promise.resolve();
  assert.equal(played.length, 1);
  assert.equal(synth.last.text, "river bank");
  assert.match(states.at(-1).message, /改用本机英语/);
});
test("A late rejected play promise cannot replace the new word or opt-out request", async () => {
  const { speech, media, played } = fixture();
  speech.speak("old", { online: true });
  const lateReject = media.reject;
  speech.speak("current");
  lateReject(new Error("aborted old playback"));
  await Promise.resolve();
  media.dispatchEvent(new Event("error"));
  assert.deepEqual(
    played.map((u) => u.text),
    ["current"],
  );
  assert.equal(media.requests.length, 1);
});
test("Cancel detaches old utterance callbacks; late events cannot disturb current speech", () => {
  const { speech, played, states } = fixture();
  speech.speak("old");
  const lateStart = played[0].onstart,
    lateError = played[0].onerror;
  speech.speak("new");
  const count = states.length;
  lateStart();
  lateError();
  assert.equal(states.length, count);
  played[1].onstart();
  assert.equal(states.at(-1).state, "speaking");
  played[1].onend();
  assert.equal(states.at(-1).state, "idle");
});
test("Asynchronously loaded voices retry only the current waiting word, never after stop", () => {
  const { speech, synth, played, states } = fixture([]);
  speech.speak("ready");
  assert.equal(states.at(-1).state, "unavailable");
  synth.list = [samantha];
  synth.dispatchEvent(new Event("voiceschanged"));
  assert.equal(played[0].text, "ready");
  synth.list = [];
  speech.speak("stopped");
  speech.stop();
  synth.list = [samantha];
  synth.dispatchEvent(new Event("voiceschanged"));
  assert.equal(played.length, 1);
});
test("A queued utterance with no start event is reported as a failure", () => {
  const { speech, timers, states } = fixture();
  speech.speak("blocked");
  [...timers.values()][0]();
  assert.equal(states.at(-1).state, "error");
});
