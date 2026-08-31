import { OTLPHttpJsonTraceExporter, registerOTel } from '@vercel/otel';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

export function register() {
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME || 'scriptless',
    traceExporter: new OTLPHttpJsonTraceExporter({
      // Self-hosted SigNoz via Foundry — no ingestion key or TLS is required.
      url:
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
        'http://localhost:4318/v1/traces',
    }),
  });
}
