import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("scriptless-gemini");

type GeminiUsageMetadata = {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
};

type GeminiGenerateResponse = {
  text?: string;
  usageMetadata?: GeminiUsageMetadata;
};

export async function tracedGenerateContent<T extends GeminiGenerateResponse>(params: {
  model: string;
  operation: string;
  runId?: string;
  generate: () => Promise<T>;
}): Promise<T> {
  return tracer.startActiveSpan("gemini.generate_content", async (span) => {
    span.setAttribute("gen_ai.system", "gemini");
    span.setAttribute("gen_ai.operation.name", "generate_content");
    span.setAttribute("gen_ai.request.model", params.model);
    span.setAttribute("scriptless.operation", params.operation);
    if (params.runId) span.setAttribute("agent.run_id", params.runId);

    try {
      const response = await params.generate();
      const usage = response?.usageMetadata;
      if (usage) {
        if (usage.promptTokenCount != null) {
          span.setAttribute("gen_ai.usage.input_tokens", usage.promptTokenCount);
        }
        if (usage.candidatesTokenCount != null) {
          span.setAttribute("gen_ai.usage.output_tokens", usage.candidatesTokenCount);
        }
        if (usage.totalTokenCount != null) {
          span.setAttribute("gen_ai.usage.total_tokens", usage.totalTokenCount);
        }
        if (usage.cachedContentTokenCount != null) {
          span.setAttribute("gen_ai.usage.cached_tokens", usage.cachedContentTokenCount);
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return response;
    } catch (error: unknown) {
      const exception = error instanceof Error ? error : new Error(String(error));
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
