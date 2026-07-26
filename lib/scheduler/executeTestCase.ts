import { Browserbase } from "@browserbasehq/sdk";
import { chromium, Page } from "playwright-core";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { TestCasesTable, repositories, users } from "@/db/schema";
import { analyzeScreenshot } from "@/lib/inference/analyzeScreenshot";
import { deleteAgentQueriesForTestCase } from "@/lib/db/integrity";
import { fetchFailureContext, FailureContext } from "@/lib/scheduler/failureContext";
import { generateTestScript } from "@/lib/scheduler/generateTestScript";
import { captureScreenshot, serializeLogArgs } from "@/lib/scheduler/executionHelpers";
import { newRunId } from "@/lib/coral/trace-logger";
import { pendoTrackServer } from "@/lib/pendo/track";

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });

type Params = {
  testCaseId: number;
  baseUrl: string;
  githubToken: string;
  mode?: "generate" | "cached";
  customPrompt?: string;
  localUserId: number;
  trackingUserId?: string;
};

export type ExecuteTestCaseResult = {
  status: "passed" | "failed" | "error";
  logs: string[];
  sessionId?: string;
  sessionUrl?: string;
  visionAnalysis?: string;
  creditsUsed: number;
  errorMessage?: string;
  browserbaseScript?: string;
  failureContext?: FailureContext | null;
};

export async function executeTestCase(params: Params): Promise<ExecuteTestCaseResult> {
  const logs: string[] = [];
  const [testCase] = await db.select().from(TestCasesTable).where(eq(TestCasesTable.id, params.testCaseId));
  if (!testCase) throw new Error("test_case_not_found");
  const [user] = await db.select().from(users).where(eq(users.id, params.localUserId));
  if (!user) throw new Error("user_not_found");
  if (user.credits < 70) {
    return { status: "error", logs, creditsUsed: 0, errorMessage: "insufficient_credits" };
  }

  // Agent Trace is scoped to the latest execution. Remove failure-enrichment
  // rows from an earlier attempt before a new run can create fresh ones.
  try {
    await deleteAgentQueriesForTestCase(testCase.id);
  } catch (traceCleanupError) {
    console.warn("[scheduler] previous agent trace cleanup skipped", traceCleanupError);
  }

  const [repoById] = testCase.repoId
    ? await db.select().from(repositories).where(eq(repositories.repoId, Number(testCase.repoId)))
    : [];
  const [repoByName] = !repoById
    ? await db.select().from(repositories).where(eq(repositories.fullName, `${testCase.repoOwner}/${testCase.repoName}`))
    : [];
  const repo = repoById || repoByName;
  const shouldGenerate = params.mode === "generate" || !testCase.browserbaseScript;
  let scriptText = testCase.browserbaseScript || "";
  let creditsUsed = shouldGenerate ? 0 : 70;
  let session: { id: string; connectUrl: string } | null = null;
  let browser: any = null;
  let page: Page | null = null;
  const runId = newRunId();

  try {
    if (shouldGenerate) {
      scriptText = await generateTestScript({
        testCase,
        repo,
        baseUrl: params.baseUrl,
        githubToken: params.githubToken,
        customPrompt: params.customPrompt,
        runId,
      });
      creditsUsed = 70;
      await db.update(TestCasesTable).set({
        browserbaseScript: scriptText,
        status: "running",
        visionAnalysis: null,
        failureContext: null,
      }).where(eq(TestCasesTable.id, testCase.id));
    } else {
      await db.update(TestCasesTable).set({
        status: "running",
        visionAnalysis: null,
        failureContext: null,
      }).where(eq(TestCasesTable.id, testCase.id));
    }

    const customConsole = {
      log: (...args: unknown[]) => logs.push(serializeLogArgs(args)),
      error: (...args: unknown[]) => logs.push(`[ERROR] ${serializeLogArgs(args)}`),
      warn: (...args: unknown[]) => logs.push(`[WARN] ${serializeLogArgs(args)}`),
    };
    session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID! });
    logs.push(`[SYSTEM] Browserbase session created successfully with ID: ${session.id}`);
    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    page = context.pages()[0] ?? null;
    if (!page) throw new Error("browserbase_page_missing");
    page.on("console", (message: any) => logs.push(`[BROWSER] [${message.type().toUpperCase()}] ${message.text()}`));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runFn = new AsyncFunction("page", "assert", "console", scriptText);
    const assertHelper = (condition: boolean, message?: string) => {
      if (!condition) throw new Error(message || "Assertion failed");
    };
    await runFn(page, assertHelper, customConsole);
    logs.push("[SYSTEM] Script execution completed successfully without errors.");
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await db.update(TestCasesTable).set({
      status: "passed", browserbaseScript: scriptText, logs,
      sessionId: session.id, sessionUrl: `https://www.browserbase.com/sessions/${session.id}`,
      visionAnalysis: null, failureContext: null,
    }).where(eq(TestCasesTable.id, testCase.id));
    await db.update(users).set({ credits: user.credits - creditsUsed }).where(eq(users.id, user.id));
    return { status: "passed", logs, sessionId: session.id, sessionUrl: `https://www.browserbase.com/sessions/${session.id}`, creditsUsed, browserbaseScript: scriptText };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logs.push(`[SYSTEM ERROR] Script execution failed: ${message}`);
    let failureContext: FailureContext = { items: [], queries_run: [], coral_available: false };
    let visionAnalysis: string | undefined;
    try {
      failureContext = await fetchFailureContext(testCase, runId);
      const screenshot = page ? await captureScreenshot(page) : null;
      if (screenshot) {
        visionAnalysis = await analyzeScreenshot(
          screenshot,
          `${testCase.title}: ${testCase.description}. Expected: ${testCase.expectedResult || "N/A"}`,
          failureContext.items
        );
      }
    } catch (enrichmentError) {
      logs.push(`[SYSTEM] Failure enrichment skipped: ${enrichmentError instanceof Error ? enrichmentError.message : String(enrichmentError)}`);
    }
    await pendoTrackServer("failure_context_enriched", {
      test_case_id: testCase.id,
      coral_available: failureContext.coral_available,
      context_items_count: failureContext.items.length,
      queries_run_count: failureContext.queries_run.length,
      has_vision_analysis: Boolean(visionAnalysis),
    }, params.trackingUserId || String(params.localUserId));
    if (browser) await browser.close().catch(() => undefined);
    await db.update(TestCasesTable).set({
      status: "failed", browserbaseScript: scriptText || null, logs,
      sessionId: session?.id || null,
      sessionUrl: session ? `https://www.browserbase.com/sessions/${session.id}` : null,
      visionAnalysis: visionAnalysis || null, failureContext,
    }).where(eq(TestCasesTable.id, testCase.id));
    if (creditsUsed > 0) {
      await db.update(users).set({ credits: user.credits - creditsUsed }).where(eq(users.id, user.id));
    }
    return {
      status: "failed", logs, sessionId: session?.id,
      sessionUrl: session ? `https://www.browserbase.com/sessions/${session.id}` : undefined,
      visionAnalysis, creditsUsed, errorMessage: message,
      browserbaseScript: scriptText || undefined,
      failureContext,
    };
  }
}
