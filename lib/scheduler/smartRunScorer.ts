import { TestCasesTable } from "@/db/schema";

export type TestCase = typeof TestCasesTable.$inferSelect;

export type PrioritizedTest = {
  id: number;
  title: string;
  score: number;
  reason: string;
};

function timestamp(value: unknown): number {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function scoreTests(
  allTests: TestCase[],
  recentFiles: Set<string>
): PrioritizedTest[] {
  const scored = allTests.map((testCase) => {
    const files = Array.isArray(testCase.targetFiles) ? testCase.targetFiles : [];
    const overlap = files.filter((file) =>
      [...recentFiles].some(
        (recentFile) => file.includes(recentFile) || recentFile.includes(file)
      )
    );
    let score = overlap.length > 0 ? 10 + overlap.length : 0;
    if (testCase.status === "failed") score += 5;
    return { testCase, score, overlap };
  });

  let prioritized = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.testCase.id - a.testCase.id)
    .slice(0, 15);

  if (prioritized.length === 0) {
    prioritized = scored
      .filter((item) => item.testCase.status === "failed")
      .sort((a, b) => b.testCase.id - a.testCase.id)
      .slice(0, 10)
      .map((item) => ({ ...item, score: 5 }));
  }

  if (prioritized.length === 0) {
    prioritized = scored
      .sort((a, b) => {
        const aTime = timestamp(a.testCase.createdAt);
        const bTime = timestamp(b.testCase.createdAt);
        return bTime - aTime || b.testCase.id - a.testCase.id;
      })
      .slice(0, 10)
      .map((item) => ({ ...item, score: 2 }));
  }

  return prioritized.map(({ testCase, score, overlap }) => ({
    id: testCase.id,
    title: testCase.title,
    score,
    reason:
      overlap.length > 0
        ? `Targets recently changed files: ${overlap.slice(0, 2).join(", ")}`
        : testCase.status === "failed"
          ? "Recently failed test"
          : "Recent test case (no file-level signals)",
  }));
}