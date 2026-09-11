/**
 * The agent layer.
 *
 * Facts are established before this runs: the registry and permit connectors
 * gather them and `engine/exposure.js` scores them, deterministically. The graph
 * is handed findings that are already true, and does the two things a language
 * model is genuinely good at — deciding what the site manager should do first,
 * and writing the notice that goes out.
 *
 *   triage ──▶ notice
 *
 * Nothing downstream can change a status, a date, or a permit count. If a node
 * tried, the numbers it invented would contradict the record printed beside it.
 */
import { Agent } from '@strands-agents/sdk'
import { Graph, BeforeNodeCallEvent, AfterNodeCallEvent } from '@strands-agents/sdk/multiagent'
import { buildModel } from './model.js'

const FACTS_RULE =
  'You are given findings that have already been verified against the state registry. ' +
  'Treat every status, date, licence number and permit count as fixed. ' +
  'Never restate a number that is not in the findings, and never soften a finding.'

export async function buildGraph() {
  const model = await buildModel()

  const triage = new Agent({
    id: 'triage',
    model,
    printer: false,
    systemPrompt: [
      'You are the compliance lead for a general contractor.',
      FACTS_RULE,
      'Put the findings in the order the site manager should act on them this morning,',
      'hardest consequence first. For each, give one line saying what to do and why it',
      'cannot wait. Ignore anything marked NONE. Be brief — this is read on a phone.',
    ].join(' '),
  })

  const notice = new Agent({
    id: 'notice',
    model,
    printer: false,
    systemPrompt: [
      'You draft the written notice a general contractor sends a subcontractor',
      'whose licence is not in good standing.',
      FACTS_RULE,
      'Write one short, plain, professional notice for the single most serious finding.',
      'State the licence number, what the registry says, what happens now, and what the',
      'subcontractor must provide to resume. No legal threats, no filler, under 150 words.',
    ].join(' '),
  })

  return new Graph({
    nodes: [triage, notice],
    edges: [['triage', 'notice']],
    maxConcurrency: 1,
    // A compliance run must terminate: an unbounded graph that stalls is worse
    // than one that fails and says so.
    maxSteps: 8,
    timeout: 120_000,
    nodeTimeout: 60_000,
  })
}

/** Attach node-level tracing; the same seam carries checkpointing on day 2. */
export function traceNodes(graph, onEvent = () => {}) {
  graph.addHook(BeforeNodeCallEvent, (e) => onEvent('start', e.nodeId))
  graph.addHook(AfterNodeCallEvent, (e) => onEvent('done', e.nodeId))
}
