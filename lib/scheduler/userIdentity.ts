import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

export async function resolveLocalUserId(clerkUserId: string): Promise<number | null> {
  const client = await clerkClient();
  const clerkUser = await client.users.getUser(clerkUserId);
  const primary = clerkUser.emailAddresses.find(
    (email) => email.id === clerkUser.primaryEmailAddressId
  );
  const email = primary?.emailAddress || clerkUser.emailAddresses[0]?.emailAddress;
  if (!email) return null;
  const [localUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  return localUser?.id ?? null;
}