import { Locator, Page } from "playwright-core";

/**
 * Runtime support for AI-generated test scripts.
 *
 * Generated scripts are compiled with `new AsyncFunction("page", "assert",
 * "expect", "console", script)` — they are function bodies, not Node modules,
 * so `require`/`import` do not exist. Models still occasionally emit
 * Playwright-test idioms (`require('@playwright/test')`, `expect(...)`,
 * re-declared `assert` helpers), so we strip those at the edges and back the
 * remaining `expect` calls with a small Playwright-compatible shim.
 */

const DEFAULT_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 250;

const isLocator = (value: unknown): value is Locator =>
  !!value && typeof value === "object" &&
  typeof (value as Locator).isVisible === "function" &&
  typeof (value as Locator).count === "function";

const isPage = (value: unknown): value is Page =>
  !!value && typeof value === "object" &&
  typeof (value as Page).title === "function" &&
  typeof (value as Page).goto === "function";

type MatcherOptions = { timeout?: number; ignoreCase?: boolean };

type ParsedArgs = { timeout: number; ignoreCase: boolean; rest: unknown[] };

function parseArgs(args: unknown[]): ParsedArgs {
  const last = args[args.length - 1];
  if (last && typeof last === "object" && !Array.isArray(last)) {
    const opts = last as MatcherOptions;
    return {
      timeout: typeof opts.timeout === "number" ? opts.timeout : DEFAULT_TIMEOUT_MS,
      ignoreCase: opts.ignoreCase === true,
      rest: args.slice(0, -1),
    };
  }
  return { timeout: DEFAULT_TIMEOUT_MS, ignoreCase: false, rest: args };
}

function textMatches(actual: string | null, expected: unknown, ignoreCase: boolean): boolean {
  if (actual === null) return false;
  if (expected instanceof RegExp) return expected.test(actual);
  const expectedText = String(expected);
  return ignoreCase
    ? actual.toLowerCase().includes(expectedText.toLowerCase())
    : actual.includes(expectedText);
}

function textEquals(actual: string | null, expected: unknown, ignoreCase: boolean): boolean {
  if (actual === null) return false;
  if (expected instanceof RegExp) return expected.test(actual);
  const expectedText = String(expected);
  return ignoreCase
    ? actual.trim().toLowerCase() === expectedText.trim().toLowerCase()
    : actual.trim() === expectedText;
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null) return false;
  if (typeof actual === "object" && typeof expected === "object") {
    try {
      return JSON.stringify(actual) === JSON.stringify(expected);
    } catch {
      return false;
    }
  }
  return false;
}

type Check = (actual: unknown, args: ParsedArgs) => Promise<boolean>;

const locatorChecks: Record<string, Check> = {
  async toBeVisible(actual) {
    return isLocator(actual) ? actual.isVisible() : false;
  },
  async toBeHidden(actual) {
    return isLocator(actual) ? !(await actual.isVisible()) : false;
  },
  async toBeEnabled(actual) {
    return isLocator(actual) ? actual.isEnabled() : false;
  },
  async toBeDisabled(actual) {
    return isLocator(actual) ? !(await actual.isEnabled()) : false;
  },
  async toContainText(actual, { rest, ignoreCase }) {
    const [expected] = rest;
    if (typeof actual === "string") return textMatches(actual, expected, ignoreCase);
    if (!isLocator(actual)) return false;
    if (Array.isArray(expected)) {
      const texts = await actual.allTextContents();
      return expected.every((item) => textMatches(texts.join("\n"), item, ignoreCase));
    }
    return textMatches(await actual.textContent(), expected, ignoreCase);
  },
  async toHaveText(actual, { rest, ignoreCase }) {
    const [expected] = rest;
    if (typeof actual === "string") return textEquals(actual, expected, ignoreCase);
    if (!isLocator(actual)) return false;
    if (Array.isArray(expected)) {
      const texts = await actual.allTextContents();
      return expected.length === texts.length &&
        expected.every((item, i) => textEquals(texts[i] ?? null, item, ignoreCase));
    }
    return textEquals(await actual.textContent(), expected, ignoreCase);
  },
  async toHaveCount(actual, { rest }) {
    if (!isLocator(actual)) return false;
    return (await actual.count()) === Number(rest[0]);
  },
  async toHaveValue(actual, { rest }) {
    if (!isLocator(actual)) return false;
    try {
      return (await actual.inputValue()) === String(rest[0]);
    } catch {
      return false;
    }
  },
};

const pageChecks: Record<string, Check> = {
  async toHaveTitle(actual, { rest }) {
    return isPage(actual) && textEquals(await actual.title(), rest[0], false);
  },
  async toHaveURL(actual, { rest }) {
    if (!isPage(actual)) return false;
    const [expected] = rest;
    const url = actual.url();
    return expected instanceof RegExp ? expected.test(url) : url === String(expected);
  },
};

const valueChecks: Record<string, Check> = {
  async toBe(actual, { rest }) {
    return Object.is(actual, rest[0]);
  },
  async toEqual(actual, { rest }) {
    return looseEquals(actual, rest[0]);
  },
  async toStrictEqual(actual, { rest }) {
    return looseEquals(actual, rest[0]);
  },
  async toBeTruthy(actual) {
    return Boolean(actual);
  },
  async toBeFalsy(actual) {
    return !actual;
  },
  async toBeNull(actual) {
    return actual === null;
  },
  async toBeUndefined(actual) {
    return actual === undefined;
  },
  async toBeDefined(actual) {
    return actual !== undefined;
  },
  async toContain(actual, { rest }) {
    if (typeof actual === "string") {
      const [expected] = rest;
      return expected instanceof RegExp ? expected.test(actual) : actual.includes(String(expected));
    }
    if (Array.isArray(actual)) return actual.some((item) => looseEquals(item, rest[0]));
    return false;
  },
  async toMatch(actual, { rest }) {
    if (typeof actual !== "string") return false;
    const [expected] = rest;
    return expected instanceof RegExp ? expected.test(actual) : actual.includes(String(expected));
  },
  async toHaveLength(actual, { rest }) {
    return actual != null && typeof (actual as { length?: unknown }).length === "number" &&
      (actual as unknown[]).length === Number(rest[0]);
  },
  async toBeGreaterThan(actual, { rest }) {
    return Number(actual) > Number(rest[0]);
  },
  async toBeLessThan(actual, { rest }) {
    return Number(actual) < Number(rest[0]);
  },
};

