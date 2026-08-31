import { Client } from "@upstash/qstash";

function hoursToCron(intervalHours: number): string {
  switch (intervalHours) {
    case 6:
      return "0 */6 * * *";
    case 12:
      return "0 */12 * * *";
    case 24:
      return "0 0 * * *";
    case 48:
      return "0 0 */2 * *";
    default:
      throw new Error("unsupported_schedule_interval");
  }
}

function getClient(): Client {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("qstash_not_configured");
  return new Client({ token });
}

// QStash must be able to reach the endpoint over the public internet, so a
// loopback/private URL is never valid here. Guarding explicitly (instead of
// letting QStash reject it) lets us fall back to VERCEL_URL when
// NEXT_PUBLIC_APP_URL was only set for local development.
function isNonPublicUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    );
  } catch {
    return true;
  }
}

function getEndpointUrl(): string {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL;
  const vercelUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : undefined;
  const baseUrl =
    configuredUrl && !isNonPublicUrl(configuredUrl)
      ? configuredUrl
      : vercelUrl;
  if (!baseUrl || isNonPublicUrl(baseUrl)) {
    throw new Error("public_app_url_not_configured");
  }
  return `${baseUrl.replace(/\/$/, "")}/api/cron/run-scheduled`;
}

export async function upsertQStashSchedule(params: {
  dbScheduleId: number;
  intervalHours: number;
  existingQStashScheduleId?: string | null;
}): Promise<string> {
  // In development, skip actual QStash registration since localhost isn't reachable
  if (process.env.NODE_ENV === "development") {
    console.log("[scheduler] QStash registration skipped in development");
    return `dev-mock-schedule-${params.dbScheduleId}`;
  }

  const client = getClient();

  // Pass the existing scheduleId so QStash atomically replaces the old schedule
  // rather than doing a delete-then-create. This avoids a race window where a
  // transient delete failure would leave two active schedules firing for the
  // same DB record, which could cause duplicate test runs and double billing.
  const schedule = await client.schedules.create({
    destination: getEndpointUrl(),
    cron: hoursToCron(params.intervalHours),
    body: JSON.stringify({ scheduleId: params.dbScheduleId }),
    headers: { "Content-Type": "application/json" },
    retries: 3,
    ...(params.existingQStashScheduleId
      ? { scheduleId: params.existingQStashScheduleId }
      : {}),
  });
  return schedule.scheduleId;
}

export async function deleteQStashSchedule(scheduleId: string): Promise<void> {
  if (process.env.NODE_ENV === "development" || !process.env.QSTASH_TOKEN) return;
  await getClient().schedules.delete(scheduleId).catch(() => undefined);
}