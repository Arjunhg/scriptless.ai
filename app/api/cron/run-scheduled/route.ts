import { NextRequest, NextResponse } from "next/server";
import { Receiver } from "@upstash/qstash";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduledRunLogs, scheduledRuns } from "@/db/schema";
import { pendoTrackServer } from "@/lib/pendo/track";
import { resolveLocalUserId } from "@/lib/scheduler/userIdentity";
import { runScheduledTests, ScheduledRunSummary } from "@/lib/scheduler/runScheduledTests";
import { sendRunSummaryEmail } from "@/lib/scheduler/sendRunSummaryEmail";

export const runtime = "nodejs";
export const maxDuration = 300;

function errorSummary(message: string): ScheduledRunSummary {
  return {
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    durationMs: 0,
    status: "failed",
    errorMessage: message,
  };
}

async function verifyRequest(req: NextRequest, body: string): Promise<boolean> {
  if (process.env.NODE_ENV === "development") return true;
  const signature = req.headers.get("upstash-signature") || "";
  if (!signature || !process.env.QSTASH_CURRENT_SIGNING_KEY || !process.env.QSTASH_NEXT_SIGNING_KEY) return false;
  return new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
  }).verify({ signature, body }).catch(() => false);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  if (!(await verifyRequest(req, body))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: { scheduleId?: number };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!Number.isInteger(payload.scheduleId) || (payload.scheduleId as number) <= 0) {
    return NextResponse.json({ error: "schedule_id_required" }, { status: 400 });
  }

  const [schedule] = await db.select().from(scheduledRuns).where(eq(scheduledRuns.id, payload.scheduleId as number));
  if (!schedule || schedule.enabled === 0) return NextResponse.json({ skipped: true });

  let summary: ScheduledRunSummary;
  try {
    const localUserId = await resolveLocalUserId(schedule.userId);
    if (!localUserId) throw new Error("local_user_not_found");
    summary = await runScheduledTests({ ...schedule, localUserId });
  } catch (error) {
    summary = errorSummary(error instanceof Error ? error.message : String(error));
  }

  try {
    await db.insert(scheduledRunLogs).values({
      scheduleId: schedule.id,
      userId: schedule.userId,
      repoId: schedule.repoId,
      repoName: `${schedule.repoOwner}/${schedule.repoName}`,
      scope: schedule.scope,
      totalTests: summary.totalTests,
      passedTests: summary.passedTests,
      failedTests: summary.failedTests,
      skippedTests: summary.skippedTests,
      durationMs: summary.durationMs,
      status: summary.status,
      errorMessage: summary.errorMessage || null,
    });
    await db.update(scheduledRuns).set({ lastRunAt: new Date(), updatedAt: new Date() }).where(eq(scheduledRuns.id, schedule.id));
    void pendoTrackServer("scheduled_run_completed", {
      repoId: schedule.repoId,
      scope: schedule.scope,
      totalTests: summary.totalTests,
      passedTests: summary.passedTests,
      failedTests: summary.failedTests,
      status: summary.status,
    }, schedule.userId);
    if (schedule.notifyEmail && (summary.failedTests > 0 || summary.status === "failed")) {
      const workspaceUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:4000");
      await sendRunSummaryEmail({
        to: schedule.notifyEmail,
        repoFullName: `${schedule.repoOwner}/${schedule.repoName}`,
        totalTests: summary.totalTests,
        passedTests: summary.passedTests,
        failedTests: summary.failedTests,
        errorMessage: summary.errorMessage,
        workspaceUrl,
      });
    }
    return NextResponse.json({ ran: 1, result: summary });
  } catch (error) {
    console.error("[scheduler] failed to persist scheduled run", error);
    return NextResponse.json({ error: "scheduled_run_persistence_failed" }, { status: 500 });
  }
}