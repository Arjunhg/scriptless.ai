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

  console.log("expect shim OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
