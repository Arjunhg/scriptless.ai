import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { TestCasesTable, repositories, users } from "@/db/schema";
import { withCoralTenant } from "@/lib/coral/client";
import { decryptToken } from "@/lib/scheduler/tokenEncryption";
import { scoreTests } from "@/lib/scheduler/smartRunScorer";
import { executeTestCase } from "@/lib/scheduler/executeTestCase";
import { getRecentFiles } from "@/lib/scheduler/smartRunSignals";

export type ScheduledRunInput = {
  id: number;
  userId: string;
  repoId: number;
  repoOwner: string;
  repoName: string;
  scope: string;
  intervalHours: number;
  encryptedGithubToken: string | null;
  tokenIv: string | null;
  tokenTag: string | null;
  localUserId: number;
};

export type ScheduledRunSummary = {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  durationMs: number;
  status: "completed" | "failed" | "skipped";
  errorMessage?: string;
};

function emptySummary(startedAt: number, status: ScheduledRunSummary["status"], errorMessage?: string): ScheduledRunSummary {
  return { totalTests: 0, passedTests: 0, failedTests: 0, skippedTests: 0, durationMs: Date.now() - startedAt, status, errorMessage };
}

export async function runScheduledTests(schedule: ScheduledRunInput): Promise<ScheduledRunSummary> {
  const startedAt = Date.now();
  if (!schedule.encryptedGithubToken || !schedule.tokenIv || !schedule.tokenTag) {
    return emptySummary(startedAt, "failed", "token_decrypt_failed");
  }

  let githubToken: string;
  try {
    githubToken = decryptToken(schedule.encryptedGithubToken, schedule.tokenIv, schedule.tokenTag);
  } catch {
    return emptySummary(startedAt, "failed", "token_decrypt_failed");
  }

  try {
    const userValues = [eq(TestCasesTable.userId, schedule.userId), eq(TestCasesTable.userId, String(schedule.localUserId))];
    const filters = [eq(TestCasesTable.repoId, String(schedule.repoId)), or(...userValues)];
    if (schedule.scope === "failed") filters.push(eq(TestCasesTable.status, "failed"));
    const allTests = await db.select().from(TestCasesTable).where(and(...filters));
    let tests = allTests;

    if (schedule.scope === "smart") {
      const recentFiles = await getRecentFiles(schedule);
      const prioritized = scoreTests(allTests, recentFiles);
      const byId = new Map(allTests.map((testCase) => [testCase.id, testCase]));
      tests = prioritized.map((test) => byId.get(test.id)).filter((testCase): testCase is (typeof TestCasesTable.$inferSelect) => Boolean(testCase));
    }

    if (tests.length === 0) return emptySummary(startedAt, "skipped");
    const [repoById] = await db.select().from(repositories).where(eq(repositories.repoId, schedule.repoId));
    const baseUrl = repoById?.targetDomain || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    let passedTests = 0;
    let failedTests = 0;
    let skippedTests = 0;
    let firstError: string | undefined;

    for (const testCase of tests) {
      const [user] = await db.select({ credits: users.credits }).from(users).where(eq(users.id, schedule.localUserId));
      if (!user || user.credits < 70) {
        skippedTests += 1;
        continue;
      }
      try {
        const result = await withCoralTenant(schedule.userId, () => executeTestCase({
          testCaseId: testCase.id,
          baseUrl,
          githubToken,
          mode: "cached",
          localUserId: schedule.localUserId,
          trackingUserId: schedule.userId,
        }));
        if (result.errorMessage === "insufficient_credits") {
          skippedTests += 1;
        } else if (result.status === "passed") {
          passedTests += 1;
        } else {
          failedTests += 1;
          firstError ||= result.errorMessage;
        }
      } catch (error) {
        failedTests += 1;
        firstError ||= error instanceof Error ? error.message : String(error);
      }
    }

    return {
      totalTests: tests.length,
      passedTests,
      failedTests,
      skippedTests,
      durationMs: Date.now() - startedAt,
      status: failedTests > 0 ? "failed" : passedTests === 0 ? "skipped" : "completed",
      ...(firstError ? { errorMessage: firstError } : {}),
    };
  } catch (error) {
    return emptySummary(startedAt, "failed", error instanceof Error ? error.message : String(error));
  }
}