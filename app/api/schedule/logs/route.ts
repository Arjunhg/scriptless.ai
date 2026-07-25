import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduledRunLogs } from "@/db/schema";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const repoId = Number(req.nextUrl.searchParams.get("repoId"));
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return NextResponse.json({ error: "repo_id_required" }, { status: 400 });
  }
  const logs = await db.select().from(scheduledRunLogs).where(
    and(eq(scheduledRunLogs.userId, userId), eq(scheduledRunLogs.repoId, repoId))
  ).orderBy(desc(scheduledRunLogs.createdAt)).limit(10);
  return NextResponse.json({ logs });
}