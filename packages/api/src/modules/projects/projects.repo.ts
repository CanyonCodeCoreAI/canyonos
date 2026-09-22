import { and, eq, sql } from 'drizzle-orm';

import { db } from '@api/db/client';
import { deployments, fileBlobs, files, projects, projectWorkflows, users } from '@api/db/schema';
import { internalError } from '@core/errors';

import type {
  CreateProjectResult,
  FileComponentKind,
  FileMeta,
  ProjectSummary,
} from './projects.types';

export interface ProjectComponentCounts {
  readonly file_count: number;
  readonly agent_count: number;
  readonly tool_count: number;
}

/** A persist-ready file: bytes already stored in the blob provider, addressed by `content_hash`. */
export interface PersistFile {
  readonly path: string;
  readonly name: string;
  readonly content_hash: string;
  readonly language: string;
  readonly byte_size: number;
  readonly component_kind: FileComponentKind;
}

export interface FileRecord {
  readonly id: string;
  readonly project_id: string | null;
  readonly path: string;
  readonly name: string;
  readonly language: string;
  readonly content_hash: string;
  readonly byte_size: number;
  readonly component_kind: FileComponentKind;
  readonly updated_at: string;
}

export interface FileMutationResult {
  readonly file: FileRecord;
  readonly workflow_ids: readonly string[];
}

/** A project file as the deploy manifest records it: path plus the content-addressed hash. */
export interface ProjectDeployFile {
  readonly path: string;
  readonly content_hash: string;
  readonly byte_size: number;
  readonly component_kind: FileComponentKind;
}

