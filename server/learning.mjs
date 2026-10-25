import { LearningModel } from "../shared/learning.mjs";

export class LearningStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS learning_documents (
      owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(owner_id,kind,id)
    );`);
    store.transaction(() => {
      const migration = "learning-v1";
      if (this.db.prepare("SELECT 1 FROM app_meta WHERE key=?").get(migration))
        return;
      for (const row of this.db
        .prepare(
          "SELECT owner_id,result FROM practice_sessions ORDER BY created_at,id",
        )
        .all())
        this.model(row.owner_id).recordLegacy(JSON.parse(row.result));
      this.db.prepare("INSERT INTO app_meta VALUES (?, '1')").run(migration);
    });
  }
  repo(owner) {
    return {
      get: (kind, id) => {
        const row = this.db
          .prepare(
            "SELECT data FROM learning_documents WHERE owner_id=? AND kind=? AND id=?",
          )
          .get(owner, kind, id);
        return row ? JSON.parse(row.data) : undefined;
      },
      put: (kind, id, value) =>
        this.db
          .prepare(
            "INSERT INTO learning_documents VALUES (?,?,?,?) ON CONFLICT(owner_id,kind,id) DO UPDATE SET data=excluded.data",
          )
          .run(owner, kind, id, JSON.stringify(value)),
      all: (kind) =>
        this.db
          .prepare(
            "SELECT data FROM learning_documents WHERE owner_id=? AND kind=? ORDER BY id",
          )
          .all(owner, kind)
          .map((row) => JSON.parse(row.data)),
    };
  }
  model(owner) {
    return new LearningModel(this.repo(owner), {
      getDeck: (id, version) =>
        version === undefined
          ? this.store.get(id, owner)
          : this.store.revision(id, owner, version),
    });
  }
  read(owner, method, ...args) {
    return this.model(owner)[method](...args);
  }
  write(owner, method, ...args) {
    return this.store.transaction(() => this.model(owner)[method](...args));
  }
  export(owner) {
    return this.db
      .prepare(
        "SELECT kind,id,data FROM learning_documents WHERE owner_id=? ORDER BY kind,id",
      )
      .all(owner)
      .map(({ kind, id, data }) => ({ kind, id, value: JSON.parse(data) }));
  }
}
