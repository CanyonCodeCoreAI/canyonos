import type { ProjectWorkflowDesign, WorkflowFlowNode } from '@cc-forge/api/workflows';

// Relative, like the other sibling imports in this module: the `@/` alias resolves through the
// tsconfig only, and this file has to load under `bun test` as well.
import { requestsPerSecond } from './deploy.scaling-plan';
import type { LlmEndpoint, LoadUnit } from './deploy.scaling-plan';
import type { StartingConfigInput } from './deploy.starting-config';

/**
 * The traffic emulation the two panes run: one simulation, stepped by the frame loop.
 *
 * Kept out of the component because it is arithmetic rather than markup, and because both panes run
 * this same code — only their lane constants differ. That is the whole claim being made, so it has to
 * be one implementation rather than two that happen to disagree.
 *
 * Nothing here is measured. The rates are stated, and they are the reason one side backs up and the
 * other does not. The policy the reader set is what drives arrivals, so raising the load really does
 * make the struggling side struggle sooner.
 */

/** The policy being emulated. Comes from the scaling policy screen, editable on the emulation. */
export interface EmulationPolicy {
  readonly expected_load: number;
  readonly load_unit: LoadUnit;
  /** 0 all latency, 100 all cost. Decides how freely CanyonOS is allowed to add replicas. */
  readonly priority: number;
  readonly llm_endpoint: LlmEndpoint;
}

/**
 * How much traffic one block of each lane gets through per second.
 *
 * This ratio is the claim the panes are built on, and the one number in here that a reader should be
 * told is an assertion rather than a measurement: a CanyonOS block does about three blocks' worth of
 * traditional work, because it packs and shares where a static deployment sizes each agent on its own
 * and pays for the slack.
 *
 * It is what lets both panes start with nothing waiting while one of them uses a third of the
 * hardware. Change this ratio and every figure on the screen changes with it.
 */
const SERVICE_PER_BLOCK = { traditional: 1.2, canyon: 3.6 } as const;

/** The ratio above, stated once so the copy and the arithmetic cannot drift apart. */
export const EFFICIENCY_RATIO = SERVICE_PER_BLOCK.canyon / SERVICE_PER_BLOCK.traditional;

/**
 * How much CanyonOS allocates against what the traffic needs, at each end of the slider.
 *
 * Latency-led buys spare capacity so nothing waits even as arrivals bunch up. Cost-led runs close to
 * the line, which is where its short queue comes from. This is the only thing the slider changes, and
 * only one of the two lanes is listening to it.
 */
const HEADROOM_ENDS = { latency: 1.5, cost: 0.75 } as const;

/**
 * How fast a lane that scales moves towards the blocks the policy now asks for.
 *
 * A flat block and a half a second is what makes the reaction watchable at the counts a reader
 * usually sets, and it is also what would leave a policy of a million requests a second crawling for
 * a day. So it is a floor rather than the rate: past a handful of blocks the lane moves a quarter of
 * the target a second instead, and arrives in the same few seconds at any scale.
 */
const ADJUST_PER_SECOND = 1.5;
const ADJUST_FRACTION_PER_SECOND = 0.25;

/**
 * Seconds a run lasts before it starts over.
 *
 * Left alone the struggling lane's queue grows without bound, and a pane left running all afternoon
 * has stopped saying anything. Three minutes is long enough to watch the pile-up become absurd,
 * which is the point being made, and short enough that a reader who looks away comes back to a run
 * rather than to a number.
 */
export const CYCLE_SECONDS = 180;

/**
 * Seconds a request takes to fall in from above the workflow.
 *
 * The same on both lanes: arriving traffic does not know or care which scheduler is behind the
 * entry, and making one side's arrivals slower would be arguing the wrong point.
 */
const ARRIVAL_SECONDS = 0.7;

/**
 * Seconds a hop between nodes takes, and one leg of a round trip out to the model.
 *
 * Shared by both lanes, for the same reason the service rate is: the network and the model do not
 * know which scheduler called them.
 */
const HOP_SECONDS = 0.3;
const LLM_LEG_SECONDS = 0.5;

/** How many requests one block of the model endpoint holds at a time. */
const LLM_CONCURRENCY_PER_BLOCK = 5;

/** Whether a lane may stack blocks at all. This is the lane's defining property. */
const SCALES = { traditional: false, canyon: true } as const;

