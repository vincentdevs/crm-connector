// The outbox. A submission is written here before anything is sent, so a CRM outage or a crashed
// process loses nothing: every target (each CRM, then the email) is a delivery row that moves
// pending -> sending -> done, or failed (retried with backoff) -> dead after the last attempt.
// The same SQL runs on SQLite (Node) and D1 (Workers); a driver only has to provide all() and run().

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY, form TEXT NOT NULL, idem TEXT NOT NULL UNIQUE, lead TEXT NOT NULL,
    ip_hash TEXT, created_at INTEGER NOT NULL, purge_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    submission_id TEXT NOT NULL, target TEXT NOT NULL, ord INTEGER NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT '{}',
    result TEXT, error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (submission_id, target))`,
  'CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_at)',
  'CREATE INDEX IF NOT EXISTS submissions_purge ON submissions (purge_at)',
];

export function sqlStore(driver) {
  const one = async (sql, p) => (await driver.all(sql, p))[0];
  return {
    async init() {
      for (const s of SCHEMA) await driver.run(s, []);
    },

    // Returns { id, duplicate }. A repeated idempotency key returns the first submission's id.
    async insert({ id, form, idem, lead, ipHash, now, purgeAt, targets }) {
      const r = await driver.run(
        'INSERT INTO submissions (id, form, idem, lead, ip_hash, created_at, purge_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (idem) DO NOTHING',
        [id, form, idem, JSON.stringify(lead), ipHash || null, now, purgeAt]);
      if (!r.changes) return { id: (await one('SELECT id FROM submissions WHERE idem = ?', [idem])).id, duplicate: true };
      for (const [i, t] of targets.entries()) {
        await driver.run('INSERT INTO deliveries (submission_id, target, ord, status, next_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, t, i, 'pending', now, now]);
      }
      return { id, duplicate: false };
    },

    async lead(id) {
      const row = await one('SELECT lead FROM submissions WHERE id = ?', [id]);
      return row ? JSON.parse(row.lead) : null;
    },

    // Claiming is a conditional update, so the inline send and the retry timer can never run the
    // same delivery at once: whoever flips the row to "sending" owns it until the lease runs out.
    async claim(id, target, now, leaseMs) {
      const r = await driver.run(
        `UPDATE deliveries SET status = 'sending', next_at = ?, updated_at = ?
         WHERE submission_id = ? AND target = ? AND (status IN ('pending', 'failed') OR (status = 'sending' AND next_at <= ?)) AND next_at <= ?`,
        [now + leaseMs, now, id, target, now, now]);
      if (!r.changes) return null;
      const row = await one('SELECT attempts, state FROM deliveries WHERE submission_id = ? AND target = ?', [id, target]);
      return { attempts: row.attempts, state: JSON.parse(row.state || '{}') };
    },

    async saveState(id, target, state, now) {
      await driver.run('UPDATE deliveries SET state = ?, updated_at = ? WHERE submission_id = ? AND target = ?', [JSON.stringify(state), now, id, target]);
    },

    async finish(id, target, { status, attempts, nextAt, state, result, error, now }) {
      await driver.run(
        'UPDATE deliveries SET status = ?, attempts = ?, next_at = ?, state = ?, result = ?, error = ?, updated_at = ? WHERE submission_id = ? AND target = ?',
        [status, attempts, nextAt, JSON.stringify(state || {}), result ? JSON.stringify(result) : null, error || null, now, id, target]);
    },

    async requeue(id) {
      const r = await driver.run("UPDATE deliveries SET status = 'failed', attempts = 0, next_at = 0 WHERE submission_id = ? AND status IN ('dead', 'failed')", [id]);
      return r.changes;
    },

    async deliveries(id) {
      const rows = await driver.all('SELECT target, status, attempts, result, error, next_at FROM deliveries WHERE submission_id = ? ORDER BY ord', [id]);
      return rows.map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
    },

    async due(now, limit = 50) {
      return driver.all(
        `SELECT submission_id, target FROM deliveries
         WHERE (status IN ('pending', 'failed') OR status = 'sending') AND next_at <= ? ORDER BY next_at LIMIT ?`, [now, limit]);
    },

    // Personal data is kept only as long as a retry could need it; the CRM is the record of truth
    async purge(now) {
      const old = await driver.all('SELECT id FROM submissions WHERE purge_at <= ?', [now]);
      for (const { id } of old) {
        await driver.run('DELETE FROM deliveries WHERE submission_id = ?', [id]);
        await driver.run('DELETE FROM submissions WHERE id = ?', [id]);
      }
      return old.length;
    },

    async countRecent(ipHash, since) {
      return (await one('SELECT COUNT(*) AS n FROM submissions WHERE ip_hash = ? AND created_at >= ?', [ipHash, since])).n;
    },

    async stats() {
      return driver.all('SELECT target, status, COUNT(*) AS n FROM deliveries GROUP BY target, status ORDER BY target, status', []);
    },

    async recent(limit = 20) {
      const subs = await driver.all('SELECT id, form, lead, created_at FROM submissions ORDER BY created_at DESC LIMIT ?', [limit]);
      const out = [];
      for (const s of subs) out.push({ id: s.id, form: s.form, email: JSON.parse(s.lead).email, created_at: s.created_at, deliveries: await this.deliveries(s.id) });
      return out;
    },
  };
}