const allChecks: Record<string, Check> = { ...locatorChecks, ...pageChecks, ...valueChecks };

type Matchers = Record<string, (...args: unknown[]) => Promise<void>>;

function previewValue(value: unknown): string {
  if (value instanceof RegExp) return value.toString();
  try {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
}

/** Human-readable description of `expect(actual)`'s actual for error messages. */
async function describeActual(actual: unknown): Promise<string> {
  if (typeof actual === "string") return previewValue(actual);
  if (isLocator(actual)) {
    try {
      const text = await actual.textContent();
      return text === null || text.trim() === ""
        ? "locator (no text)"
        : previewValue(text.trim());
    } catch {
      return "locator (text unavailable)";
    }
  }
  if (isPage(actual)) return `page ${actual.url()}`;
  return previewValue(actual);
}

function buildMatchers(actual: unknown, invert: boolean): Matchers {
  const matchers: Matchers = {};
  for (const [name, check] of Object.entries(allChecks)) {
    matchers[name] = async (...args: unknown[]) => {
      const parsed = parseArgs(args);
      const run = () => check(actual, parsed).catch(() => false);
      const deadline = Date.now() + parsed.timeout;
      for (;;) {
        // Playwright semantics: poll until the assertion is satisfied —
        // for `.not` matchers that means the positive check is false (e.g.
        // "Loading..." text has cleared), failing only if it holds for the
        // whole timeout. Never the reverse: a momentary true must not fail
        // a `.not` assertion, and a satisfied `.not` must not poll on.
        const satisfied = invert ? !(await run()) : await run();
        if (satisfied) return;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      const verb = invert ? `not.${name}` : name;
      const expected = parsed.rest.length === 1 ? previewValue(parsed.rest[0]) : previewValue(parsed.rest);
      throw new Error(
        `expect(...).${verb}() failed after ${parsed.timeout}ms` +
          ` (expected${invert ? " not" : ""}: ${expected}, actual: ${await describeActual(actual)})`
      );
    };
  }
  return matchers;
}

/** Minimal Playwright-style `expect` for values, locators, and pages. */
export function buildExpectShim() {
  return function expect(actual: unknown): Matchers & { not: Matchers } {
    const matchers = buildMatchers(actual, false);
    return Object.assign(matchers, { not: buildMatchers(actual, true) });
  };
}

const NET_DEPTH = /[{([]|[}\])]/g;

/** Net bracket depth of a line (opens minus closes), ignoring nothing fancy. */
function netDepth(line: string): number {
  let depth = 0;
  for (const char of line.matchAll(NET_DEPTH)) {
    depth += "[{(".includes(char[0]) ? 1 : -1;
  }
  return depth;
}

/**
 * Remove `const assert = ...` / `function assert(...) {...}` declarations.
 * `assert` is injected as a function parameter, so re-declaring it at the top
 * level of the script body is a SyntaxError. Declarations often span several
 * lines, so removal continues until brackets balance.
 */
function removeAssertDeclarations(lines: string[]): string[] {
  const startsDeclaration = (line: string) =>
    /^[ \t]*(?:const|let|var)\s+assert\s*=/.test(line) ||
    /^[ \t]*(?:async\s+)?function\s+assert\s*\(/.test(line);

  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!startsDeclaration(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    let depth = netDepth(lines[i]);
    while (depth > 0 && i + 1 < lines.length) {
      i += 1;
      depth += netDepth(lines[i]);
    }
  }
  return kept;
}

/**
 * Strip the constructs that cannot run inside the AsyncFunction sandbox:
 * markdown fences, require/import statements, and `assert` re-declarations
 * (assert is injected as a function parameter, so a top-level `const assert`
 * is a SyntaxError). `expect` calls are left alone — the shim covers them.
 */
export function normalizeGeneratedScript(raw: string): { script: string; removed: string[] } {
  const removed: string[] = [];
  let script = raw.trim();

  const fenced = script.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fenced) {
    script = fenced[1].trim();
    removed.push("markdown fences");
  }

  const requireLine = /^[ \t]*(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\s*\([^)]*\)\s*;?[ \t]*$/gm;
  const bareRequire = /^[ \t]*require\s*\([^)]*\)\s*;?[ \t]*$/gm;
  const importStatement = /^[ \t]*import\s+[\s\S]*?from\s*['"][^'"]*['"]\s*;?[ \t]*$/m;

  if (requireLine.test(script) || bareRequire.test(script) || importStatement.test(script)) {
    script = script
      .replace(requireLine, "")
      .replace(bareRequire, "")
      .replace(importStatement, "");
    removed.push("require/import statements");
  }

  const lines = script.split("\n");
  const withoutAssert = removeAssertDeclarations(lines);
  if (withoutAssert.length !== lines.length) {
    script = withoutAssert.join("\n");
    removed.push("duplicate assert declarations");
  }
  return { script: script.trim(), removed };
}
