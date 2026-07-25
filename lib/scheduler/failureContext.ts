import { coral, quote } from "@/lib/coral/client";
import { tracedSql } from "@/lib/coral/traced-client";

export type FailureContextItem = {
  kind: string;
  source: string;
  title: string;
  url: string | null;
  timestamp: string | null;
  metadata?: Record<string, unknown>;
};

export type FailureContext = {
  items: FailureContextItem[];
  queries_run: { source: string; sql: string; rows: number; ms: number }[];
  coral_available: boolean;
};

type TestContext = {
  id: number;
  repoOwner: string;
  repoName: string;
  targetRoute?: string | null;
  title: string;
};

export async function fetchFailureContext(
  testCase: TestContext,
  runId: string
): Promise<FailureContext> {
  const context: FailureContext = { items: [], queries_run: [], coral_available: false };
  try {
    const catalog = await coral.listCatalog();
    const schemas = new Set(catalog.map((table) => table.schema_name));
    context.coral_available = true;
    const signal = (testCase.targetRoute || testCase.title).replace(/[^a-zA-Z0-9 _/-]/g, "").slice(0, 50);
    const addRows = (
      rows: Record<string, unknown>[],
      kind: string,
      source: string
    ) => {
      for (const row of rows) {
        const title = String(row.title ?? row.message ?? row.name ?? "Related event");
        context.items.push({
          kind,
          source,
          title: title.replace(/[\r\n]+/g, " ").slice(0, 220),
          url: row.html_url ? String(row.html_url) : row.url ? String(row.url) : null,
          timestamp: row.created_at
            ? String(row.created_at)
            : row.updated_at
              ? String(row.updated_at)
              : row.last_seen
                ? String(row.last_seen)
                : null,
          metadata: { state: row.state, count: row.count },
        });
      }
    };

    if (schemas.has("github")) {
      const issueSql = `SELECT title, html_url, state, created_at FROM github.issues WHERE owner = ${quote(testCase.repoOwner)} AND repo = ${quote(testCase.repoName)}${signal ? ` AND title ILIKE ${quote(`%${signal}%`)}` : ""} ORDER BY created_at DESC LIMIT 5`;
      const issues = await tracedSql(issueSql, {
        testCaseId: testCase.id,
        runId,
        source: "github.issues",
        agentRole: "failure_enricher",
      });
      context.queries_run.push({ source: "github.issues", sql: issueSql, rows: issues.length, ms: 0 });
      addRows(issues, "issue", "github");

      const commitSql = `SELECT message, html_url, committed_at FROM github.commits WHERE owner = ${quote(testCase.repoOwner)} AND repo = ${quote(testCase.repoName)} ORDER BY committed_at DESC LIMIT 5`;
      const commits = await tracedSql(commitSql, {
        testCaseId: testCase.id,
        runId,
        source: "github.commits",
        agentRole: "failure_enricher",
      });
      context.queries_run.push({ source: "github.commits", sql: commitSql, rows: commits.length, ms: 0 });
      addRows(commits, "commit", "github");
    }

    if (schemas.has("sentry") && signal) {
      const sentrySql = `SELECT title, permalink AS url, last_seen, count FROM sentry.issues WHERE title ILIKE ${quote(`%${signal}%`)} ORDER BY last_seen DESC LIMIT 5`;
      const errors = await tracedSql(sentrySql, {
        testCaseId: testCase.id,
        runId,
        source: "sentry.issues",
        agentRole: "failure_enricher",
      });
      context.queries_run.push({ source: "sentry.issues", sql: sentrySql, rows: errors.length, ms: 0 });
      addRows(errors, "sentry", "sentry");
    }

    if (schemas.has("linear") && signal) {
      const linearSql = `SELECT title, url, state, updated_at FROM linear.issues WHERE title ILIKE ${quote(`%${signal}%`)} ORDER BY updated_at DESC LIMIT 5`;
      const issues = await tracedSql(linearSql, {
        testCaseId: testCase.id,
        runId,
        source: "linear.issues",
        agentRole: "failure_enricher",
      });
      context.queries_run.push({ source: "linear.issues", sql: linearSql, rows: issues.length, ms: 0 });
      addRows(issues, "linear", "linear");
    }
  } catch (error) {
    console.warn("[scheduler] failure context unavailable", error);
  }
  return context;
}