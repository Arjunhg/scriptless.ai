import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("scriptless-nvidia");

export type NvidiaChatCompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type NvidiaChatCompletionResult = {
  usage?: NvidiaChatCompletionUsage | null;
};

export async function tracedChatCompletion<T extends NvidiaChatCompletionResult>(params: {
  model: string;
  operation: string;
  runId?: string;
  attemptIndex?: number;
  generate: () => Promise<T>;
}): Promise<T> {
  return tracer.startActiveSpan("nvidia.chat_completion", async (span) => {
    span.setAttribute("gen_ai.system", "nvidia");
    span.setAttribute("gen_ai.operation.name", "chat");
    span.setAttribute("gen_ai.request.model", params.model);
    span.setAttribute("scriptless.operation", params.operation);
    if (params.runId) span.setAttribute("agent.run_id", params.runId);
    if (params.attemptIndex != null) {
      span.setAttribute("nvidia.attempt_index", params.attemptIndex);
    }

    try {
      const response = await params.generate();
      const usage = response?.usage;
      if (usage) {
        if (usage.prompt_tokens != null) {
          span.setAttribute("gen_ai.usage.input_tokens", usage.prompt_tokens);
        }
        if (usage.completion_tokens != null) {
          span.setAttribute("gen_ai.usage.output_tokens", usage.completion_tokens);
        }
        if (usage.total_tokens != null) {
          span.setAttribute("gen_ai.usage.total_tokens", usage.total_tokens);
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
