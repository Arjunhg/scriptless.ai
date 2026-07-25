import { GoogleGenAI } from "@google/genai";
import { TestCasesTable, repositories } from "@/db/schema";

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
  const prompt = `You are an expert QA automation engineer. Write only executable Playwright JavaScript for this test case.
        Application base URL: ${params.baseUrl}
        Title: ${params.testCase.title}
        Description: ${params.testCase.description}
        Target route: ${params.testCase.targetRoute || "/"}
        Expected result: ${params.testCase.expectedResult || "not specified"}
        ${params.repo?.gloablInstruction ? `Global project instructions:\n${params.repo.gloablInstruction}\n` : ""}
        ${params.customPrompt ? `Additional runtime instructions:\n${params.customPrompt}\n` : ""}
        Source context:\n${repoContext || "No source files were available."}

The script runs inside an async function with injected page and console variables. Define an assert helper, navigate to the target route, wait for the app to settle, use resilient role/label/text selectors, log useful steps, and assert the expected result with a case-insensitive substring check. Do not import modules or wrap the answer in markdown.`;
  const response = await ai.models.generateContent({ model: "gemini-3.1-flash-lite", contents: prompt });
  const script = (response.text || "").replace(/^```(?:javascript|js)?\s*/i, "").replace(/```\s*$/, "").trim();
  if (!script) throw new Error("script_generation_failed");
  return script;
}