/**
 * Simulation seconds before the run has settled enough to name a fleet.
 *
 * Long enough for CanyonOS to have stacked what the load actually needs — the first second or two is
 * one block per agent whatever the policy says, and a fleet read off that would understate it.
 */
export const SETTLE_SECONDS = 6;

/**
 * A queue this deep stops being drawn as dots and becomes a count.
 *
 * High enough that the two lanes cannot look alike: capped at ten, a queue of twelve and a queue of
 * two hundred both drew ten dots, which threw away the only comparison the panes are for. Forty
 * fills a block the eye reads as full, against the handful the scaling lane holds.
 */
export const QUEUE_DRAWN_MAX = 40;

/**
 * Arriving requests a second above which one moving dot stands for several of them.
 *
 * The policy is not capped: a reader may ask for a million a second, and the queues, the latency and
 * the fleet all answer for a million a second. What is capped is the drawing. A dot per request at
 * that load is fifty thousand objects a frame, which is not a picture of anything — it is a hung tab.
 * Past this rate the animation is a sample of the traffic and every figure beside it stays the true
 * count.
 */
export const DOTS_PER_SECOND_MAX = 30;

/** Requests one dot stands for under a policy. One at any load a pane can draw request by request. */
export function dotWeight(policy: EmulationPolicy): number {
  const arrivals = requestsPerSecond(policy.expected_load, policy.load_unit);
  return Math.max(1, Math.ceil(arrivals / DOTS_PER_SECOND_MAX));
}

/** The stacked model endpoint is a node like any other, so it needs an id nothing else can hold. */
export const LLM_NODE_ID = '__llm__';

export type Lane = 'traditional' | 'canyon';

/** Where the slider sits, as 0 at all-latency and 1 at all-cost. */
function costLean(policy: EmulationPolicy): number {
  return Math.min(1, Math.max(0, policy.priority / 100));
}

function between(ends: { readonly latency: number; readonly cost: number }, lean: number): number {
  return ends.latency + (ends.cost - ends.latency) * lean;
}

/** `arrive` is the fall into the workflow from outside it, before anything has been asked of it. */
export type DotPhase = 'arrive' | 'hop' | 'queue' | 'llm';

export interface Dot {
  readonly id: number;
  readonly phase: DotPhase;
  readonly at: string;
  readonly from: string | null;
  readonly progress: number;
  readonly returning: boolean;
  /** Simulation clock when the request arrived, for the latency it finishes with. */
  readonly born: number;
  /** Requests this dot stands for: one, until the load outgrows what a pane can draw. */
  readonly weight: number;
}

export interface EmulationNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'workflow' | 'agent' | 'tool';
  /** Normalised into the unit square, so a pane decides where 0..1 lands. */
  readonly x: number;
  readonly y: number;
}

export interface EmulationEdge {
  readonly source: string;
  readonly target: string;
}

export interface EmulationGraph {
  readonly nodes: readonly EmulationNode[];
  readonly edges: readonly EmulationEdge[];
  /** Nodes that call a model, so a request leaves the workflow from them. */
  readonly llm_nodes: readonly string[];
  readonly entry_id: string;
}

export interface EmulationStats {
  /** Requests that finished, and the mean seconds they took. */
  readonly served: number;
  readonly mean_latency: number;
  readonly in_flight: number;
  /**
   * Requests waiting at agents, averaged over the run so far, and the deepest it ever got.
   *
   * The average is the fair comparison and the one the panes are read against: a high-water mark
   * keeps whatever happened during the first seconds, when CanyonOS is still stacking towards what
   * the traffic needs, and that start-up transient is not what either lane looks like.
   *
   * The model endpoint is left out of both: its count is how many requests it is holding at once, and
   * a request at the model is being served rather than waiting for anything.
   */
  readonly mean_queue: number;
  readonly peak_queue: number;
  /** Replicas standing right now, across every agent and the model endpoint. */
  readonly replicas: number;
  readonly elapsed: number;
}

export interface EmulationState {
  readonly dots: readonly Dot[];
  readonly queues: ReadonlyMap<string, number>;
  /** Replicas per node id, including the model endpoint. Always at least one. */
  readonly replicas: ReadonlyMap<string, number>;
  readonly stats: EmulationStats;
}

export const EMPTY_STATS: EmulationStats = {
  served: 0,
  mean_latency: 0,
  in_flight: 0,
  mean_queue: 0,
  peak_queue: 0,
  replicas: 0,
  elapsed: 0,
};

