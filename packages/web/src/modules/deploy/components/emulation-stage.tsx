import { useEffect, useRef, useState } from 'react';

import { cn } from '@repo/ui/utils';
import {
  createRun,
  CYCLE_SECONDS,
  EMPTY_STATE,
  fleetFromRun,
  LLM_NODE_ID,
  QUEUE_DRAWN_MAX,
  SETTLE_SECONDS,
  step,
} from '@/modules/deploy/deploy.emulation';
import { LLM_ENDPOINT_OPTIONS } from '@/modules/deploy/deploy.scaling-plan';
import { formatCompactCount, formatDurationMs } from '@/modules/projects/projects.format';
import { COST_SPLIT } from '@/modules/projects/projects.metrics';
import type {
  Dot,
  EmulationGraph,
  EmulationPolicy,
  EmulationState,
  Lane,
} from '@/modules/deploy/deploy.emulation';
import type { StartingConfigInput } from '@/modules/deploy/deploy.starting-config';

/** The pane's drawing space, in the same units the node positions are scaled into. */
const VIEW = { width: 320, height: 260 } as const;
/** Room for the node boxes and for the model block on the right of each pane. */
const PAD = { x: 82, y: 30, right: 84 } as const;

const NODE = { width: 74, height: 20 } as const;
/**
 * Outlines drawn behind a block before the count beside it carries the rest.
 *
 * A heavy policy stands hundreds of thousands of blocks, and the depth stopped saying anything long
 * before the pane ran out of room. Eight is a stack the eye still reads as a stack.
 */
const STACK_DRAWN_MAX = 8;
const DOT_RADIUS = 3.1;
/** Arriving traffic is smaller than traffic in the system: it has not been given work yet. */
const ARRIVAL_RADIUS = 2.1;
/** How far above the pane a request starts its fall, so it enters rather than appears. */
const ARRIVAL_RISE = 46;
/** The stream fans across this many pixels, so arrivals read as traffic and not as one file. */
const ARRIVAL_SPREAD = 40;

/**
 * The callers over the entry: spread wide and set at uneven heights.
 *
 * Evenly spaced figures at one height read as a row of icons rather than a crowd, so the offsets are
 * deliberately irregular and the outer ones fade — a group thinning out rather than ending.
 */
const SOURCE_FIGURES = [
  { dx: -19, dy: 3, opacity: 0.26 },
  { dx: -10.5, dy: -1.5, opacity: 0.5 },
  { dx: -1, dy: 1, opacity: 1 },
  { dx: 8, dy: -2.5, opacity: 0.62 },
  { dx: 17.5, dy: 2, opacity: 0.32 },
] as const;

const REQUEST_COLOR = 'var(--brand-bright)';
const LLM_COLOR = COST_SPLIT.llm_cost.color;

/** Frames are clamped so a backgrounded tab does not resume with one enormous step. */
const MAX_FRAME_SECONDS = 1 / 20;

const LANES: readonly { readonly lane: Lane; readonly title: string; readonly note: string }[] = [
  {
    lane: 'traditional',
    title: 'AutoGen + vLLM',
    note: 'Handed the blocks the policy asked for, and keeps them. Each one does a third of the work, so the traffic outruns it.',
  },
  {
    lane: 'canyon',
    title: 'CanyonOS',
    note: 'The same blocks, re-decided whenever the policy changes. More when latency leads, fewer when cost does.',
  },
];

/**
 * The same traffic through the same workflow, twice, side by side.
 *
 * Both panes draw the project's own design at the positions the API laid out, and both run the same
 * simulation — only the service and hop rates differ. That is the whole argument: change nothing but
 * the scheduling and one side backs up while the other does not.
 *
 * Loops for as long as the reader stays. Nothing here is measured, and there are no figures on it to
 * be mistaken for a benchmark.
 */
export function EmulationStage({
  graph,
  policy,
  baseline,
  run_key,
  onSettled,
}: {
  readonly graph: EmulationGraph;
  readonly policy: EmulationPolicy;
  /** What the config screen asked for, which is what the static lane was provisioned against. */
  readonly baseline: EmulationPolicy;
  /** Changes to start the run over, which is what Reset and every policy edit do. */
  readonly run_key: number;
  /**
   * Called once per run, when CanyonOS has stacked what the load needs, with the fleet that implies.
   * Only the scaling lane reports: the other one never stacks, so it has no fleet to propose.
   */
  readonly onSettled?: (fleet: StartingConfigInput) => void;
}) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2" data-testid="emulation-stage">
      {LANES.map((entry) => (
        <LanePane
          key={entry.lane}
          {...entry}
          graph={graph}
          policy={policy}
          baseline={baseline}
          run_key={run_key}
          onSettled={entry.lane === 'canyon' ? onSettled : undefined}
        />
      ))}
    </div>
  );
}

