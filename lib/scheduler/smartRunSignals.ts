import { quote, withCoralTenant } from "@/lib/coral/client";
import { tracedSql } from "@/lib/coral/traced-client";
import { newRunId } from "@/lib/coral/trace-logger";

function addFileSignals(value: unknown, result: Set<string>): void {
  if (!value) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.startsWith("[") || text.startsWith("{")) {
      try { addFileSignals(JSON.parse(text), result); return; } catch { /* scan text below */ }
    }
    for (const file of text.match(/[\w./-]+\.(?:tsx?|jsx?|py|rb|go|rs|java|css|scss|html|md|json)/g) || []) result.add(file);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => addFileSignals(item, result));
    return;
  }
  if (typeof value === "object") {
    const item = value as { path?: unknown; filename?: unknown; files?: unknown };
    addFileSignals(item.path, result);
    addFileSignals(item.filename, result);
    addFileSignals(item.files, result);
  }
}

export async function getRecentFiles(schedule: {
  userId: string;
  repoOwner: string;
  repoName: string;
}): Promise<Set<string>> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sql = `SELECT files, commit__message AS message FROM github.commits WHERE owner = ${quote(schedule.repoOwner)} AND repo = ${quote(schedule.repoName)} AND COALESCE(commit__author__date, commit__committer__date) >= ${quote(since)} ORDER BY COALESCE(commit__author__date, commit__committer__date) DESC LIMIT 50`;
  const rows = await withCoralTenant(schedule.userId, () => tracedSql(sql, {
    runId: newRunId(), source: "github.commits", agentRole: "smart_run", timeoutMs: 15000,
  }));
  const files = new Set<string>();
  rows.forEach((row) => { addFileSignals(row.files, files); addFileSignals(row.message, files); });
  return files;
}