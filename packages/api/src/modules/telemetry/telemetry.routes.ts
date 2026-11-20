// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Elysia } from 'elysia';
import { z } from 'zod';

import { databasePlugin } from '@api/db/database';

import { encode_export_response } from './otlp.decode';
import { ingest_logs_export, ingest_metric_export, ingest_trace_export } from './telemetry.service';

const OTLP_PROTOBUF_CONTENT_TYPE = 'application/x-protobuf';

const GroupParams = z.object({ workflow_group_id: z.string().uuid() });

// An empty `Export<Signal>ServiceResponse` is zero bytes on the wire, which OTLP defines as full
// success. Metrics and logs keep every point they can decode, so they never reply anything else.
const otlp_success = () =>
  new Response(new Uint8Array(0), { headers: { 'content-type': OTLP_PROTOBUF_CONTENT_TYPE } });

const rejection_message = (rejected: number) =>
  `${rejected} span(s) rejected: a span needs a span id, a trace id, a non-zero end time and ` +
  "this workflow group's id.";

// OTLP/HTTP is a bare protobuf POST, so the body is taken as bytes and the reply is the encoded
// `ExportTraceServiceResponse` rather than this API's usual JSON envelope. Prefix-less: composed
// into workflow-groups.routes, where a Global Controller sends its workflow group's telemetry.
export const telemetryRoutes = new Elysia({ name: 'telemetry.routes' })
  .use(databasePlugin)
  .post(
    '/:workflow_group_id/traces',
    async ({ params, body }) => {
      const { rejected } = await ingest_trace_export(
        new Uint8Array(body as ArrayBuffer),
        params.workflow_group_id.toLowerCase()
      );
      const response = encode_export_response(
        rejected,
        rejected > 0 ? rejection_message(rejected) : ''
      );
      return new Response(Buffer.from(response), {
        headers: { 'content-type': OTLP_PROTOBUF_CONTENT_TYPE },
      });
    },
    {
      params: GroupParams,
      parse: 'arrayBuffer',
      detail: {
        tags: ['Telemetry'],
        summary: "Ingest an OTLP trace export of the workflow group's as `application/x-protobuf`",
      },
    }
  )
  .post(
    '/:workflow_group_id/metrics',
    async ({ params, body }) => {
      await ingest_metric_export(
        new Uint8Array(body as ArrayBuffer),
        params.workflow_group_id.toLowerCase()
      );
      return otlp_success();
    },
    {
      params: GroupParams,
      parse: 'arrayBuffer',
      detail: {
        tags: ['Telemetry'],
        summary: "Ingest an OTLP metric export of the workflow group's as `application/x-protobuf`",
      },
    }
  )
  .post(
    '/:workflow_group_id/logs',
    async ({ params, body }) => {
      await ingest_logs_export(
        new Uint8Array(body as ArrayBuffer),
        params.workflow_group_id.toLowerCase()
      );
      return otlp_success();
    },
    {
      params: GroupParams,
      parse: 'arrayBuffer',
      detail: {
        tags: ['Telemetry'],
        summary: "Ingest an OTLP logs export of the workflow group's as `application/x-protobuf`",
      },
    }
  );
