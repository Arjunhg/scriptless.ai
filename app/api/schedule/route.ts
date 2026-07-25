import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduledRuns } from "@/db/schema";
import { encryptToken } from "@/lib/scheduler/tokenEncryption";
import { deleteQStashSchedule, upsertQStashSchedule } from "@/lib/scheduler/qstash";

const VALID_SCOPES = new Set(["all", "failed", "smart"]);
const VALID_INTERVALS = new Set([6, 12, 24, 48]);

function publicSchedule(row: typeof scheduledRuns.$inferSelect | undefined) {
  if (!row) return null;
  const { encryptedGithubToken, tokenIv, tokenTag, ...safe } = row;
  return safe;
}

function parseRepoId(value: unknown): number | null {
  const repoId = typeof value === "number" ? value : Number(value);
  return Number.isInteger(repoId) && repoId > 0 ? repoId : null;
}

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repoId = parseRepoId(req.nextUrl.searchParams.get("repoId"));
  if (!repoId) return NextResponse.json({ error: "repo_id_required" }, { status: 400 });
  const [schedule] = await db.select().from(scheduledRuns).where(
    and(eq(scheduledRuns.userId, userId), eq(scheduledRuns.repoId, repoId))
  );
  return NextResponse.json({ schedule: publicSchedule(schedule) });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const repoId = parseRepoId(body?.repoId);
  const repoOwner = typeof body?.repoOwner === "string" ? body.repoOwner.trim() : "";
  const repoName = typeof body?.repoName === "string" ? body.repoName.trim() : "";
  const scope = typeof body?.scope === "string" ? body.scope : "all";
  const intervalHours = Number(body?.intervalHours);
  const enabled = body?.enabled === false ? 0 : 1;
  const notifyEmail = typeof body?.notifyEmail === "string" && body.notifyEmail.trim()
    ? body.notifyEmail.trim()
    : null;
  if (!repoId || !repoOwner || !repoName || !VALID_SCOPES.has(scope) || !VALID_INTERVALS.has(intervalHours)) {
    return NextResponse.json({ error: "invalid_schedule" }, { status: 400 });
  }
  if (notifyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)) {
    return NextResponse.json({ error: "invalid_notify_email" }, { status: 400 });
  }

  const [existing] = await db.select().from(scheduledRuns).where(
    and(eq(scheduledRuns.userId, userId), eq(scheduledRuns.repoId, repoId))
  );

  // The GitHub token is only needed when enabling a schedule — it gets encrypted
  // and stored so the cron runner can authenticate later. When the user is only
  // disabling (pausing) an existing schedule, the token path is irrelevant and
  // must not block the request, e.g. when the gh_token cookie has expired.
  let encryptedFields: {
    encryptedGithubToken: string;
    tokenIv: string;
    tokenTag: string;
  };

  if (enabled) {
    const githubToken = (await cookies()).get("gh_token")?.value;
    if (!githubToken) {
      return NextResponse.json({
        error: "github_token_missing",
        detail: "Please ensure you are connected to GitHub before scheduling.",
      }, { status: 400 });
    }
    const encrypted = encryptToken(githubToken);
    encryptedFields = {
      encryptedGithubToken: encrypted.encrypted,
      tokenIv: encrypted.iv,
      tokenTag: encrypted.tag,
    };
  } else {
    // Reuse whatever token is already stored; we are only pausing the schedule.
    encryptedFields = {
      encryptedGithubToken: existing?.encryptedGithubToken ?? "",
      tokenIv: existing?.tokenIv ?? "",
      tokenTag: existing?.tokenTag ?? "",
    };
  }

  const nextRunAt = new Date(Date.now() + intervalHours * 60 * 60 * 1000);
  const values = {
    userId,
    repoId,
    repoOwner,
    repoName,
    scope,
    intervalHours,
    enabled,
    notifyEmail,
    ...encryptedFields,
    nextRunAt,
    qstashScheduleId: existing?.qstashScheduleId ?? null,
    updatedAt: new Date(),
  };

  const [saved] = await db.insert(scheduledRuns).values(values).onConflictDoUpdate({
    target: [scheduledRuns.userId, scheduledRuns.repoId],
    set: {
      repoOwner, repoName, scope, intervalHours, enabled, notifyEmail,
      ...encryptedFields,
      nextRunAt,
      qstashScheduleId: existing?.qstashScheduleId ?? null,
      updatedAt: new Date(),
    },
  }).returning();

  if (!saved) return NextResponse.json({ error: "schedule_save_failed" }, { status: 500 });
  try {
    let qstashScheduleId: string | null = null;
    if (enabled) {
      qstashScheduleId = await upsertQStashSchedule({
        dbScheduleId: saved.id,
        intervalHours,
        existingQStashScheduleId: existing?.qstashScheduleId,
      });
    } else if (existing?.qstashScheduleId) {
      await deleteQStashSchedule(existing.qstashScheduleId);
    }
    const [updated] = await db.update(scheduledRuns).set({ qstashScheduleId, updatedAt: new Date() }).where(eq(scheduledRuns.id, saved.id)).returning();
    return NextResponse.json({ schedule: publicSchedule(updated || saved) });
  } catch (error) {
    console.error("[scheduler] QStash registration failed", error);
    return NextResponse.json({ error: "schedule_registration_failed" }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const repoId = parseRepoId(body?.repoId);
  if (!repoId) return NextResponse.json({ error: "repo_id_required" }, { status: 400 });
  const [existing] = await db.select().from(scheduledRuns).where(
    and(eq(scheduledRuns.userId, userId), eq(scheduledRuns.repoId, repoId))
  );
  if (existing?.qstashScheduleId) {
    await deleteQStashSchedule(existing.qstashScheduleId).catch((error) => {
      console.error("[scheduler] failed to delete QStash schedule", error);
    });
  }
  await db.delete(scheduledRuns).where(
    and(eq(scheduledRuns.userId, userId), eq(scheduledRuns.repoId, repoId))
  );
  return NextResponse.json({ success: true });
}