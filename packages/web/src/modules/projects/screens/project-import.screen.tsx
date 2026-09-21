import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BotIcon, FolderUpIcon, PlusIcon, UploadCloudIcon, WorkflowIcon } from 'lucide-react';
import { useRef, useState } from 'react';

import { languageForPath } from '@cc-forge/api/projects';
import type {
  CreateProjectResult,
  FileComponentKind,
  ProjectSummary,
} from '@cc-forge/api/projects';

import { CodeEditor } from '@repo/ui/components/editor';
import { Notice, NoticeCode } from '@repo/ui/components/notice';
import { Button } from '@repo/ui/shadcn/button';
import { Input } from '@repo/ui/shadcn/input';
import { cn } from '@repo/ui/utils';
import { apiCall, forgeAuthApi } from '@/api';
import { HeaderDockPortal } from '@/modules/core/navigation/header-dock';
import {
  ImportSourceTabs,
  PlannedSourcePanel,
} from '@/modules/projects/components/project-import-sources';
import {
  countComponents,
  describeSkipped,
  findEnvFiles,
  READABLE_EXTENSIONS,
  toFileRows,
  TOTAL_SIZE_LIMIT_LABEL,
} from '@/modules/projects/projects.import-summary';
import { projectQueryKeys } from '@/modules/projects/projects.query-cache';
import {
  parseDataTransfer,
  parseFolder,
  parseSingleFile,
  parseZip,
} from '@/modules/projects/projects.upload';
import type { ImportSource } from '@/modules/projects/components/project-import-sources';
import type { ParsedUpload } from '@/modules/projects/projects.upload';

// `classify_component` reads a filename only, so `other` gets no pill rather than a made-up label.
const KIND_PILL: Partial<Record<FileComponentKind, string>> = {
  workflow: 'bg-accent text-accent-foreground',
  agent: 'bg-secondary text-secondary-foreground',
};

const MAX_LISTED_ENV_PATHS = 4;

