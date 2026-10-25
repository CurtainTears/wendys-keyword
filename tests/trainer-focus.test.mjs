import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createTrainer } from "../src/trainer.js";

// Small DOM fixture for the real trainer controller, without a browser package.
// Browser acceptance also exercises the actual native focus and key events.
function fixture(t, { touch = false, ...options } = {}) {
  class Element {
    listeners = new Map();
    children = [];
    style = {};
    hidden = false;
    checked = false;
    disabled = false;
    value = "";
    isContentEditable = false;
    classList = { add() {}, remove() {}, toggle() {} };
    constructor(id) {
      this.id = id;
    }
    addEventListener(name, fn) {
      const list = this.listeners.get(name) || [];
      list.push(fn);
      this.listeners.set(name, list);
    }
    async fire(name, extra = {}) {
      const event = {
        target: this,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...extra,
      };
      for (const fn of this.listeners.get(name) || []) await fn(event);
      return event;
    }
    focus() {
      document.activeElement = this;
    }
    blur() {
      if (document.activeElement === this) document.activeElement = null;
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = [...nodes];
    }
    closest() {
      return /^(kb|ttsVoice|ttsRate|ttsVolume|cb|btn|pauseButton|ttsVol|summary)/.test(
        this.id,
      )
        ? this
        : null;
    }
    scrollIntoView() {}
  }
  const nodes = new Map(
    [
      ...fs
        .readFileSync(new URL("../index.html", import.meta.url), "utf8")
        .matchAll(/id="([^"]+)"/g),
    ].map((m) => [m[1], new Element(m[1])]),
  );
  const doc = new Element("document"),
    settings = new Element("settings");
  doc.getElementById = (id) => nodes.get(id);
  doc.createElement = (tag) => new Element(tag);
  doc.querySelector = (selector) =>
    selector === ".practice-settings" ? settings : doc.modal || null;
  for (const [name, value] of Object.entries({
    document: doc,
    window: {
      matchMedia: (query) => ({
        matches:
          query.includes("prefers-reduced-motion") ||
          (touch && query.includes("pointer:coarse")),
      }),
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() =>
      previous
        ? Object.defineProperty(globalThis, name, previous)
        : delete globalThis[name],
    );
  }
  t.mock.method(globalThis, "setInterval", () => 0);
  const deck = {
    id: "test",
    title: "Focus test",
    version: 1,
    words: ["clear", "focus", "voice"].map((term, i) => ({
      id: "word" + i,
      term,
      meaning: "释义",
    })),
  };
  let trainer;
  trainer = createTrainer({
    onComplete() {},
    onRestart: async () => {
      trainer.start(deck);
    },
    ...options,
  });
  trainer.start(deck);
  return {
    trainer,
    nodes,
    doc,
    settings,
    deck,
    click: async (id) => {
      nodes.get(id).focus();
      await nodes.get(id).fire("click");
    },
  };
}

test("Replay, skip, resume and asynchronous restart all return to typing", async (t) => {
  const { trainer, nodes, doc, click } = fixture(t);
  const kb = nodes.get("stage");
  assert.equal(doc.activeElement, kb);
  for (const id of ["ttsVol", "auBadge", "btnNext", "btnReset"]) {
    await click(id);
    assert.equal(doc.activeElement, kb, id);
  }
  await click("pauseButton");
  assert.equal(trainer.state.status, "paused");
  assert.equal(doc.activeElement, nodes.get("pauseButton"));
  await click("pauseButton");
  assert.equal(doc.activeElement, kb);
  const before = trainer.state.typed;
  await doc.fire("keydown", { target: kb, key: trainer.state.word[0] });
  assert.equal(trainer.state.typed, before + 1);
});
test("No focus recovery steals from an open dialog, another view, or a blocked round", async (t) => {
  const { trainer, nodes, doc, click } = fixture(t);
  doc.modal = nodes.get("authDialog");
  await click("ttsVol");
  assert.notEqual(doc.activeElement, nodes.get("stage"));
  doc.modal = null;
  nodes.get("practiceView").hidden = true;
  await click("btnReset");
  assert.notEqual(doc.activeElement, nodes.get("stage"));
  nodes.get("practiceView").hidden = false;
  trainer.setBlocked(true);
  await click("wbox");
  assert.notEqual(doc.activeElement, nodes.get("stage"));
});
test("Pointer settings return to typing; keyboard settings keep native navigation", async (t) => {
  const { nodes, doc, settings } = fixture(t);
  nodes.get("cbCn").focus();
  await settings.fire("pointerdown");
  await settings.fire("change");
  assert.equal(doc.activeElement, nodes.get("stage"));
  nodes.get("ttsRate").focus();
  await settings.fire("keydown", { key: "ArrowDown" });
  await settings.fire("change");
  assert.equal(doc.activeElement, nodes.get("ttsRate"));
});
test("A browser retaining a practice-action button focus still accepts the first typed letter once", async (t) => {
  const { trainer, nodes, doc } = fixture(t);
  nodes.get("ttsVol").focus();
  const key = trainer.state.word[0];
  const event = await doc.fire("keydown", { target: nodes.get("ttsVol"), key });
  assert.equal(event.defaultPrevented, true);
  assert.equal(trainer.state.typed, 1);
  assert.equal(doc.activeElement, nodes.get("stage"));
  const before = trainer.state.keystrokes;
  await doc.fire("keydown", { target: nodes.get("ttsVol"), key: " " });
  assert.equal(trainer.state.keystrokes, before);
});
test("Summary Space and IME text do not enter the practice word", async (t) => {
  const { trainer, nodes, doc } = fixture(t);
  const before = trainer.state.keystrokes;
  await doc.fire("keydown", { target: { closest: () => ({}) }, key: " " });
  await doc.fire("keydown", {
    target: nodes.get("kb"),
    key: "a",
    isComposing: true,
  });
  await nodes.get("kb").fire("compositionstart");
  await doc.fire("keydown", { target: nodes.get("kb"), key: "a" });
  await nodes.get("kb").fire("compositionend");
  assert.equal(trainer.state.keystrokes, before);
});

test("Native IME pre-edit is never cleared while composing; Chinese commit does not count as a typo", async (t) => {
  const { trainer, nodes, doc } = fixture(t, { touch: true });
  const kb = nodes.get("kb");
  assert.equal(doc.activeElement, kb);
  await kb.fire("compositionstart");
  kb.value = "n";
  await kb.fire("input", {
    isComposing: true,
    inputType: "insertCompositionText",
  });
  assert.equal(kb.value, "n");
  kb.value = "ni";
  await kb.fire("input", {
    isComposing: true,
    inputType: "insertCompositionText",
  });
  assert.equal(kb.value, "ni");
  await kb.fire("compositionend", { data: "你" });
  assert.equal(kb.value, "");
  assert.equal(trainer.state.keystrokes, 0);
  await doc.fire("keydown", {
    target: kb,
    key: trainer.state.word[0],
    isComposing: false,
  });
  assert.equal(trainer.state.typed, 1);
});

test("Switching back to English recovers even if the IME never sent compositionend", async (t) => {
  const { trainer, nodes, doc } = fixture(t, { touch: true });
  const kb = nodes.get("kb");
  await kb.fire("compositionstart");
  kb.value = "pin";
  await kb.fire("input", { isComposing: true });
  for (const key of trainer.state.word.slice(0, 2))
    await doc.fire("keydown", {
      target: kb,
      key,
      keyCode: 65,
      isComposing: false,
    });
  assert.equal(trainer.state.typed, 2);
  assert.equal(kb.value, "");
});

test("IME boundary keyCode229 never types a character or skips the word", async (t) => {
  const { trainer, nodes, doc } = fixture(t);
  for (const key of [trainer.state.word[0], "Escape", " "])
    await doc.fire("keydown", {
      target: nodes.get("stage"),
      key,
      keyCode: 229,
      isComposing: false,
    });
  assert.equal(trainer.state.keystrokes, 0);
  assert.equal(trainer.state.skipped, 0);
});

test("Desktop English practice accepts physical Latin keys while Chinese IME reports Process", async (t) => {
  const { trainer, nodes, doc } = fixture(t);
  assert.equal(doc.activeElement, nodes.get("stage"));
  for (const character of trainer.state.word.slice(0, 2)) {
    const event = await doc.fire("keydown", {
      target: nodes.get("stage"),
      key: "Process",
      code: "Key" + character.toUpperCase(),
      keyCode: 229,
      isComposing: true,
    });
    assert.equal(event.defaultPrevented, true);
  }
  assert.equal(trainer.state.typed, 2);
  const before = trainer.state.keystrokes;
  await doc.fire("keydown", {
    target: nodes.get("ttsVoice"),
    key: "Process",
    code: "KeyA",
    keyCode: 229,
    isComposing: true,
  });
  assert.equal(trainer.state.keystrokes, before);
});

test("Committed Latin composition is counted once, not again by the final composition input", async (t) => {
  const { trainer, nodes } = fixture(t, { touch: true });
  const kb = nodes.get("kb"),
    text = trainer.state.word.slice(0, 2);
  await kb.fire("compositionstart");
  kb.value = text;
  await kb.fire("input", {
    isComposing: true,
    inputType: "insertCompositionText",
  });
  await kb.fire("compositionend", { data: text });
  kb.value = text;
  await kb.fire("input", {
    isComposing: false,
    inputType: "insertFromComposition",
  });
  assert.equal(trainer.state.typed, 2);
  assert.equal(trainer.state.keystrokes, 2);
  assert.equal(kb.value, "");
});

test("Blur and round changes abandon composition; late commits cannot type into a new round", async (t) => {
  const { trainer, nodes, doc, deck, click } = fixture(t, { touch: true });
  const kb = nodes.get("kb");
  await kb.fire("compositionstart");
  kb.value = "pin";
  await kb.fire("blur");
  await kb.fire("compositionend", { data: "clear" });
  assert.equal(trainer.state.keystrokes, 0);
  await click("wbox");
  assert.equal(doc.activeElement, kb);
  await kb.fire("compositionstart");
  trainer.start(deck);
  await kb.fire("compositionend", { data: "clear" });
  assert.equal(trainer.state.keystrokes, 0);
});
