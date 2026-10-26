// Two drivers for the same SQL: node:sqlite (built into Node 22.5+) and Cloudflare D1.

export async function sqliteDriver(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return {
    all: async (sql, p) => db.prepare(sql).all(...p),
    run: async (sql, p) => ({ changes: Number(db.prepare(sql).run(...p).changes) }),
    close: () => db.close(),
  };
}

export function d1Driver(d1) {
  return {
    all: async (sql, p) => (await d1.prepare(sql).bind(...p).all()).results,
    run: async (sql, p) => ({ changes: (await d1.prepare(sql).bind(...p).run()).meta.changes }),
  };
}