function LanePane({
  lane,
  title,
  note,
  graph,
  policy,
  baseline,
  run_key,
  onSettled,
}: {
  readonly lane: Lane;
  readonly title: string;
  readonly note: string;
  readonly graph: EmulationGraph;
  readonly policy: EmulationPolicy;
  readonly baseline: EmulationPolicy;
  readonly run_key: number;
  readonly onSettled?: (fleet: StartingConfigInput) => void;
}) {
  const state = useEmulation(graph, lane, policy, baseline, run_key, onSettled);
  const llm_x = VIEW.width - PAD.right / 2;
  const llm_y = VIEW.height / 2;
  // The traffic stands over the entry, because that is what it is sending to.
  const entry_node = graph.nodes.find((node) => node.id === graph.entry_id) ?? graph.nodes[0]!;
  const entry_at = place(entry_node);

  return (
    <section
      className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-2xl border p-4 shadow-xs"
      data-testid={`emulation-lane-${lane}`}
    >
      <header className="flex min-w-0 flex-col gap-0.5">
        <h3
          className={cn(
            'truncate text-[0.8125rem] font-bold tracking-[-0.01em]',
            lane === 'canyon' ? 'text-primary' : 'text-foreground'
          )}
        >
          {title}
        </h3>
        <p className="text-muted-foreground text-[0.71875rem] leading-snug text-pretty">{note}</p>
      </header>

      <svg
        viewBox={`0 ${-ARRIVAL_RISE} ${VIEW.width} ${VIEW.height + ARRIVAL_RISE}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${title}: requests moving through the workflow`}
      >
        <TrafficSource x={entry_at.x} y={-ARRIVAL_RISE + 12} />
        <Edges graph={graph} />
        <ModelBlock
          x={llm_x}
          y={llm_y}
          endpoint={
            LLM_ENDPOINT_OPTIONS.find((option) => option.value === policy.llm_endpoint)?.short ??
            'LLM'
          }
          replicas={state.replicas.get(LLM_NODE_ID) ?? 1}
          waiting={state.queues.get(LLM_NODE_ID) ?? 0}
        />
        <Nodes graph={graph} queues={state.queues} replicas={state.replicas} />
        <Dots dots={state.dots} graph={graph} llm_x={llm_x} llm_y={llm_y} />
      </svg>

      <LaneStats lane={lane} stats={state.stats} />
    </section>
  );
}

/**
 * What the lane has done so far, accumulating under it.
 *
 * Simulated, not measured, which the panel above says once for both lanes rather than each figure
 * repeating the disclaimer. Average queue is here because it is what the pile-up costs; blocks
 * because on one side it never moves, which is the whole argument.
 */
