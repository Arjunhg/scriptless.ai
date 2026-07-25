import { Page } from "playwright-core";

export function serializeLogArgs(args: unknown[]): string {
  return args.map((value) => {
    if (typeof value === "object" && value !== null) {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    return String(value);
  }).join(" ");
}

export async function captureScreenshot(page: Page): Promise<string | null> {
  try {
    const buffer = await page.screenshot({ type: "jpeg", quality: 72, fullPage: false });
    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  } catch { return null; }
}