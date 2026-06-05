import pg from "pg";

let pool: pg.Pool | null = null;

export function initStore(databaseUrl?: string): pg.Pool {
  if (pool) return pool;

  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for PostgreSQL connection");
  }

  pool = new pg.Pool({ connectionString: url, max: 5 });

  pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      trace_id TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      strategy_type TEXT NOT NULL,
      commit_sha TEXT,
      reason TEXT,
      raw_result TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_route_repo_pr ON jobs(route, repo, pr_number);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
  `).catch(err => console.error("[store] Migration failed:", err.message));

  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error("Store not initialized. Call initStore() first.");
  return pool;
}

export async function closeStore(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
