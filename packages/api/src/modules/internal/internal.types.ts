import { z } from 'zod';

import { FileComponentKindSchema } from '../projects/projects.types';

// Served over HTTP to the agent runtime in the separate repo — a cross-repo contract, so
// don't change this shape without checking that side.
export const RuntimeFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  component_kind: FileComponentKindSchema,
});

export const RuntimeFilesSchema = z.array(RuntimeFileSchema);

export const DeploymentManifestFileSchema = RuntimeFileSchema.extend({
  byte_size: z.number().int().nonnegative(),
});

export const DeploymentManifestSchema = z.array(DeploymentManifestFileSchema);

export type RuntimeFile = z.infer<typeof RuntimeFileSchema>;
export type DeploymentManifestFile = z.infer<typeof DeploymentManifestFileSchema>;
