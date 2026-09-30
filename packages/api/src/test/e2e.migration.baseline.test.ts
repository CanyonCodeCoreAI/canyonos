import { describe, expect, test } from 'bun:test';

import { sql as postgres } from '@api/db/client';

import { setupE2ETests } from './e2e.setup';

setupE2ETests();

const LEGACY_TABLES = ['agent_information', 'runtime_information', 'session'];

// Neither drizzle-kit nor the schema can express these, so they live in a custom migration and only
// this test proves the baseline still ships them.
const FUNCTIONS = [
  'enforce_project_workflow_source_kind',
  'notify_deploy_event',
  'notify_deploy_job',
  'prevent_backing_file_reclassification',
];

const TRIGGERS = [
  ['deployment_events', 'deployment_events_notify'],
  ['deployments', 'deployments_notify_job'],
  ['deployments', 'deployments_notify_stop'],
  ['files', 'files_workflow_source_invariant_trigger'],
  ['project_workflows', 'project_workflows_source_kind_trigger'],
];

// The statuses that hold a project's only deploy slot.
const ACTIVE_STATUSES = [
  'pending',
  'receiving_files',
  'processing_files',
  'provisioning_resources',
  'launching_resources',
];

interface IndexRow {
  readonly name: string;
  readonly is_unique: boolean;
  readonly predicate: string | null;
  readonly columns: readonly string[];
}

const deployment_indexes = (): Promise<IndexRow[]> => postgres<IndexRow[]>`
  SELECT
    i.relname AS name,
    ix.indisunique AS is_unique,
    pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
    (
      SELECT array_agg(a.attname ORDER BY key.position)
      FROM unnest(ix.indkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = key.attnum
    ) AS columns
  FROM pg_index ix
  JOIN pg_class i ON i.oid = ix.indexrelid
  WHERE ix.indrelid = 'deployments'::regclass
  ORDER BY i.relname
`;

describe('migration baseline', () => {
  test('the legacy runtime tables and their enum are gone', async () => {
    const tables = await postgres<{ name: string }[]>`
      SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ${postgres(LEGACY_TABLES)}
    `;
    expect(tables.map((row) => row.name)).toEqual([]);

    const types = await postgres<{ typname: string }[]>`
      SELECT typname FROM pg_type WHERE typname = 'session_status'
    `;
    expect(types.map((row) => row.typname)).toEqual([]);
  });

  test('the workflow and deploy functions survive the baseline', async () => {
    const functions = await postgres<{ proname: string }[]>`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ${postgres(FUNCTIONS)}
      ORDER BY p.proname
    `;
    expect(functions.map((row) => row.proname)).toEqual(FUNCTIONS);
  });

  test('the schema carries exactly the expected triggers', async () => {
    const triggers = await postgres<{ table_name: string; tgname: string }[]>`
      SELECT c.relname AS table_name, t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
      ORDER BY c.relname, t.tgname
    `;
    expect(triggers.map((row) => [row.table_name, row.tgname])).toEqual(TRIGGERS);
  });

  test('the deploy indexes keep their partial predicates', async () => {
    const indexes = await deployment_indexes();
    const by_name = new Map(indexes.map((row) => [row.name, row]));

    const guard = by_name.get('uq_deployments_active_per_project');
    expect(guard?.is_unique).toBe(true);
    expect(guard?.columns).toEqual(['project_id']);
    for (const status of ACTIVE_STATUSES) expect(guard?.predicate).toContain(`'${status}'`);
    expect(guard?.predicate).not.toContain(`'stopped'`);
    expect(guard?.predicate).not.toContain(`'stopping'`);

    const pending = by_name.get('idx_deployments_pending');
    expect(pending?.columns).toEqual(['created_at']);
    expect(pending?.predicate).toContain(`'pending'`);

    const status_updated = by_name.get('idx_deployments_status_updated');
    expect(status_updated?.columns).toEqual(['status', 'updated_at']);
    expect(status_updated?.predicate).toBeNull();
  });
});
