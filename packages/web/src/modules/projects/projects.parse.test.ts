import { describe, expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';

import { MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES } from '@canyonos/api/projects';

import { parseSingleFile, parseZip } from './projects.upload';

function zipFile(entries: Record<string, Uint8Array>, name = 'upload.zip'): File {
  return new File([zipSync(entries)], name, { type: 'application/zip' });
}

describe('parseZip / buildUpload', () => {
  test('strips a single shared wrapper folder and adopts its name', async () => {
    const parsed = await parseZip(
      zipFile({
        'myflow/workflow.py': strToU8('def run(): pass\n'),
        'myflow/agents/router.agent.py': strToU8('# router\n'),
      })
    );
    expect(parsed.name).toBe('myflow');
    expect(parsed.files.map((f) => f.path).toSorted()).toEqual([
      'agents/router.agent.py',
      'workflow.py',
    ]);
  });

  test('keeps paths intact when a top-level file prevents a shared wrapper', async () => {
    const parsed = await parseZip(
      zipFile(
        {
          'workflow.py': strToU8('x\n'),
          'agents/router.agent.py': strToU8('y\n'),
        },
        'demo.zip'
      )
    );
    expect(parsed.name).toBe('demo'); // falls back to the archive name, no wrapper stripped
    expect(parsed.files.map((f) => f.path).toSorted()).toEqual([
      'agents/router.agent.py',
      'workflow.py',
    ]);
  });

  test('drops generated directories silently (not reported as skipped)', async () => {
    const parsed = await parseZip(
      zipFile({
        'flow/workflow.py': strToU8('x\n'),
        'flow/__pycache__/workflow.cpython.pyc': strToU8('generated\n'),
        '__MACOSX/flow/._workflow.py': strToU8('generated\n'),
        'flow/.git/config': strToU8('generated\n'),
      })
    );
    expect(parsed.files.map((f) => f.path)).toEqual(['workflow.py']);
    expect(parsed.skipped).toHaveLength(0);
  });

  test('reads every env file variant', async () => {
    const parsed = await parseZip(
      zipFile({
        'flow/workflow.py': strToU8('x\n'),
        'flow/.env': strToU8('OPENAI_API_KEY=sk-test\n'),
        'flow/.env.production': strToU8('OPENAI_API_KEY=sk-prod\n'),
        'flow/service/.env.local': strToU8('DB_URL=postgres://local\n'),
      })
    );

    expect(parsed.files.map((f) => f.path).toSorted()).toEqual([
      '.env',
      '.env.production',
      'service/.env.local',
      'workflow.py',
    ]);
    expect(parsed.files.find((f) => f.path === '.env')?.content).toBe('OPENAI_API_KEY=sk-test\n');
    expect(parsed.skipped).toHaveLength(0);
  });

  test('reads a dotfile with a supported extension and reports the rest as skipped', async () => {
    const parsed = await parseZip(
      zipFile({
        'flow/workflow.py': strToU8('x\n'),
        'flow/.github/workflows/ci.yaml': strToU8('name: ci\n'),
        'flow/.gitignore': strToU8('dist\n'),
      })
    );

    expect(parsed.files.map((f) => f.path).toSorted()).toEqual([
      '.github/workflows/ci.yaml',
      'workflow.py',
    ]);
    expect(parsed.skipped).toEqual([{ path: 'flow/.gitignore', reason: 'unsupported' }]);
  });

  test('drops supported files that live inside a generated directory', async () => {
    const parsed = await parseZip(
      zipFile({
        'flow/workflow.py': strToU8('x\n'),
        'flow/node_modules/pkg/package.json': strToU8('{}\n'),
        'flow/.venv/lib/mod.py': strToU8('# dep\n'),
        'flow/.git/.env': strToU8('repo internals\n'),
      })
    );

    expect(parsed.files.map((f) => f.path)).toEqual(['workflow.py']);
    expect(parsed.skipped).toHaveLength(0);
  });

  test('reports unsupported extensions and non-UTF-8 files as skipped', async () => {
    const parsed = await parseZip(
      zipFile({
        'flow/workflow.py': strToU8('x\n'),
        'flow/logo.png': strToU8('not really a png\n'),
        'flow/bad.py': new Uint8Array([0xff, 0xfe, 0xfd]), // invalid UTF-8
      })
    );
    expect(parsed.files.map((f) => f.path)).toEqual(['workflow.py']);
    const reasonFor = (suffix: string) =>
      parsed.skipped.find((s) => s.path.endsWith(suffix))?.reason;
    expect(reasonFor('logo.png')).toBe('unsupported');
    expect(reasonFor('bad.py')).toBe('binary');
  });

  test('throws when no supported source files remain', async () => {
    let message: string | undefined;
    try {
      await parseZip(zipFile({ 'flow/logo.png': strToU8('x\n') }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/No supported source files/);
  });

  const errorMessageOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('Expected the upload to be rejected, but it resolved.');
  };

  test('rejects a file exceeding the per-file byte cap', async () => {
    const oversized = strToU8('#'.repeat(MAX_FILE_BYTES + 1));
    const message = await errorMessageOf(() => parseZip(zipFile({ 'flow/big.py': oversized })));
    expect(message).toMatch(/per-file limit/);
  });

  test('rejects when the file count exceeds the cap', async () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MAX_FILES; i += 1) entries[`flow/f${i}.py`] = strToU8('x\n');
    const message = await errorMessageOf(() => parseZip(zipFile(entries)));
    expect(message).toMatch(/Too many files/);
  });

  test('rejects when cumulative size exceeds the total cap', async () => {
    // Each file is under the per-file cap, but together they cross MAX_TOTAL_BYTES.
    const perFile = MAX_FILE_BYTES - 1;
    const chunk = strToU8('#'.repeat(perFile));
    const count = Math.ceil(MAX_TOTAL_BYTES / perFile) + 1;
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < count; i += 1) entries[`flow/f${i}.py`] = chunk;
    const message = await errorMessageOf(() => parseZip(zipFile(entries)));
    expect(message).toMatch(/exceeds the .* MB limit/);
  });

  test('rejects an oversized archive before buffering/decompressing it', async () => {
    // Not a valid ZIP: if the raw-size guard did not fire first, unzipSync would throw a different
    // error. Matching the MB-limit message proves rejection happens before arrayBuffer()/unzipSync.
    const bytes = new Uint8Array(MAX_TOTAL_BYTES + 1);
    const oversizedArchive = new File([bytes], 'huge.zip', { type: 'application/zip' });
    const message = await errorMessageOf(() => parseZip(oversizedArchive));
    expect(message).toMatch(/exceeds the .* MB limit/);
  });
});

describe('parseSingleFile', () => {
  test('names the project after the file, without its extension', async () => {
    const parsed = await parseSingleFile(
      new File(['def run(): pass\n'], 'portfolio_workflow.py', { type: 'text/x-python' })
    );

    expect(parsed.name).toBe('portfolio_workflow');
    expect(parsed.files).toEqual([{ path: 'portfolio_workflow.py', content: 'def run(): pass\n' }]);
    expect(parsed.skipped).toEqual([]);
  });

  test('rejects a file the API would not admit', async () => {
    // The picker's accept filter is a hint, not a guarantee — a drag or a Finder override can still
    // hand over anything, so the same allow-list has to reject it here.
    let message: string | undefined;
    try {
      await parseSingleFile(
        new File(['binary'], 'model.bin', { type: 'application/octet-stream' })
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/No supported source files/);
  });
});
