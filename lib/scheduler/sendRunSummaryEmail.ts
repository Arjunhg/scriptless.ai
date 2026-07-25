import { Resend } from "resend";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
      character
    ] as string)
  );
}

export async function sendRunSummaryEmail(params: {
  to: string;
  repoFullName: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  errorMessage?: string | null;
  workspaceUrl: string;
}): Promise<void> {
  // Send if there are individual test failures OR if the run itself errored
  // out before tests could run (e.g. token decryption failure, user not found).
  if (params.failedTests <= 0 && !params.errorMessage) return;
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn("[scheduler] email notification skipped: Resend is not configured");
    return;
  }

  const passRate = params.totalTests
    ? Math.round((params.passedTests / params.totalTests) * 100)
    : 0;
  const repo = escapeHtml(params.repoFullName);
  const workspaceUrl = escapeHtml(params.workspaceUrl);

  const statsHtml = params.totalTests > 0
    ? `<p><strong>Passed:</strong> ${params.passedTests} &nbsp; <strong>Failed:</strong> ${params.failedTests} &nbsp; <strong>Pass rate:</strong> ${passRate}%</p>`
    : "";
  const errorHtml = params.errorMessage
    ? `<p><strong>Error:</strong> ${escapeHtml(params.errorMessage)}</p>`
    : "";

  try {
    await new Resend(apiKey).emails.send({
      from,
      to: params.to,
      subject: `Scheduled test run failed for ${params.repoFullName}`,
      html: `<h2>Scheduled test run</h2><p><strong>Repository:</strong> ${repo}</p>${statsHtml}${errorHtml}<p><a href="${workspaceUrl}">Open Scriptless workspace</a></p>`,
    });
  } catch (error) {
    console.error("[scheduler] run summary email failed", error);
  }
}