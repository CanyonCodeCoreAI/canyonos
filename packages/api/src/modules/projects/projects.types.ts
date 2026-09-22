import { z } from 'zod';

import { ProjectWorkflowSummarySchema } from '../workflows/workflows.types';
import { FILE_COMPONENT_KINDS, MAX_FILE_BYTES, MAX_FILES, MAX_PATH_LENGTH } from './projects.files';

const FileInputSchema = z.object({
  path: z.string().min(1).max(MAX_PATH_LENGTH),
  content: z.string().max(MAX_FILE_BYTES),
});

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  files: z.array(FileInputSchema).min(1).max(MAX_FILES),
});

export const UpdateFileSchema = z
  .object({
    content: z.string().max(MAX_FILE_BYTES),
  })
  .strict();

export const ProjectIdParams = z.object({ project_id: z.string().uuid() });
export const FileParams = z.object({
  project_id: z.string().uuid(),
  file_id: z.string().uuid(),
});

export const FileComponentKindSchema = z.enum(FILE_COMPONENT_KINDS);

export const ProjectSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  file_count: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const FileMetaSchema = z.object({
  id: z.string().uuid(),
  path: z.string(),
  name: z.string(),
  language: z.string(),
  byte_size: z.number().int().nonnegative(),
  component_kind: FileComponentKindSchema,
  updated_at: z.string(),
});

export const FileContentSchema = FileMetaSchema.extend({
  project_id: z.string().uuid().nullable(),
  content: z.string(),
});

export const CreateProjectResultSchema = z.object({
  project: ProjectSummarySchema,
  workflows: z.array(ProjectWorkflowSummarySchema),
});

export const ProjectGenerationStatusSchema = z.enum(['PENDING', 'READY', 'FAILED']);

export const ProjectStatusSchema = z.object({
  project_id: z.string().uuid(),
  status: ProjectGenerationStatusSchema,
  error_message: z.string().nullable(),
  updated_at: z.string(),
});

export const ProjectStatsSchema = z.object({
  project_id: z.string().uuid(),
  file_count: z.number().int().nonnegative(),
  workflow_count: z.number().int().nonnegative(),
  ready_workflow_count: z.number().int().nonnegative(),
  agent_count: z.number().int().nonnegative(),
  tool_count: z.number().int().nonnegative(),
});

export type { FileComponentKind } from './projects.files';

export type FileInput = z.infer<typeof FileInputSchema>;
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;
export type UpdateFileInput = z.infer<typeof UpdateFileSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type FileMeta = z.infer<typeof FileMetaSchema>;
export type FileContent = z.infer<typeof FileContentSchema>;
export type CreateProjectResult = z.infer<typeof CreateProjectResultSchema>;
export type ProjectGenerationStatus = z.infer<typeof ProjectGenerationStatusSchema>;
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
export type ProjectStats = z.infer<typeof ProjectStatsSchema>;
