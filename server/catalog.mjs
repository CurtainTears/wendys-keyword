import fs from "node:fs";
import { validateDeck } from "../shared/words.mjs";

export function loadCatalog(seedFile, manifestFile) {
  const seeds = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  if (!Array.isArray(seeds) || !seeds.length)
    throw new Error("内置词库不能为空");
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : {
        format: "keyword-catalog",
        version: 1,
        release: "legacy-seed-v1",
        retiredDeckIds: [],
        decks: seeds.map((d, position) => ({
          id: d.id,
          wordCount: d.words?.length,
          position,
        })),
      };
  if (
    manifest.format !== "keyword-catalog" ||
    manifest.version !== 1 ||
    typeof manifest.release !== "string" ||
    !manifest.release ||
    manifest.release.length > 100 ||
    !Array.isArray(manifest.decks) ||
    !Array.isArray(manifest.retiredDeckIds)
  )
    throw new Error("内置词库清单格式无效");
  const ids = new Set(),
    decks = seeds.map((seed) => {
      if (
        typeof seed.id !== "string" ||
        !/^builtin-[a-zA-Z0-9_-]{1,90}$/.test(seed.id) ||
        ids.has(seed.id)
      )
        throw new Error("内置词库标识无效或重复");
      ids.add(seed.id);
      const deck = validateDeck(seed);
      if (!deck.words.length) throw new Error(`${deck.title} 是空词库`);
      return { id: seed.id, ...deck };
    });
  if (manifest.decks.length !== decks.length)
    throw new Error("内置词库文件与清单数量不一致");
  const positions = new Set();
  for (const [i, d] of decks.entries()) {
    const item = manifest.decks[i];
    if (
      item.id !== d.id ||
      item.wordCount !== d.words.length ||
      item.position !== i ||
      positions.has(item.id)
    )
      throw new Error(`${d.title} 与收录清单不一致`);
    positions.add(item.id);
  }
  for (const id of manifest.retiredDeckIds) {
    if (
      typeof id !== "string" ||
      !/^builtin-[a-zA-Z0-9_-]{1,90}$/.test(id) ||
      ids.has(id)
    )
      throw new Error("待移除的示例词库标识无效");
  }
  return { decks, manifest };
}

// Run inside Store's initialization transaction so updates, retirements and the release marker commit together.
export function syncCatalog(store, { decks, manifest }) {
  const db = store.db;
  const currentRelease = db
    .prepare("SELECT value FROM app_meta WHERE key='catalog-release'")
    .get()?.value;
  if (currentRelease === manifest.release) return;
  const now = new Date().toISOString();
  for (const [position, { id, ...deck }] of decks.entries()) {
    const row = db.prepare("SELECT owner_id FROM decks WHERE id=?").get(id);
    if (row && row.owner_id !== null)
      throw new Error("内置词库更新与私人词库标识冲突，更新已撤回");
    if (!row) store.insert(null, deck, id);
    else {
      const existing = store.get(id, null, { includeDeleted: true });
      const previous = validateDeck(existing);
      if (
        JSON.stringify(previous) !== JSON.stringify(deck) ||
        existing.deletedAt
      ) {
        const version = existing.version + 1;
        db.prepare(
          "UPDATE decks SET title=?,description=?,version=?,updated_at=?,deleted_at=NULL WHERE id=? AND owner_id IS NULL",
        ).run(deck.title, deck.description, version, now, id);
        store.writeWords(id, deck.words);
        store.snapshot(id, version, deck);
      }
    }
    store.writeSource(id, deck.source, position);
  }
  // Keep snapshots and referenced rows for old results and in-flight rounds. Only the public catalog is retired.
  const retire = db.prepare(
    "UPDATE decks SET deleted_at=?,updated_at=? WHERE id=? AND owner_id IS NULL AND deleted_at IS NULL",
  );
  for (const id of manifest.retiredDeckIds) retire.run(now, now, id);
  db.prepare(
    "INSERT INTO app_meta VALUES ('catalog-release', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(manifest.release);
}
