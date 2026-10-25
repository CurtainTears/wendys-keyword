import { newId, validateDeck } from "../shared/words.mjs";

let opening;
function database() {
  opening ||= new Promise((resolve, reject) => {
    let blocked = false;
    const req = indexedDB.open("keyword-workspace", 2);
    req.onupgradeneeded = () => {
      for (const name of [
        "decks",
        "sessions",
        "outbox",
        "meta",
        "studyMeta",
        "studyCache",
        "studyActions",
      ])
        if (!req.result.objectStoreNames.contains(name))
          req.result.createObjectStore(name, { keyPath: "id" });
    };
    req.onsuccess = () => {
      if (blocked) {
        req.result.close();
        return;
      }
      req.result.onversionchange = () => {
        req.result.close();
        opening = undefined;
      };
      resolve(req.result);
    };
    req.onblocked = () => {
      blocked = true;
      opening = undefined;
      reject(
        new Error(
          "请先关闭其他旧版词库页面，再重试连接；原有浏览器数据仍保留。",
        ),
      );
    };
    req.onerror = () =>
      reject(new Error("本地数据库无法打开，请检查浏览器存储权限"));
  });
  return opening;
}
async function transaction(name, mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode),
      store = tx.objectStore(name);
    let value;
    tx.oncomplete = () => resolve(value);
    tx.onabort = tx.onerror = () =>
      reject(new Error("本地保存失败，请导出草稿后重试"));
    try {
      const req = action(store);
      if (req)
        req.onsuccess = () => {
          value = req.result;
        };
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}
export const local = {
  all: (name) => transaction(name, "readonly", (s) => s.getAll()),
  get: (name, id) => transaction(name, "readonly", (s) => s.get(id)),
  put: (name, value) => transaction(name, "readwrite", (s) => s.put(value)),
  remove: (name, id) => transaction(name, "readwrite", (s) => s.delete(id)),
  async mutate(name, id, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readwrite"),
        store = tx.objectStore(name);
      let result, error;
      const request = store.get(id);
      request.onsuccess = () => {
        try {
          const changed = action(request.result);
          result = changed.result;
          store.put(changed.value);
        } catch (e) {
          error = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () =>
        reject(
          error || new Error("本机学习进度保存失败，请保留页面并导出数据"),
        );
    });
  },
  async create(raw) {
    const deck = {
      ...validateDeck(raw),
      id: "guest_" + newId(),
      version: 1,
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    };
    await this.put("decks", deck);
    return deck;
  },
  async import(raw) {
    const decks = raw.map((d) => ({
      ...validateDeck(d),
      id: "guest_" + newId(),
      version: 1,
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    }));
    await transaction("decks", "readwrite", (store) => {
      decks.forEach((d) => store.put(d));
    });
    return decks;
  },
  async update(id, raw) {
    const db = await database(),
      payload = validateDeck(raw);
    return new Promise((resolve, reject) => {
      const tx = db.transaction("decks", "readwrite"),
        store = tx.objectStore("decks");
      let deck;
      const req = store.get(id);
      req.onsuccess = () => {
        const current = req.result;
        if (!current || current.version !== raw.version) {
          tx.abort();
          return;
        }
        deck = {
          ...current,
          ...payload,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };
        store.put(deck);
      };
      tx.oncomplete = () => resolve(deck);
      tx.onabort = tx.onerror = () =>
        reject(new Error("本地词库已在其他标签页更新；请保留草稿并重新载入"));
    });
  },
  async trash(id, version, restore = false) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("decks", "readwrite"),
        store = tx.objectStore("decks");
      let result;
      const req = store.get(id);
      req.onsuccess = () => {
        const current = req.result;
        if (!current || current.version !== version) {
          tx.abort();
          return;
        }
        result = {
          ...current,
          deletedAt: restore ? null : new Date().toISOString(),
          version: version + 1,
          updatedAt: new Date().toISOString(),
        };
        store.put(result);
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () =>
        reject(new Error("词库已在其他标签页更新，请刷新后重试"));
    });
  },
};
