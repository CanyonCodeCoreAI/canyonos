// The receiver writes OTLP/JSON, which spells this enum as the proto's own value names.
export const STATUS_CODE = {
  UNSET: 'STATUS_CODE_UNSET',
  OK: 'STATUS_CODE_OK',
  ERROR: 'STATUS_CODE_ERROR',
} as const;

export const PROJECT_ID_ATTRIBUTE = 'canyon.project.id';

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
} as const;
