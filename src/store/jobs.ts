import { getPool } from "./index.js";

export interface JobRecord {
  trace_id: string;
  route: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  status: "pending" | "running" | "success" | "skipped" | "failed";
  strategy_type: string;
  commit_sha: string | null;
  reason: string | null;
  raw_result: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export async function createJob(params: {
  traceId: string; route: string; repo: string; prNumber: number; headSha: string; strategyType: string;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO jobs (trace_id, route, repo, pr_number, head_sha, strategy_type, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [params.traceId, params.route, params.repo, params.prNumber, params.headSha, params.strategyType],
  );
}

export async function updateJobStatus(
  traceId: string,
  status: JobRecord["status"],
  extra?: { commitSha?: string; reason?: string; rawResult?: string },
): Promise<void> {
  const pool = getPool();
  const sets: string[] = ["status = $2"];
  const params: (string | null)[] = [traceId, status];

  if (status === "running") {
    sets.push("started_at = NOW()");
  } else if (["success", "skipped", "failed"].includes(status)) {
    sets.push("finished_at = NOW()");
  }

  if (extra?.commitSha) { sets.push(`commit_sha = $${params.length + 1}`); params.push(extra.commitSha); }
  if (extra?.reason)    { sets.push(`reason = $${params.length + 1}`); params.push(extra.reason); }
  if (extra?.rawResult) { sets.push(`raw_result = $${params.length + 1}`); params.push(extra.rawResult); }

  await pool.query(`UPDATE jobs SET ${sets.join(", ")} WHERE trace_id = $1`, params);
}

export async function getJobByTraceId(traceId: string): Promise<JobRecord | undefined> {
  const pool = getPool();
  const res = await pool.query("SELECT * FROM jobs WHERE trace_id = $1", [traceId]);
  return res.rows[0] as JobRecord | undefined;
}

export async function findCompletedJob(
  route: string, repo: string, prNumber: number, headSha: string,
): Promise<JobRecord | undefined> {
  const pool = getPool();
  const res = await pool.query(
    `SELECT * FROM jobs WHERE route = $1 AND repo = $2 AND pr_number = $3 AND head_sha = $4 AND status = 'success' LIMIT 1`,
    [route, repo, prNumber, headSha],
  );
  return res.rows[0] as JobRecord | undefined;
}

export async function getRecentJobs(limit = 20): Promise<JobRecord[]> {
  const pool = getPool();
  const res = await pool.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1", [limit]);
  return res.rows as JobRecord[];
}
