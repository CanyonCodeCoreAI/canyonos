import { z } from 'zod';

const FLEET_LIMITS = {
  starting_cpu_instances: { min: 1, max: 10 },
  starting_gpu_instances: { min: 0, max: 2 },
  max_cpu_instances: { min: 1, max: 20 },
  max_gpu_instances: { min: 0, max: 4 },
} as const;

type FleetField = keyof typeof FLEET_LIMITS;

const fleetCount = (field: FleetField, min_message: string, max_message: string) =>
  z
    .number({ invalid_type_error: 'Enter a whole number.' })
    .int('Use a whole number.')
    .min(FLEET_LIMITS[field].min, min_message)
    .max(FLEET_LIMITS[field].max, max_message);

const withinLimits = (field: FleetField, value: number) =>
  Number.isInteger(value) && value >= FLEET_LIMITS[field].min && value <= FLEET_LIMITS[field].max;

export const StartingConfigSchema = z
  .object({
    starting_cpu_instances: fleetCount(
      'starting_cpu_instances',
      'Start with at least 1 CPU instance.',
      'Start with at most 10 CPU instances.'
    ),
    starting_gpu_instances: fleetCount(
      'starting_gpu_instances',
      'GPU instances cannot be negative.',
      'Start with at most 2 GPU instances.'
    ),
    max_cpu_instances: fleetCount(
      'max_cpu_instances',
      'Allow at least 1 CPU instance.',
      'Allow at most 20 CPU instances.'
    ),
    max_gpu_instances: fleetCount(
      'max_gpu_instances',
      'GPU instances cannot be negative.',
      'Allow at most 4 GPU instances.'
    ),
  })
  .superRefine((values, ctx) => {
    if (
      withinLimits('starting_cpu_instances', values.starting_cpu_instances) &&
      withinLimits('max_cpu_instances', values.max_cpu_instances) &&
      values.max_cpu_instances < values.starting_cpu_instances
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_cpu_instances'],
        message: 'Max CPU must be at least the starting CPU count.',
      });
    }
    if (
      withinLimits('starting_gpu_instances', values.starting_gpu_instances) &&
      withinLimits('max_gpu_instances', values.max_gpu_instances) &&
      values.max_gpu_instances < values.starting_gpu_instances
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_gpu_instances'],
        message: 'Max GPU must be at least the starting GPU count.',
      });
    }
  });

export type StartingConfigInput = z.infer<typeof StartingConfigSchema>;

export const STARTING_CONFIG_DEFAULTS: StartingConfigInput = {
  starting_cpu_instances: 1,
  starting_gpu_instances: 0,
  max_cpu_instances: 4,
  max_gpu_instances: 1,
};

export interface StartingConfigField {
  name: FleetField;
  label: string;
  min: number;
  max: number;
}

export const STARTING_CONFIG_FIELDS: readonly StartingConfigField[] = [
  {
    name: 'starting_cpu_instances',
    label: 'Starting CPU instances',
    ...FLEET_LIMITS.starting_cpu_instances,
  },
  {
    name: 'starting_gpu_instances',
    label: 'Starting GPU instances',
    ...FLEET_LIMITS.starting_gpu_instances,
  },
  { name: 'max_cpu_instances', label: 'Max CPU instances', ...FLEET_LIMITS.max_cpu_instances },
  { name: 'max_gpu_instances', label: 'Max GPU instances', ...FLEET_LIMITS.max_gpu_instances },
];
