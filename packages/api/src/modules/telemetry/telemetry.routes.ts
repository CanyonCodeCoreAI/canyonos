import { Elysia } from 'elysia';

import { encode_export_response } from './otlp.decode';
import { ingest_logs_export, ingest_metric_export, ingest_trace_export } from './telemetry.service';

const OTLP_PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';

// An empty `Export<Signal>ServiceResponse` is zero bytes on the wire, which OTLP defines as full
// success. Metrics and logs keep every point they can decode, so they never reply anything else.
const otlp_success = () =>
  new Response(new Uint8Array(0), { headers: { 'content-type': OTLP_PROTOBUF_CONTENT_TYPE } });

const rejection_message = (rejected: number) =>
  `${rejected} span(s) rejected: a span needs a span id, a trace id and a non-zero end time.`;

// OTLP/HTTP is a bare protobuf POST, so the body is taken as bytes and the reply is the encoded
// `ExportTraceServiceResponse` rather than this API's usual JSON envelope.
export const telemetryRoutes = new Elysia({ prefix: '/v1', name: 'telemetry.routes' })
  .post(
    '/traces',
    async ({ body }) => {
      const { rejected } = await ingest_trace_export(new Uint8Array(body as ArrayBuffer));
      const response = encode_export_response(
        rejected,
        rejected > 0 ? rejection_message(rejected) : ''
      );
      return new Response(Buffer.from(response), {
        headers: { 'content-type': OTLP_PROTOBUF_CONTENT_TYPE },
      });
    },
    {
      parse: 'arrayBuffer',
      detail: {
        tags: ['Telemetry'],
        summary: 'Ingest an OTLP trace export as `application/x-protobuf`',
      },
    }
  )
  .post(
    '/metrics',
    async ({ body }) => {
      await ingest_metric_export(new Uint8Array(body as ArrayBuffer));
      return otlp_success();
    },
    {
      parse: 'arrayBuffer',
      detail: {
        tags: ['Telemetry'],
        summary: 'Ingest an OTLP metric export as `application/x-protobuf`',
      },
    }
  )
  .post(
    '/logs',
    async ({ body }) => {
      await ingest_logs_export(new Uint8Array(body as ArrayBuffer));
      return otlp_success();
    },
    {
      parse: 'arrayBuffer',
      detail: {
        tags: ['Telemetry'],
        summary: 'Ingest an OTLP logs export as `application/x-protobuf`',
      },
    }
  );
