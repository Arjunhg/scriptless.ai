import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("scriptless-agent");

type AgentAttributes = Record<string, string | number>;

function setAttributes(
  span: ReturnType<typeof tracer.startSpan>,
  attrs: AgentAttributes
): void {
  for (const [key, value] of Object.entries(attrs)) {
    span.setAttribute(key, value);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function traceAgentRun<T>(
  runId: string,
  attrs: AgentAttributes,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan("agent.run", async (span) => {
    span.setAttribute("agent.run_id", runId);
    setAttributes(span, attrs);

    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: unknown) {
      const exception = toError(error);
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function traceAgentStep<T>(
  stepName: string,
  attrs: AgentAttributes,
  fn: () => Promise<T>
): Promise<T> {
  return tracer.startActiveSpan(`agent.step.${stepName}`, async (span) => {
    setAttributes(span, attrs);

    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error: unknown) {
      const exception = toError(error);
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      throw error;
    } finally {
      span.end();
    }
  });
}
