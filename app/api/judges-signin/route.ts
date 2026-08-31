import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Demo-only endpoint: issues a short-lived, single-use Clerk sign-in token
// for the pre-configured demo account so hackathon judges can enter the
// workspace with one click. Configure via JUDGES_CLERK_USER_ID (user_xxx)
// or JUDGES_CLERK_EMAIL in the environment; if neither is set the
// endpoint is disabled.
export async function POST() {
  const judgesUserId = process.env.JUDGES_CLERK_USER_ID!;
  const judgesEmail = process.env.JUDGES_CLERK_EMAIL;

  if (!judgesUserId && !judgesEmail) {
    return NextResponse.json(
      { error: "Demo sign-in is not configured." },
      { status: 404 }
    );
  }

  try {
    const client = await clerkClient();
    let userId = judgesUserId;

    if (!userId && judgesEmail) {
      const response = await client.users.getUserList({
        emailAddress: [judgesEmail],
      });
      const matched = response.data?.[0];
      if (!matched) {
        return NextResponse.json(
          { error: "Demo account not found." },
          { status: 404 }
        );
      }
      userId = matched.id;
    }

    const signInToken = await client.signInTokens.createSignInToken({
      userId,
      expiresInSeconds: 60,
    });

    if (!signInToken.token) {
      return NextResponse.json(
        { error: "Could not start demo session." },
        { status: 500 }
      );
    }

    return NextResponse.json({ token: signInToken.token });
  } catch (error) {
    console.error("[judges-signin] failed to create sign-in token:", error);
    return NextResponse.json(
      { error: "Could not start demo session." },
      { status: 500 }
    );
  }
}
