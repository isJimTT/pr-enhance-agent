import { Hono } from "hono";
import { getJobByTraceId } from "../store/jobs.js";
import { getPool } from "../store/index.js";

export const jobsApi = new Hono();

jobsApi.get("/", async (c) => {
  const pool = getPool();
  const page = parseInt(c.req.query("page") ?? "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
  const offset = (page - 1) * limit;
  const status = c.req.query("status");
  const route = c.req.query("route");

  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (status) { clauses.push(`status = $${idx++}`); params.push(status); }
  if (route)  { clauses.push(`route = $${idx++}`); params.push(route); }

  const where = clauses.length > 0 ? "WHERE " + clauses.join(" AND ") : "";

  const countRes = await pool.query(`SELECT COUNT(*) as total FROM jobs ${where}`, params);
  const total = parseInt(countRes.rows[0].total, 10);

  const res = await pool.query(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  );

  return c.json({ jobs: res.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

jobsApi.get("/stats", async (c) => {
  const pool = getPool();
  const [{ rows: [totalRow] }, byStatus, recentOk, recentFail, recent] = await Promise.all([
    pool.query("SELECT COUNT(*) as c FROM jobs"),
    pool.query("SELECT status, COUNT(*) as c FROM jobs GROUP BY status"),
    pool.query("SELECT COUNT(*) as c FROM jobs WHERE status='success' AND created_at > NOW() - INTERVAL '24 hours'"),
    pool.query("SELECT COUNT(*) as c FROM jobs WHERE status='failed' AND created_at > NOW() - INTERVAL '24 hours'"),
    pool.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 10"),
  ]);

  return c.json({
    total: parseInt(totalRow.c, 10),
    byStatus: byStatus.rows,
    last24h: { success: parseInt(recentOk.rows[0].c, 10), failed: parseInt(recentFail.rows[0].c, 10) },
    recent: recent.rows,
  });
});

jobsApi.get("/:traceId", async (c) => {
  const job = await getJobByTraceId(c.req.param("traceId"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});
