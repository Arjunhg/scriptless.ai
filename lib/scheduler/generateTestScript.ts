import { GoogleGenAI } from "@google/genai";
import { TestCasesTable, repositories } from "@/db/schema";
import { tracedGenerateContent } from "@/lib/observability/gemini-tracing";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

async function readGithubFile(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string
) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
  );
  if (response.status === 401 || response.status === 403) throw new Error("github_token_expired");
  if (!response.ok) return null;
  const data = await response.json();
  if (!data.content) return null;
  return { path, content: Buffer.from(data.content, "base64").toString("utf8").slice(0, 5000) };
}

export async function generateTestScript(params: {
  testCase: typeof TestCasesTable.$inferSelect;
  repo: typeof repositories.$inferSelect | undefined;
  baseUrl: string;
  githubToken: string;
  customPrompt?: string;
  runId: string;
}): Promise<string> {
  if (!params.githubToken) throw new Error("github_token_missing");
  const files = Array.isArray(params.testCase.targetFiles) ? params.testCase.targetFiles : [];
  const contents = await Promise.all(files.map((file) => readGithubFile(
    params.testCase.repoOwner,
    params.testCase.repoName,
    file,
    params.testCase.branch || "main",
    params.githubToken
  )));
  const repoContext = contents.filter(Boolean)
    .map((file) => `File Path: ${file!.path}\n\n${file!.content}`)
    .join("\n\n---\n\n");
  const prompt = `You are writing the BODY of an async function that drives a live browser. Output raw JavaScript only — no markdown fences, no explanations.

Runtime contract — these variables are ALREADY in scope, do not declare or import them:
- page: a Playwright Page object connected to a remote browser. Use page.goto(), page.locator(), page.getByRole(), page.getByText(), etc.
- assert(condition, message): throws when condition is falsy.
- expect(actual): Playwright-style assertions — expect(locator).toBeVisible(), expect(locator).toContainText("..."), expect(page).toHaveTitle(...), expect(value).toBe(...), and each supports .not and a { timeout } option.
- console: logger piped into the test run logs.

Hard rules:
- NEVER use require(), import, or any module system. There is no test runner: do not use test(), describe(), or @playwright/test.
- NEVER declare your own assert, expect, page, or console variables.
- Write top-level await statements directly (e.g. "await page.goto(...)"), not a wrapper function.

Test case:
Application base URL: ${params.baseUrl}
Title: ${params.testCase.title}
Description: ${params.testCase.description}
Target route: ${params.testCase.targetRoute || "/"}
Expected result: ${params.testCase.expectedResult || "not specified"}
${params.repo?.gloablInstruction ? `Global project instructions:\n${params.repo.gloablInstruction}\n` : ""}
${params.customPrompt ? `Additional runtime instructions:\n${params.customPrompt}\n` : ""}
Source context:
${repoContext || "No source files were available."}

Navigate to the target route, wait for the app to settle, use resilient role/label/text selectors, log useful steps with console.log, and assert the expected result with a case-insensitive substring check.`;
  const response = await tracedGenerateContent({
    model: "gemini-3.1-flash-lite",
    operation: "script_generation",
    runId: params.runId,
    generate: () => ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: prompt,
    }),
  });
  const script = (response.text || "").replace(/^```(?:javascript|js)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!script) throw new Error("script_generation_failed");
  return script;
}