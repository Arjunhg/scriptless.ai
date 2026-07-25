import { NextRequest, NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { TestCasesTable, users } from "@/db/schema";
import { withCoralTenant } from "@/lib/coral/client";
import { executeTestCase } from "@/lib/scheduler/executeTestCase";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return withCoralTenant(userId, async () => {
    try {
      const body = await req.json();
      const testCaseId = Number(body?.testCaseId);
      const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
      const mode = body?.mode === "cache" || body?.mode === "cached" ? "cached" : "generate";
      const customPrompt = typeof body?.customPrompt === "string" ? body.customPrompt : "";
      if (!Number.isInteger(testCaseId) || !baseUrl) {
        return NextResponse.json(
          { error: "testCaseId and baseUrl are required" },
          { status: 400 }
        );
      }

      const [testCase] = await db
        .select()
        .from(TestCasesTable)
        .where(eq(TestCasesTable.id, testCaseId));
      if (!testCase) return NextResponse.json({ error: "Test case not found" }, { status: 404 });

      let localUserId = Number(testCase.userId);
      if (!Number.isInteger(localUserId)) {
        const clerkUser = await currentUser();
        const email = clerkUser?.primaryEmailAddress?.emailAddress;
        if (email) {
          const [localUser] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, email));
          localUserId = localUser?.id ?? NaN;
        }
      }
      if (!Number.isInteger(localUserId)) {
        return NextResponse.json({ error: "user_not_found" }, { status: 404 });
      }

      const [user] = await db.select().from(users).where(eq(users.id, localUserId));
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
      if (user.credits < 70) {
        return NextResponse.json(
          { error: "Insufficient credits to run test case." },
          { status: 402 }
        );
      }

      const githubToken = (await cookies()).get("gh_token")?.value || "";
      if ((mode === "generate" || !testCase.browserbaseScript) && !githubToken) {
        return NextResponse.json(
          { error: "GitHub authentication token is missing or expired" },
          { status: 401 }
        );
      }

      const result = await executeTestCase({
        testCaseId,
        baseUrl,
        githubToken,
        mode,
        customPrompt,
        localUserId,
        trackingUserId: userId,
      });

      if (result.errorMessage === "insufficient_credits") {
        return NextResponse.json({ error: "Insufficient credits to run test case." }, { status: 402 });
      }

      if (result.status === "passed") {
        return NextResponse.json({
          success: true,
          status: result.status,
          sessionId: result.sessionId,
          sessionUrl: result.sessionUrl,
          logs: result.logs,
          credits: Math.max(0, user.credits - result.creditsUsed),
          browserbaseScript: result.browserbaseScript,
          failureContext: result.failureContext ?? null,
        });
      }

      return NextResponse.json({
        success: false,
        status: result.status,
        error: result.errorMessage || "test_execution_failed",
        sessionId: result.sessionId,
        sessionUrl: result.sessionUrl || null,
        visionAnalysis: result.visionAnalysis,
        logs: result.logs,
        credits: Math.max(0, user.credits - result.creditsUsed),
        browserbaseScript: result.browserbaseScript,
        failureContext: result.failureContext ?? null,
      });
    } catch (error) {
      console.error("API endpoint error:", error);
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "internal" },
        { status: 500 }
      );
    }
  });
}