// SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

// The receiver writes OTLP/JSON, which spells this enum as the proto's own value names.
export const STATUS_CODE = {
  UNSET: 'STATUS_CODE_UNSET',
  OK: 'STATUS_CODE_OK',
  ERROR: 'STATUS_CODE_ERROR',
} as const;

// Spans carry their workflow's id, and that of the workflow group it runs in.
export const WORKFLOW_ID_ATTRIBUTE = 'canyonos.workflow.id';
export const WORKFLOW_GROUP_ID_ATTRIBUTE = 'canyonos.workflow_group.id';

export const GEN_AI = {
  AGENT_ID: 'gen_ai.agent.id',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  CACHE_READ_INPUT_TOKENS: 'gen_ai.usage.cache_read.input_tokens',
  USAGE_COST: 'gen_ai.usage.cost',
} as const;

export const RUNTIME_ATTRIBUTES = {
  TOKEN_COST: 'token_cost',
  SERVER_COST: 'server_cost',
  ERROR_COUNT: 'error_count',
  CPU_PERCENT: 'cpu',
  PROMPT_NAME: 'prompt_name',
  PROMPT_VERSION: 'prompt_version',
} as const;