export function ProjectImportScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [source, setSource] = useState<ImportSource>('upload');
  const [parsed, setParsed] = useState<ParsedUpload | null>(null);
  const [reading, setReading] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const folderRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);
  const langgraphRef = useRef<HTMLInputElement>(null);
  const adkRef = useRef<HTMLInputElement>(null);
  // A read that resolves after Start over or a source switch must not resurrect the summary.
  const readToken = useRef(0);

  const setFolderInput = (node: HTMLInputElement | null) => {
    folderRef.current = node;
    if (node) {
      node.setAttribute('webkitdirectory', '');
      node.setAttribute('directory', '');
    }
  };

  const load = async (run: () => Promise<ParsedUpload>) => {
    const token = ++readToken.current;
    setError(null);
    setReading(true);
    try {
      const upload = await run();
      if (token !== readToken.current) return;
      setParsed(upload);
      setName(upload.name);
      setSelected(upload.files[0]?.path ?? null);
    } catch (err) {
      if (token !== readToken.current) return;
      setParsed(null);
      setError(err instanceof Error ? err.message : 'Could not read the upload.');
    } finally {
      if (token === readToken.current) setReading(false);
    }
  };

  const reset = () => {
    readToken.current += 1;
    setParsed(null);
    setReading(false);
    setName('');
    setSelected(null);
    setError(null);
    for (const input of [folderRef, zipRef, langgraphRef, adkRef]) {
      if (input.current) input.current.value = '';
    }
  };

  const mutation = useMutation({
    mutationFn: (upload: ParsedUpload) =>
      apiCall<CreateProjectResult>(() =>
        forgeAuthApi.projects.post({ name: name.trim() || upload.name, files: upload.files })
      ),
    onSuccess: (result) => {
      queryClient.setQueryData(projectQueryKeys.detail(result.project.id), result.project);
      queryClient.setQueryData(projectQueryKeys.workflows(result.project.id), result.workflows);
      for (const workflow of result.workflows) {
        queryClient.setQueryData(
          projectQueryKeys.workflow(result.project.id, workflow.id),
          workflow
        );
      }
      queryClient.setQueryData<ProjectSummary[]>(projectQueryKeys.all, (projects = []) => [
        ...projects.filter((project) => project.id !== result.project.id),
        result.project,
      ]);

      // A new project goes straight to its scaling policy: uploading it is the first step of a
      // deploy, not an end in itself, and the design is one click away in the sidebar. This is why
      // the import-landing selector is gone — nothing chooses a workflow to land on any more.
      void navigate({
        to: '/projects/$project_id/deploy',
        params: { project_id: result.project.id },
      });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Upload failed.'),
  });

  return (
    <main className="flex min-h-0 flex-1 flex-col px-7 pt-6 pb-8" data-testid="project-import">
      <div className="mx-auto flex min-h-0 w-full max-w-[52.5rem] flex-1 flex-col gap-5">
        <header className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-[1.75rem] leading-tight font-bold tracking-tight">
            Import a project
          </h1>
          <p className="text-muted-foreground max-w-[56ch] text-[0.90625rem] leading-relaxed">
            Point Canyon Code at your source and we&apos;ll map the workflows and agents inside it.
          </p>
        </header>

        <EnvFileNotice upload={parsed} />

        {/* Once an upload is parsed the source choice is settled; Start over restores the tabs. */}
        {parsed ? null : (
          <ImportSourceTabs
            value={source}
            onChange={(next) => {
              // A failed or in-flight read belongs to the source it started from.
              reset();
              setSource(next);
            }}
          />
        )}

        {/* Hidden native inputs, driven by the dropzone buttons. */}
        <input
          ref={setFolderInput}
          type="file"
          multiple
          aria-label="Project folder"
          className="hidden"
          data-testid="project-import-folder-input"
          onChange={(e) => e.target.files && void load(() => parseFolder(e.target.files!))}
        />
        <input
          ref={zipRef}
          type="file"
          accept=".zip"
          aria-label="Project .zip archive"
          className="hidden"
          data-testid="project-import-zip-input"
          onChange={(e) => e.target.files?.[0] && void load(() => parseZip(e.target.files![0]!))}
        />
        {/* A single workflow file is a project of one — same reader, narrower file filter. */}
        <input
          ref={langgraphRef}
          type="file"
          accept=".py"
          aria-label="LangGraph workflow file"
          className="hidden"
          data-testid="project-import-langgraph-input"
          onChange={(e) =>
            e.target.files?.[0] && void load(() => parseSingleFile(e.target.files![0]!))
          }
        />
        <input
          ref={adkRef}
          type="file"
          accept=".py,.yaml,.yml,.json"
          aria-label="Google ADK workflow file"
          className="hidden"
          data-testid="project-import-adk-input"
          onChange={(e) =>
            e.target.files?.[0] && void load(() => parseSingleFile(e.target.files![0]!))
          }
        />

        {source !== 'upload' ? (
          <PlannedSourcePanel source={source} />
        ) : parsed ? (
          <ImportSummary
            parsed={parsed}
            name={name}
            onNameChange={setName}
            selected={selected}
            onSelect={setSelected}
            onStartOver={reset}
            onCreate={() => mutation.mutate(parsed)}
            creating={mutation.isPending}
            error={error}
          />
        ) : (
          <ImportDropzone
            reading={reading}
            error={error}
            onDrop={(transfer) => void load(() => parseDataTransfer(transfer))}
            onChooseFolder={() => folderRef.current?.click()}
            onChooseZip={() => zipRef.current?.click()}
            onChooseLangGraph={() => langgraphRef.current?.click()}
            onChooseAdk={() => adkRef.current?.click()}
          />
        )}
      </div>
    </main>
  );
}