export const EMPTY_STATE: EmulationState = {
  dots: [],
  queues: new Map(),
  replicas: new Map(),
  stats: EMPTY_STATS,
};

/**
 * The design, reduced to what the animation needs and normalised into the unit square.
 *
 * The API already positions the nodes, so this is the layout the design screen draws rather than a
 * second guess at it.
 */
export function toEmulationGraph(design: ProjectWorkflowDesign): EmulationGraph | null {
  if (design.nodes.length === 0) return null;

  const xs = design.nodes.map((node) => node.position.x);
  const ys = design.nodes.map((node) => node.position.y);
  const min_x = Math.min(...xs);
  const min_y = Math.min(...ys);
  const span_x = Math.max(...xs) - min_x || 1;
  const span_y = Math.max(...ys) - min_y || 1;

  const nodes = design.nodes.map((node) => ({
    id: node.id,
    label: nodeLabel(node),
    kind: node.data.kind,
    x: (node.position.x - min_x) / span_x,
    y: (node.position.y - min_y) / span_y,
  }));

  // Routes and calls are the paths a request travels. A loop or a return retraces one, so following
  // them would send dots back over ground they have already covered.
  const edges = design.edges
    .filter((edge) => edge.data.edge_type === 'route' || edge.data.edge_type === 'call')
    .map((edge) => ({ source: edge.source, target: edge.target }));

  // Agents are what call models: a tool is a local call, and the workflow node is the entry.
  const llm_nodes = nodes.filter((node) => node.kind === 'agent').map((node) => node.id);

  const targeted = new Set(edges.map((edge) => edge.target));
  const entry = nodes.find((node) => !targeted.has(node.id)) ?? nodes[0]!;

  return { nodes, edges, llm_nodes, entry_id: entry.id };
}

function nodeLabel(node: WorkflowFlowNode): string {
  const file = node.data.file.split('/').pop() ?? node.data.file;
  return file.replace(/\.(py|yaml|yml|json|ts)$/, '');
}

interface Run {
  dots: Dot[];
  queues: Map<string, number>;
  replicas: Map<string, number>;
  next_id: number;
  arrival_debt: number;
  /** Requests a node has earned the right to serve and not yet spent, per node id. */
  service_credit: Map<string, number>;
  clock: number;
  served: number;
  latency_total: number;
  peak_queue: number;
  /** Waiting requests integrated over time, so dividing by the clock gives the average depth. */
  queue_seconds: number;
  /** Fractional blocks owed, so an adjustment rate under one a second still happens. */
  adjust_debt: number;
}

/**
 * A run in progress. Held in a ref by the caller and stepped once per frame.
 *
 * `baseline` is the policy the config screen set, which is what the static lane was provisioned
 * against. Editing the policy on the emulation does not change it — that is the whole point of the
 * comparison, and why it is passed separately from the policy each step is given.
 */
export function createRun(graph: EmulationGraph, lane: Lane, baseline: EmulationPolicy): Run {
  // Both lanes open on the allocation the scaling policy screen worked out. That is the comparison:
  // the same hardware, and one lane's blocks do three times the work of the other's.
  const opening = allocationFor(baseline);
  const replicas = new Map<string, number>([[LLM_NODE_ID, opening]]);
  for (const node of graph.nodes) replicas.set(node.id, opening);

  return {
    dots: [],
    queues: new Map(),
    replicas,
    next_id: 0,
    arrival_debt: 0,
    service_credit: new Map(),
    clock: 0,
    served: 0,
    latency_total: 0,
    peak_queue: 0,
    queue_seconds: 0,
    adjust_debt: 0,
  };
}

/**
 * What a lane needs, per agent, to keep up with a policy's traffic.
 *
 * An agent handles each request twice — once before its model call and once with the answer — so the
 * work arriving at one is twice the arrival rate. Divide by what one of that lane's blocks gets
 * through, and that is the answer. Rounded up, because half a block does not exist.
 */
export function blocksNeeded(policy: EmulationPolicy, lane: Lane): number {
  const arrivals = requestsPerSecond(policy.expected_load, policy.load_unit);
  return Math.max(1, Math.ceil((arrivals * 2) / SERVICE_PER_BLOCK[lane]));
}

/**
 * The blocks CanyonOS allocates per node for a policy.
 *
 * This is the number the scaling policy screen decides, and the number both lanes are given to start
 * with. What happens next is the whole comparison: CanyonOS recomputes it as the policy changes, and
 * the other lane keeps whatever it was handed.
 *
 * Worked from the raw need rather than the rounded-up one, so the slider actually moves the answer at
 * small block counts instead of being lost to a ceiling.
 */