const FILE_RECORD_COLUMNS = {
  id: files.id,
  project_id: files.project_id,
  path: files.path,
  name: files.name,
  language: files.language,
  content_hash: files.content_hash,
  byte_size: files.byte_size,
  component_kind: files.component_kind,
  updated_at: files.updated_at,
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type BlobRef = { readonly content_hash: string; readonly byte_size: number };

// Register referenced blobs before the FK insert, deduped, ignoring ones already present.
async function register_blobs(tx: Tx, blobs: readonly BlobRef[]): Promise<void> {
  const deduped = [
    ...new Map(
      blobs.map((blob) => [
        blob.content_hash,
        { content_hash: blob.content_hash, byte_size: blob.byte_size },
      ])
    ).values(),
  ];
  if (deduped.length > 0) await tx.insert(fileBlobs).values(deduped).onConflictDoNothing();
}

export const projects_repo = {
  async create_with_files(
    company_id: string,
    created_by: string,
    project: { name: string },
    file_rows: readonly PersistFile[]
  ): Promise<CreateProjectResult> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .insert(projects)
        .values({ company_id, created_by, name: project.name })
        .returning({
          id: projects.id,
          name: projects.name,
          created_at: projects.created_at,
          updated_at: projects.updated_at,
        });
      if (!row) throw internalError('projects.persist_failed', 'Failed to create project');

      await register_blobs(tx, file_rows);
      const inserted_files = await tx
        .insert(files)
        .values(
          file_rows.map((file) => ({
            company_id,
            project_id: row.id,
            created_by,
            path: file.path,
            name: file.name,
            content_hash: file.content_hash,
            language: file.language,
            byte_size: file.byte_size,
            component_kind: file.component_kind,
          }))
        )
        .returning({
          id: files.id,
          project_id: files.project_id,
          path: files.path,
          component_kind: files.component_kind,
        });

      const workflow_sources = inserted_files.filter(
        (file) => file.component_kind === 'workflow' && file.project_id === row.id
      );
      const workflow_rows =
        workflow_sources.length === 0
          ? []
          : await tx
              .insert(projectWorkflows)
              .values(
                workflow_sources.map((source) => ({
                  project_id: row.id,
                  source_file_id: source.id,
                  generation_status: 'PENDING',
                }))
              )
              .returning({
                id: projectWorkflows.id,
                project_id: projectWorkflows.project_id,
                source_file_id: projectWorkflows.source_file_id,
                updated_at: projectWorkflows.updated_at,
              });
      const source_paths = new Map(workflow_sources.map((source) => [source.id, source.path]));

      return {
        project: { ...row, file_count: file_rows.length },
        workflows: workflow_rows.map((workflow) => ({
          ...workflow,
          source_path: source_paths.get(workflow.source_file_id)!,
          status: 'PENDING' as const,
        })),
      };
    });
  },

  async list_with_counts(): Promise<ProjectSummary[]> {
    return db
      .select({
        id: projects.id,
        name: projects.name,
        created_at: projects.created_at,
        updated_at: projects.updated_at,
        file_count: sql<number>`count(${files.id})::int`,
      })
      .from(projects)
      .leftJoin(files, eq(files.project_id, projects.id))
      .groupBy(projects.id)
      .orderBy(projects.created_at);
  },

  async get_with_count(project_id: string): Promise<ProjectSummary | undefined> {
    const [row] = await db
      .select({
        id: projects.id,
        name: projects.name,
        created_at: projects.created_at,
        updated_at: projects.updated_at,
        file_count: sql<number>`count(${files.id})::int`,
      })
      .from(projects)
      .leftJoin(files, eq(files.project_id, projects.id))
      .where(eq(projects.id, project_id))
      .groupBy(projects.id)
      .limit(1);
    return row;
  },

  async find_company_for_user(user_id: string): Promise<string | undefined> {
    const [row] = await db
      .select({ company_id: users.companyId })
      .from(users)
      .where(eq(users.id, user_id))
      .limit(1);
    return row?.company_id ?? undefined;
  },

  async find_project_company(project_id: string): Promise<string | undefined> {
    const [row] = await db
      .select({ company_id: projects.company_id })
      .from(projects)
      .where(eq(projects.id, project_id))
      .limit(1);
    return row?.company_id;
  },

  async list_files(project_id: string): Promise<FileMeta[]> {
    return db
      .select({
        id: files.id,
        path: files.path,
        name: files.name,
        language: files.language,
        byte_size: files.byte_size,
        component_kind: files.component_kind,
        updated_at: files.updated_at,
      })
      .from(files)
      .where(eq(files.project_id, project_id))
      .orderBy(files.path);
  },

  async get_file(project_id: string, file_id: string): Promise<FileRecord | undefined> {
    const [row] = await db
      .select(FILE_RECORD_COLUMNS)
      .from(files)
      .where(and(eq(files.id, file_id), eq(files.project_id, project_id)))
      .limit(1);
    return row;
  },

  async update_file_content(
    project_id: string,
    file_id: string,
    content_hash: string,
    byte_size: number
  ): Promise<FileMutationResult | undefined> {
    return db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await register_blobs(tx, [{ content_hash, byte_size }]);
      const [file] = await tx
        .update(files)
        .set({ content_hash, byte_size, updated_at: now })
        .where(and(eq(files.id, file_id), eq(files.project_id, project_id)))
        .returning(FILE_RECORD_COLUMNS);
      if (!file) return undefined;

      await tx.update(projects).set({ updated_at: now }).where(eq(projects.id, project_id));
      const workflows = await tx
        .update(projectWorkflows)
        .set({ stale_at: sql`now()` })
        .where(eq(projectWorkflows.project_id, project_id))
        .returning({ workflow_id: projectWorkflows.id });

      return { file, workflow_ids: workflows.map(({ workflow_id }) => workflow_id) };
    });
  },

  async delete_file_and_mark_workflows_stale(
    project_id: string,
    file_id: string
  ): Promise<readonly string[] | undefined> {
    return db.transaction(async (tx) => {
      const deleted = await tx
        .delete(files)
        .where(and(eq(files.id, file_id), eq(files.project_id, project_id)))
        .returning({ id: files.id });
      if (deleted.length === 0) return undefined;

      const now = new Date().toISOString();
      await tx.update(projects).set({ updated_at: now }).where(eq(projects.id, project_id));
      const workflows = await tx
        .update(projectWorkflows)
        .set({ stale_at: sql`now()` })
        .where(eq(projectWorkflows.project_id, project_id))
        .returning({ workflow_id: projectWorkflows.id });
      return workflows.map(({ workflow_id }) => workflow_id);
    });
  },

  // Files and project_workflows cascade from projects. Deployments deliberately retain their
  // foreign keys, so remove every non-cascading child first inside this transaction.
  async delete_project(project_id: string): Promise<string | undefined> {
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, project_id))
        .limit(1)
        .for('update');
      if (!existing) return undefined;

      await tx.delete(deployments).where(eq(deployments.project_id, project_id));
      await tx.delete(projects).where(eq(projects.id, project_id));
      return existing.id;
    });
  },

  async get_component_counts(project_id: string): Promise<ProjectComponentCounts | undefined> {
    const [row] = await db
      .select({
        file_count: sql<number>`count(${files.id})::int`,
        agent_count: sql<number>`count(*) filter (where ${files.component_kind} = 'agent')::int`,
        tool_count: sql<number>`count(*) filter (where ${files.component_kind} = 'tool')::int`,
      })
      .from(projects)
      .leftJoin(files, eq(files.project_id, projects.id))
      .where(eq(projects.id, project_id))
      .groupBy(projects.id)
      .limit(1);
    return row;
  },

  async get_deploy_files(project_id: string): Promise<ProjectDeployFile[]> {
    return db
      .select({
        path: files.path,
        content_hash: files.content_hash,
        byte_size: files.byte_size,
        component_kind: files.component_kind,
      })
      .from(files)
      .where(eq(files.project_id, project_id))
      .orderBy(files.path);
  },

  // The runtime's file source: the content-addressed rows the internal endpoint reconstructs.
  async list_project_file_blobs(
    project_id: string
  ): Promise<{ path: string; content_hash: string; component_kind: FileComponentKind }[]> {
    return db
      .select({
        path: files.path,
        content_hash: files.content_hash,
        component_kind: files.component_kind,
      })
      .from(files)
      .where(eq(files.project_id, project_id))
      .orderBy(files.path);
  },

  async get_generation_input(
    project_id: string,
    workflow_id: string,
    source_file_id: string
  ): Promise<
    | { name: string; source_path: string; files: { path: string; content_hash: string }[] }
    | undefined
  > {
    const [source] = await db
      .select({ name: projects.name, source_path: files.path })
      .from(projectWorkflows)
      .innerJoin(projects, eq(projectWorkflows.project_id, projects.id))
      .innerJoin(files, eq(projectWorkflows.source_file_id, files.id))
      .where(
        and(
          eq(projectWorkflows.project_id, project_id),
          eq(projectWorkflows.id, workflow_id),
          eq(projectWorkflows.source_file_id, source_file_id),
          eq(files.project_id, project_id),
          eq(files.component_kind, 'workflow')
        )
      )
      .limit(1);
    if (!source) return undefined;

    const rows = await db
      .select({ path: files.path, content_hash: files.content_hash })
      .from(files)
      .where(eq(files.project_id, project_id))
      .orderBy(files.path);
    rows.sort((left, right) => {
      if (left.path === source.source_path) return -1;
      if (right.path === source.source_path) return 1;
      return left.path.localeCompare(right.path);
    });
    return { name: source.name, source_path: source.source_path, files: rows };
  },
};