function EnvFileNotice({ upload }: { readonly upload: ParsedUpload | null }) {
  const paths = upload ? findEnvFiles(upload.files) : [];
  if (paths.length === 0) return null;

  const visible = paths.slice(0, MAX_LISTED_ENV_PATHS);
  const hidden = paths.length - visible.length;

  return (
    <Notice
      title={
        paths.length === 1
          ? 'This upload contains an environment file'
          : `This upload contains ${paths.length} environment files`
      }
      data-testid="project-import-env-warning"
    >
      <p>
        Environment files are stored as plain project files. Anyone with access to this project can
        read them. Start over and remove them if they hold live credentials.
      </p>
      <span className="flex flex-wrap items-center gap-1.5">
        {visible.map((path) => (
          <NoticeCode key={path}>{path}</NoticeCode>
        ))}
        {hidden === 0 ? null : (
          <span className="text-xs" title={paths.slice(MAX_LISTED_ENV_PATHS).join('\n')}>
            +{hidden} more
          </span>
        )}
      </span>
    </Notice>
  );
}

function ImportSummary({
  parsed,
  name,
  onNameChange,
  selected,
  onSelect,
  onStartOver,
  onCreate,
  creating,
  error,
}: {
  readonly parsed: ParsedUpload;
  readonly name: string;
  readonly onNameChange: (name: string) => void;
  readonly selected: string | null;
  readonly onSelect: (path: string) => void;
  readonly onStartOver: () => void;
  readonly onCreate: () => void;
  readonly creating: boolean;
  readonly error: string | null;
}) {
  const rows = toFileRows(parsed.files);
  const counts = countComponents(parsed.files);
  const skipped = describeSkipped(parsed);
  const selectedFile = parsed.files.find((file) => file.path === selected);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="border-border bg-card flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border shadow-xs">
        {/* Start over and Create project dock into the app header, where every other primary
            action lives. The name field stays with the upload it names. */}
        <HeaderDockPortal>
          <Button variant="outline" size="sm" onClick={onStartOver}>
            Start over
          </Button>
          <Button
            size="sm"
            disabled={creating || name.trim().length === 0}
            data-testid="project-import-submit"
            onClick={onCreate}
          >
            <PlusIcon aria-hidden />
            {creating ? 'Creating…' : 'Create project'}
          </Button>
        </HeaderDockPortal>

        <div className="border-border bg-primary/20 flex shrink-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b px-5 py-3.5">
          <label htmlFor="project-import-name" className="flex min-w-0 flex-1 flex-col gap-1.5">
            {/* On the green bar, muted grey falls under contrast minimums — the on-green
                foreground token is what keeps this readable in both themes. */}
            <span className="text-accent-foreground text-xs font-semibold tracking-wide uppercase">
              Project name
            </span>
            <Input
              id="project-import-name"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              className="border-primary/40 h-9 max-w-sm"
              data-testid="project-import-name"
            />
            <span className="text-accent-foreground text-xs">
              Nothing is stored until you create the project.
            </span>
          </label>
        </div>

        <div className="border-border flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-5 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5">
            <span className="text-foreground truncate font-mono text-sm font-semibold">
              {parsed.name}/
            </span>
            <span
              className="text-muted-foreground text-[0.78125rem]"
              data-testid="project-import-read-summary"
              // Only the skipped paths need a hover reveal; the read count is already visible.
              title={
                skipped
                  ? parsed.skipped.map((s) => `${s.path} (${s.reason})`).join('\n')
                  : undefined
              }
            >
              {counts.files} {counts.files === 1 ? 'file' : 'files'} read
              {skipped ? ` · ${skipped}` : ''}
            </span>
          </div>
          <dl className="flex shrink-0 items-start gap-6">
            <ImportCount label="Workflows" value={counts.workflows} />
            <ImportCount label="Agents" value={counts.agents} />
          </dl>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          <ul
            className="border-border scroll-area min-h-0 overflow-y-auto py-2 lg:border-r"
            data-testid="project-import-files"
          >
            {rows.map((row) => (
              <li key={row.path}>
                <button
                  type="button"
                  aria-label={row.path}
                  aria-current={selected === row.path ? 'true' : undefined}
                  onClick={() => onSelect(row.path)}
                  style={{ paddingLeft: `${0.875 + row.depth * 0.75}rem` }}
                  className={cn(
                    'flex w-full items-center gap-2 py-1 pr-3 text-left font-mono text-[0.75rem] transition-colors',
                    selected === row.path
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/50'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  {KIND_PILL[row.kind] ? (
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 font-sans text-[0.625rem] font-semibold tracking-wide uppercase',
                        KIND_PILL[row.kind]
                      )}
                    >
                      {row.kind}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>

          <div className="min-h-0 overflow-hidden max-lg:hidden">
            {selectedFile ? (
              <CodeEditor
                key={selectedFile.path}
                value={selectedFile.content}
                language={languageForPath(selectedFile.path)}
                ariaLabel={`${selectedFile.path} source preview`}
                readOnly
              />
            ) : null}
          </div>
        </div>
      </div>

      {error ? (
        <p className="text-destructive shrink-0 text-sm" data-testid="project-import-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ImportDropzone({
  reading,
  error,
  onDrop,
  onChooseFolder,
  onChooseZip,
  onChooseLangGraph,
  onChooseAdk,
}: {
  readonly reading: boolean;
  readonly error: string | null;
  readonly onDrop: (transfer: DataTransfer) => void;
  readonly onChooseFolder: () => void;
  readonly onChooseZip: () => void;
  readonly onChooseLangGraph: () => void;
  readonly onChooseAdk: () => void;
}) {
  const [dragging, setDragging] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        data-testid="project-import-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!reading) onDrop(e.dataTransfer);
        }}
        className={cn(
          'ease-snappy flex max-h-[22rem] min-h-[11rem] flex-1 flex-col items-center justify-center gap-3.5 rounded-2xl border-[1.5px] border-dashed p-8 text-center transition-colors duration-150',
          dragging ? 'border-primary bg-accent' : 'border-border bg-muted'
        )}
      >
        <span className="bg-accent text-accent-foreground flex size-11 items-center justify-center rounded-xl">
          <UploadCloudIcon className="size-[1.375rem]" strokeWidth={1.8} />
        </span>
        <span className="flex flex-col gap-1">
          <span className="text-foreground text-[0.9375rem] font-semibold">
            {reading ? 'Reading your project…' : 'Drop your project here'}
          </span>
          <span className="text-muted-foreground text-[0.8125rem]">
            Read in your browser — nothing is uploaded until you create the project.
          </span>
        </span>
        <div className="mt-0.5 flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={reading}
            aria-label="Choose project folder"
            onClick={onChooseFolder}
          >
            <FolderUpIcon /> Choose folder
          </Button>
          <Button variant="outline" size="sm" disabled={reading} onClick={onChooseZip}>
            <UploadCloudIcon /> Choose .zip
          </Button>
          <Button variant="outline" size="sm" disabled={reading} onClick={onChooseLangGraph}>
            <WorkflowIcon /> LangGraph workflow
          </Button>
          <Button variant="outline" size="sm" disabled={reading} onClick={onChooseAdk}>
            <BotIcon /> Google ADK workflow
          </Button>
        </div>
        {error ? (
          <p className="text-destructive text-sm" data-testid="project-import-error">
            {error}
          </p>
        ) : null}
      </div>

      <div className="text-muted-foreground flex shrink-0 flex-wrap gap-x-5 gap-y-1 text-xs">
        <span>
          Reads <span className="font-mono">{READABLE_EXTENSIONS}</span>
        </span>
        <span>{TOTAL_SIZE_LIMIT_LABEL}</span>
        <span>Needs at least one .py file with &ldquo;workflow&rdquo; in its name</span>
      </div>
    </div>
  );
}

function ImportCount({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <dd className="text-foreground text-lg leading-none font-semibold tabular-nums">{value}</dd>
      <dt className="text-muted-foreground text-[0.6875rem] tracking-wide uppercase">{label}</dt>
    </div>
  );
}