export function allocationFor(policy: EmulationPolicy): number {
  const arrivals = requestsPerSecond(policy.expected_load, policy.load_unit);
  const raw = (arrivals * 2) / SERVICE_PER_BLOCK.canyon;
  return Math.max(1, Math.ceil(raw * between(HEADROOM_ENDS, costLean(policy))));
}

/**
 * Advance one lane by `dt` seconds.
 *
 * Arrivals and service accumulate as fractional debt rather than rounding per frame, so a rate of
 * 4.2 a second is 4.2 a second whatever the frame length happened to be.
 */
export function step(
  run: Run,
  graph: EmulationGraph,
  lane: Lane,
  policy: EmulationPolicy,
  dt: number
): EmulationState {
  run.clock += dt;

  const hop = HOP_SECONDS;
  const llm = LLM_LEG_SECONDS;
  const arrivals = requestsPerSecond(policy.expected_load, policy.load_unit);
  // Dots arrive at the drawable rate and each carries its share of the real traffic, so the requests
  // per second the reader asked for is what the queues, the latency and the fleet are worked out on.
  const weight = dotWeight(policy);

  run.arrival_debt += (arrivals / weight) * dt;
  while (run.arrival_debt >= 1) {
    run.arrival_debt -= 1;
    // Falls in from above rather than appearing at the entry: a request comes from somewhere, and
    // the queue it joins is what it joins on landing, not on being made.
    run.dots.push({
      id: (run.next_id += 1),
      phase: 'arrive',
      at: graph.entry_id,
      from: null,
      progress: 0,
      returning: false,
      born: run.clock,
      weight,
    });
  }

  // Move everything in motion, and finish what arrives.
  const next: Dot[] = [];
  for (const dot of run.dots) {
    if (dot.phase === 'queue') {
      next.push(dot);
      continue;
    }
    const duration = dot.phase === 'llm' ? llm : dot.phase === 'arrive' ? ARRIVAL_SECONDS : hop;
    const progress = dot.progress + dt / duration;
    if (progress < 1) {
      next.push({ ...dot, progress });
      continue;
    }
    if (dot.phase === 'llm') {
      if (!dot.returning) {
        // At the endpoint; turn it around rather than finishing it.
        next.push({ ...dot, progress: 0, returning: true });
        continue;
      }
      // Back from the model: the agent that called it queues again to route onward.
      bump(run.queues, LLM_NODE_ID, -dot.weight);
      next.push({ ...dot, phase: 'queue', progress: 0, from: null });
      bump(run.queues, dot.at, dot.weight);
      continue;
    }
    if (dot.phase === 'hop' && dot.at === '') {
      // A finished request: counted, then dropped.
      run.served += dot.weight;
      run.latency_total += dot.weight * (run.clock - dot.born);
      continue;
    }
    next.push({ ...dot, phase: 'queue', progress: 0, from: null });
    bump(run.queues, dot.at, dot.weight);
  }
  run.dots = next;

  // Stack replicas where the waiting justifies it. Only a lane that scales may, which is the whole
  // difference between the two panes.
  // CanyonOS follows the policy: it moves its allocation towards what the traffic now asks for,
  // a block at a time so the reaction is watchable. The other lane keeps what it was handed, which
  // is the whole of what static means here.
  if (SCALES[lane]) {
    const target = allocationFor(policy);
    run.adjust_debt += Math.max(ADJUST_PER_SECOND, target * ADJUST_FRACTION_PER_SECOND) * dt;
    const steps = Math.floor(run.adjust_debt);
    if (steps > 0) {
      run.adjust_debt -= steps;
      for (const id of [...graph.nodes.map((node) => node.id), LLM_NODE_ID]) {
        const standing = run.replicas.get(id) ?? 1;
        if (standing < target) run.replicas.set(id, Math.min(target, standing + steps));
        else if (standing > target) run.replicas.set(id, Math.max(target, standing - steps));
      }
    }
  }

  // Serve each node at the rate its blocks allow, totalling what waits on the way through.
  let waiting_now = 0;
  for (const node of graph.nodes) {
    const waiting = run.queues.get(node.id) ?? 0;
    waiting_now += waiting;
    if (waiting > run.peak_queue) run.peak_queue = waiting;
    if (waiting === 0) continue;

    const rate = SERVICE_PER_BLOCK[lane] * (run.replicas.get(node.id) ?? 1);
    // Service credit in requests, carried between steps and spent a whole dot at a time, so a node
    // slower than one dot a step still gets there. Never more than the queue holds: capacity against
    // traffic that has not arrived is not capacity.
    let credit = Math.min((run.service_credit.get(node.id) ?? 0) + rate * dt, waiting);

    for (const dot of run.dots) {
      // Every dot in a run stands for the same number of requests, so once one will not fit, none of
      // the rest will either.
      if (credit < weight) break;
      if (dot.phase !== 'queue' || dot.at !== node.id) continue;

      // The endpoint holds only so many at once, so an agent waiting on it stays put.
      const wants_llm = graph.llm_nodes.includes(node.id) && !dot.returning;
      if (wants_llm) {
        const in_llm = run.queues.get(LLM_NODE_ID) ?? 0;
        const llm_capacity = LLM_CONCURRENCY_PER_BLOCK * (run.replicas.get(LLM_NODE_ID) ?? 1);
        if (in_llm >= llm_capacity) continue;
        bump(run.queues, LLM_NODE_ID, dot.weight);
      }

      credit -= dot.weight;
      bump(run.queues, node.id, -dot.weight);
      Object.assign(dot, departure(dot, node.id, graph, wants_llm));
    }
    run.service_credit.set(node.id, credit);
  }

  run.queue_seconds += waiting_now * dt;

  return {
    dots: run.dots,
    queues: run.queues,
    replicas: run.replicas,
    stats: {
      served: run.served,
      mean_latency: run.served === 0 ? 0 : run.latency_total / run.served,
      in_flight: run.dots.reduce((total, dot) => total + dot.weight, 0),
      mean_queue: run.clock === 0 ? 0 : run.queue_seconds / run.clock,
      peak_queue: run.peak_queue,
      replicas: [...run.replicas.values()].reduce((total, count) => total + count, 0),
      elapsed: run.clock,
    },
  };
}

