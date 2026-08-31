import { normalizeGeneratedScript, buildExpectShim } from "@/lib/scheduler/scriptRuntime";

const raw = "```javascript\n" + String.raw`const { expect } = require('@playwright/test');

async function runTest() {
  const assert = (condition, message) => {
    if (!condition) throw new Error(message || 'Assertion failed');
  };

  console.log('Navigating to base URL...');
  await page.goto('https://b-graph.vercel.app/');

  await expect(page.locator('.workspace__status')).toContainText(/nodes and/i, { timeout: 15000 });

  console.log('Selecting a node from the graph...');
  const canvas = page.locator('canvas').first();
  await canvas.click();

  const detailPanel = page.locator('.node-detail-card');
  await expect(detailPanel).toBeVisible();

  const heading = detailPanel.locator('.node-detail-card__heading');
  await expect(heading).toBeVisible();

  const status = page.locator('.workspace__status');
  await expect(status).not.toContainText('Loading graph canvas...');

  console.log('Test completed.');
}

await runTest();` + "\n```";

async function main() {
  const { script, removed } = normalizeGeneratedScript(raw);

  console.log("REMOVED:", removed.join(", "));
  console.log("--- script ---");
  console.log(script);

  console.log("--- compile check ---");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  new AsyncFunction("page", "assert", "expect", "console", script);
  console.log("compiles OK");

  // sanity: expect shim value matchers
  const expect = buildExpectShim();

  await expect("5 nodes and 12 edges").toContainText(/nodes and/i, { timeout: 10 });
  await expect("hello").not.toContainText("world", { timeout: 10 });

  let threw = false;
  try {
    await expect("hello").toContainText("world", { timeout: 10 });
  } catch {
    threw = true;
  }

  if (!threw) {
    throw new Error("expect shim should have thrown");
  }

  // regression: `.not` must retry like Playwright, not fail on the first
  // poll where the positive condition happens to hold. Fake locator whose
  // text says "Loading graph canvas..." for 600ms, then clears — the exact
  // case that used to fail with
  // "expect(...).not.toContainText() failed after 25000ms (actual: object)".
  const makeFakeLocator = (clearsAfterMs: number | null) => {
    const start = Date.now();
    const text = () =>
      clearsAfterMs !== null && Date.now() - start < clearsAfterMs
        ? "Loading graph canvas..."
        : "5 nodes and 12 edges";
    return {
      isVisible: async () => true,
      count: async () => 1,
      textContent: async () => text(),
      allTextContents: async () => [text()],
    } as any;
  };

  // 1. text clears within the timeout -> `.not` must PASS (and fast)
  const startedAt = Date.now();
  await expect(makeFakeLocator(600)).not.toContainText("Loading graph canvas...", { timeout: 5000 });
  const elapsed = Date.now() - startedAt;
  if (elapsed > 3000) {
    throw new Error(`satisfied .not assertion polled too long: ${elapsed}ms`);
  }

  // 2. text never clears -> `.not` must FAIL with a useful message
  let notThrew = false;
  let notMessage = "";
  try {
    await expect(makeFakeLocator(null)).not.toContainText("Loading graph canvas...", { timeout: 300 });
  } catch (error) {
    notThrew = true;
    notMessage = error instanceof Error ? error.message : String(error);
  }
  if (!notThrew) {
    throw new Error(".not matcher should have failed when text never cleared");
  }
  if (!notMessage.includes("Loading graph canvas") || notMessage.includes("(actual: object)")) {
    throw new Error(`unhelpful failure message: ${notMessage}`);
  }

  // 3. positive matcher still fails when text never appears
  let positiveThrew = false;
  try {
    await expect(makeFakeLocator(null)).toContainText("Loading graph canvas...", { timeout: 10 });
  } catch {
    positiveThrew = true;
  }
  if (!positiveThrew) {
    throw new Error("positive matcher should have failed");
  }

  console.log("expect shim OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
