import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "@/db";
import { agentQueries, TestCasesTable, users } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const testCaseId = Number(id);
  if (!Number.isFinite(testCaseId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const cu = await currentUser();
  const email = cu?.primaryEmailAddress?.emailAddress;
  let localUserId: number | null = null;
  if (email) {
    const [localUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    localUserId = localUser?.id ?? null;
  }

  const [testCase] = await db
    .select({ userId: TestCasesTable.userId, status: TestCasesTable.status })
    .from(TestCasesTable)
    .where(eq(TestCasesTable.id, testCaseId));

  if (!testCase) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const isOwner =
    (localUserId !== null && testCase.userId === String(localUserId)) ||
    testCase.userId === userId;
  if (!isOwner) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Test-scoped traces are produced by failure enrichment. A passed/running
  // test must not display historical rows from an earlier failed attempt.
  if (testCase.status !== "failed") {
    return NextResponse.json({ runs: [] });
  }

  const queries = await db
    .select()
    .from(agentQueries)
    .where(eq(agentQueries.testCaseId, testCaseId))
    .orderBy(desc(agentQueries.createdAt))
    .limit(100);

  // Keep the panel focused on the latest failed execution even if rows from
  // older versions of the app are still present in the database.
  const latestRunId = queries[0]?.runId;
  const latestQueries = latestRunId
    ? queries.filter((query) => query.runId === latestRunId)
    : queries;

  const byRun: Record<string, typeof queries> = {};
  for (const query of latestQueries) {
    const runKey = query.runId ?? "untagged";
    (byRun[runKey] ||= []).push(query);
  }

  const runs = Object.entries(byRun)
    .map(([runId, runQueries]) => ({
      runId,
      startedAt: runQueries[runQueries.length - 1]?.createdAt,
      queryCount: runQueries.length,
      totalRows: runQueries.reduce((sum, query) => sum + query.rowsReturned, 0),
      totalMs: runQueries.reduce((sum, query) => sum + query.durationMs, 0),
      queries: runQueries.slice().reverse(),
    }))
    .sort(
      (a, b) =>
        new Date(b.startedAt as unknown as string).getTime() -
        new Date(a.startedAt as unknown as string).getTime()
    );

  return NextResponse.json({ runs });
}