/**
 * Where a served request goes next.
 *
 * An agent that has not yet called its model does that first, because that round trip is what a
 * reader is here to see. Otherwise it routes on, and a leaf finishes — marked by an empty
 * destination, which the next sweep counts and removes.
 */
function departure(
  dot: Dot,
  node_id: string,
  graph: EmulationGraph,
  wants_llm: boolean
): Partial<Dot> {
  if (wants_llm) {
    return { phase: 'llm', at: node_id, from: node_id, progress: 0, returning: false };
  }

  const onward = graph.edges.filter((edge) => edge.source === node_id);
  if (onward.length === 0) {
    return { phase: 'hop', at: '', from: node_id, progress: 0.999, returning: true };
  }
  // Round-robin by id, so a fan-out is fed evenly without a random number generator.
  const chosen = onward[dot.id % onward.length]!;
  return { phase: 'hop', at: chosen.target, from: node_id, progress: 0, returning: false };
}

function bump(queues: Map<string, number>, id: string, by: number): void {
  queues.set(id, Math.max(0, (queues.get(id) ?? 0) + by));
}

/**
 * The fleet the run implies, read off the blocks CanyonOS ended up standing.
 *
 * This is the point of watching: the emulation is what decides the starting size, rather than a
 * default the reader has to guess at. Agents are the CPU side and the model endpoint the GPU side,
 * which is the split the fleet fields already draw.
 *
 * Every figure is clamped to the range its field accepts, so a heavy policy proposes the ceiling
 * rather than a number the form would reject.
 */
export function fleetFromRun(
  replicas: ReadonlyMap<string, number>,
  graph: EmulationGraph
): StartingConfigInput {
  const agent_blocks = graph.nodes.reduce((total, node) => total + (replicas.get(node.id) ?? 1), 0);
  const llm_blocks = replicas.get(LLM_NODE_ID) ?? 1;

  const starting_cpu = clamp(agent_blocks, 1, 10);
  const starting_gpu = clamp(llm_blocks - 1, 0, 2);

  return {
    starting_cpu_instances: starting_cpu,
    // Headroom over what the run needed, so the first busy hour does not hit the ceiling.
    max_cpu_instances: clamp(Math.ceil(starting_cpu * 1.5), starting_cpu, 20),
    starting_gpu_instances: starting_gpu,
    max_gpu_instances: clamp(starting_gpu + 1, starting_gpu, 4),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