function LaneStats({
  lane,
  stats,
}: {
  readonly lane: Lane;
  readonly stats: EmulationState['stats'];
}) {
  const entries = [
    { label: 'Served', value: formatCompactCount(stats.served) },
    {
      label: 'Mean latency',
      value: stats.served === 0 ? '—' : formatDurationMs(stats.mean_latency * 1000),
    },
    { label: 'In flight', value: formatCompactCount(stats.in_flight) },
    // The average, not the high-water mark: the mark keeps the start-up ramp, which is not what
    // either lane looks like once it has settled. A tenth is worth reading on the lane that keeps
    // up and worth nothing on the lane holding tens of thousands.
    {
      label: 'Avg queue',
      value:
        stats.mean_queue < 100 ? stats.mean_queue.toFixed(1) : formatCompactCount(stats.mean_queue),
    },
    { label: 'Blocks', value: formatCompactCount(stats.replicas) },
  ];

  return (
    <dl
      className="border-border/70 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 sm:grid-cols-5"
      data-testid={`emulation-stats-${lane}`}
    >
      {entries.map((entry) => (
        <div key={entry.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-muted-foreground text-[0.625rem] font-semibold tracking-[0.05em] uppercase">
            {entry.label}
          </dt>
          <dd
            className={cn(
              'truncate font-mono text-[0.8125rem] font-semibold tabular-nums',
              lane === 'canyon' ? 'text-primary' : 'text-foreground'
            )}
          >
            {entry.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Runs the simulation for one lane against the frame clock.
 *
 * State lives in a ref and is copied into React once per frame: the dots are hundreds of objects
 * moving every frame, and putting each move through a setState would spend the frame on reconciling
 * rather than drawing. A reader who has asked for less motion gets a settled picture instead of a
 * loop, which is the same story told in one frame.
 */
function useEmulation(
  graph: EmulationGraph,
  lane: Lane,
  policy: EmulationPolicy,
  baseline: EmulationPolicy,
  run_key: number,
  onSettled?: (fleet: StartingConfigInput) => void
): EmulationState {
  const [state, setState] = useState<EmulationState>(EMPTY_STATE);
  const run = useRef(createRun(graph, lane, baseline));
  const run_signature = `${run_key}|${policySignature(policy)}|${policySignature(baseline)}`;
  // Read through a ref so a caller passing a fresh closure each render does not restart the run.
  const settled = useRef(onSettled);
  settled.current = onSettled;

  useEffect(() => {
    run.current = createRun(graph, lane, baseline);
    let reported = false;
    const snapshot = (next: EmulationState) =>
      setState({
        dots: [...next.dots],
        queues: new Map(next.queues),
        replicas: new Map(next.replicas),
        stats: next.stats,
      });
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      // Twelve seconds of the same arithmetic in one go, then held: the queues that would have built
      // and the blocks that would have stacked are there to read, without anything moving.
      let last_state: EmulationState = EMPTY_STATE;
      for (let elapsed = 0; elapsed < 12; elapsed += MAX_FRAME_SECONDS) {
        last_state = step(run.current, graph, lane, policy, MAX_FRAME_SECONDS);
      }
      snapshot(last_state);
      settled.current?.(fleetFromRun(last_state.replicas, graph));
      return;
    }

    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
      last = now;
      const next = step(run.current, graph, lane, policy, dt);
      snapshot(next);
      if (!reported && next.stats.elapsed >= SETTLE_SECONDS) {
        reported = true;
        settled.current?.(fleetFromRun(next.replicas, graph));
      }
      // Start over rather than run on: the struggling lane's queue has no ceiling, and a figure that
      // only ever grows stops being a figure. The fleet is not renamed — it belongs to the policy,
      // not to the cycle that happened to be running when it was worked out.
      if (next.stats.elapsed >= CYCLE_SECONDS) {
        run.current = createRun(graph, lane, baseline);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // Deliberately keyed on the policies' values rather than their identity. A caller that rebuilds
    // either object each render would otherwise restart the run on every unrelated re-render, which
    // has cut the cycle short twice now — once for the graph and once for the baseline. Comparing
    // what they say rather than which object they are is the guard against a third time.
  }, [graph, lane, run_signature]);

  return state;
}

/** Everything about a policy that changes a run, in one comparable string. */
function policySignature(policy: EmulationPolicy): string {
  return `${policy.expected_load}/${policy.load_unit}/${policy.priority}/${policy.llm_endpoint}`;
}

/** Node positions come normalised, so the pane decides where 0..1 lands. */
function place(node: { readonly x: number; readonly y: number }) {
  return {
    x: PAD.x + node.x * (VIEW.width - PAD.x - PAD.right),
    y: PAD.y + node.y * (VIEW.height - PAD.y * 2),
  };
}

function Edges({ graph }: { readonly graph: EmulationGraph }) {
  const by_id = new Map(graph.nodes.map((node) => [node.id, node]));

  return (
    <g>
      {graph.edges.map((edge) => {
        const source = by_id.get(edge.source);
        const target = by_id.get(edge.target);
        if (!source || !target) return null;
        const from = place(source);
        const to = place(target);
        return (
          <line
            key={`${edge.source}-${edge.target}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="var(--border)"
            strokeWidth={1}
          />
        );
      })}
    </g>
  );
}

function Nodes({
  graph,
  queues,
  replicas,
}: {
  readonly graph: EmulationGraph;
  readonly queues: EmulationState['queues'];
  readonly replicas: EmulationState['replicas'];
}) {
  return (
    <g>
      {graph.nodes.map((node) => {
        const at = place(node);
        const waiting = queues.get(node.id) ?? 0;
        const standing = replicas.get(node.id) ?? 1;

        return (
          <g key={node.id}>
            <Stack x={at.x} y={at.y} count={standing} width={NODE.width} height={NODE.height} />
            <rect
              x={at.x - NODE.width / 2}
              y={at.y - NODE.height / 2}
              width={NODE.width}
              height={NODE.height}
              rx={5}
              fill="var(--background)"
              stroke="var(--border)"
              strokeWidth={1}
            />
            {standing > 1 ? (
              <text
                x={at.x + NODE.width / 2 - 4}
                y={at.y - NODE.height / 2 - 3}
                textAnchor="end"
                className="fill-primary font-mono text-[6.5px] font-bold"
              >
                ×{formatCompactCount(standing)}
              </text>
            ) : null}
            <text
              x={at.x}
              y={at.y + 3.2}
              textAnchor="middle"
              className="fill-foreground font-mono text-[7px] font-semibold"
            >
              {node.label.length > 13 ? `${node.label.slice(0, 12)}…` : node.label}
            </text>
            <Queue x={at.x - NODE.width / 2 - 6} y={at.y} waiting={waiting} />
          </g>
        );
      })}
    </g>
  );
}

/** How the waiting stack is laid out: dots per row, the gap between them, and its radius. */
const QUEUE_GRID = { per_row: 5, pitch: 4.3, radius: 1.85 } as const;

/**
 * What is waiting to be served, stacked to the left of the node it waits at.
 *
 * One dot per request, growing leftwards and downwards, so the size of the block is the depth of the
 * queue. That is the whole point of drawing it: a lane holding a dozen and a lane holding hundreds
 * have to look nothing alike, and a cap low enough for both lanes to reach drew each of them the
 * same picture.
 *
 * Past `QUEUE_DRAWN_MAX` the block is full and the count carries the rest. A stack that kept growing
 * would leave the pane, and by then the number says more than another row would.
 */
function Queue({
  x,
  y,
  waiting,
}: {
  readonly x: number;
  readonly y: number;
  readonly waiting: number;
}) {
  if (waiting === 0) return null;
  const drawn = Math.min(waiting, QUEUE_DRAWN_MAX);
  const rows = Math.ceil(drawn / QUEUE_GRID.per_row);
  // Centred on the node, so a deep stack grows both ways rather than hanging off one side of it.
  const top = y - ((rows - 1) * QUEUE_GRID.pitch) / 2;

  return (
    <g>
      {Array.from({ length: drawn }, (_dot, index) => (
        <circle
          key={index}
          cx={x - (index % QUEUE_GRID.per_row) * QUEUE_GRID.pitch}
          cy={top + Math.floor(index / QUEUE_GRID.per_row) * QUEUE_GRID.pitch}
          r={QUEUE_GRID.radius}
          fill={REQUEST_COLOR}
          fillOpacity={0.8}
        />
      ))}
      {waiting > QUEUE_DRAWN_MAX ? (
        <text
          x={x - (QUEUE_GRID.per_row - 1) * QUEUE_GRID.pitch - 4}
          y={top + rows * QUEUE_GRID.pitch + 4}
          textAnchor="end"
          className="fill-foreground font-mono text-[7px] font-bold"
        >
          +{formatCompactCount(waiting - QUEUE_DRAWN_MAX)}
        </text>
      ) : null}
    </g>
  );
}

/**
 * Who the traffic is coming from, standing over the entry it sends to.
 *
 * Stacked rather than single, because the arriving load is many callers and one figure would read as
 * one caller being unusually busy. Decorative: the svg's own label already says what is happening,
 * so this adds no second voice for a screen reader to repeat.
 */
function TrafficSource({ x, y }: { readonly x: number; readonly y: number }) {
  return (
    <g aria-hidden data-testid="emulation-traffic-source">
      {SOURCE_FIGURES.map((figure) => (
        <g
          key={figure.dx}
          opacity={figure.opacity}
          transform={`translate(${x + figure.dx} ${y + figure.dy})`}
        >
          <circle cx={0} cy={-4.4} r={3.1} fill="var(--muted-foreground)" />
          <path d="M -5.4 5.2 a 5.4 5.4 0 0 1 10.8 0 z" fill="var(--muted-foreground)" />
        </g>
      ))}
    </g>
  );
}

/**
 * The replicas standing behind a block, drawn as offset outlines.
 *
 * Depth rather than a number, because the reader is meant to see one side thicken while the other
 * stays flat. The count beside it is for anyone who wants to read the exact figure.
 */
function Stack({
  x,
  y,
  count,
  width,
  height,
}: {
  readonly x: number;
  readonly y: number;
  readonly count: number;
  readonly width: number;
  readonly height: number;
}) {
  if (count <= 1) return null;
  const drawn = Math.min(count - 1, STACK_DRAWN_MAX);

  return (
    <g aria-hidden>
      {Array.from({ length: drawn }, (_block, index) => {
        const offset = (index + 1) * 2.6;
        return (
          <rect
            key={index}
            x={x - width / 2 + offset}
            y={y - height / 2 - offset}
            width={width}
            height={height}
            rx={5}
            fill="var(--accent)"
            stroke="var(--primary)"
            strokeOpacity={0.4}
            strokeWidth={1}
          />
        );
      })}
    </g>
  );
}

/** The model everything calls out to. Outside the workflow, because that is where it lives. */
function ModelBlock({
  x,
  y,
  endpoint,
  replicas,
  waiting,
}: {
  readonly x: number;
  readonly y: number;
  readonly endpoint: string;
  readonly replicas: number;
  readonly waiting: number;
}) {
  return (
    <g>
      <Stack x={x} y={y} count={replicas} width={56} height={52} />
      <rect
        x={x - 28}
        y={y - 26}
        width={56}
        height={52}
        rx={7}
        fill="var(--muted)"
        stroke="var(--border)"
        strokeWidth={1}
        strokeDasharray="3 2"
      />
      <text
        x={x}
        y={y - 6}
        textAnchor="middle"
        className="fill-muted-foreground font-mono text-[7px] font-bold tracking-[0.06em]"
      >
        {endpoint}
      </text>
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        className="fill-muted-foreground font-mono text-[6px]"
      >
        {waiting === 0 ? 'endpoint' : `${formatCompactCount(waiting)} in`}
      </text>
      {replicas > 1 ? (
        <text
          x={x}
          y={y + 15}
          textAnchor="middle"
          className="fill-primary font-mono text-[6.5px] font-bold"
        >
          ×{formatCompactCount(replicas)}
        </text>
      ) : null}
    </g>
  );
}

function Dots({
  dots,
  graph,
  llm_x,
  llm_y,
}: {
  readonly dots: readonly Dot[];
  readonly graph: EmulationGraph;
  readonly llm_x: number;
  readonly llm_y: number;
}) {
  const by_id = new Map(graph.nodes.map((node) => [node.id, node]));

  return (
    <g>
      {/* A queued dot is drawn by its node's stack, not here. Dropped before the map rather than
          inside it: on the lane that backs up they are almost all of them, and handing React tens of
          thousands of children that render to nothing costs a frame either way. */}
      {dots
        .filter((dot) => dot.phase !== 'queue')
        .map((dot) => {
          const node = by_id.get(dot.at);
          if (!node) return null;
          const at = place(node);

          if (dot.phase === 'arrive') {
            // Falling in from above the pane onto the entry. The lane offset is taken from the id so
            // the stream is spread without a random number generator.
            const drift = ((dot.id % 5) - 2) * (ARRIVAL_SPREAD / 4);
            const from_y = -ARRIVAL_RISE + 22;
            return (
              <circle
                key={dot.id}
                cx={at.x + drift * (1 - dot.progress)}
                cy={from_y + (at.y - from_y) * dot.progress}
                r={ARRIVAL_RADIUS}
                fill={REQUEST_COLOR}
              />
            );
          }

          if (dot.phase === 'llm') {
            // Out to the model and back along the same line, so the round trip reads as one movement.
            const t = dot.returning ? 1 - dot.progress : dot.progress;
            return (
              <circle
                key={dot.id}
                cx={at.x + (llm_x - 28 - at.x) * t}
                cy={at.y + (llm_y - at.y) * t}
                r={DOT_RADIUS}
                fill={LLM_COLOR}
              />
            );
          }

          const from = dot.from ? by_id.get(dot.from) : undefined;
          const start = from ? place(from) : { x: PAD.x / 2, y: at.y };
          return (
            <circle
              key={dot.id}
              cx={start.x + (at.x - start.x) * dot.progress}
              cy={start.y + (at.y - start.y) * dot.progress}
              r={DOT_RADIUS}
              fill={REQUEST_COLOR}
            />
          );
        })}
    </g>
  );
}
