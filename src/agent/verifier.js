/**
 * The verification agent.
 *
 * Proto used to verify a roster with a for loop: ask the register, ask the
 * permit service, score, repeat. That worked, but it asked every source about
 * every subcontractor whether or not the answer could possibly matter, and it
 * was not an agent in any meaningful sense.
 *
 * The agent decides how deep to dig. A licence that comes back current and valid
 * for two more years needs nothing further. One that comes back suspended,
 * delinquent or void needs permit history, because open work under a dead
 * licence is the finding that matters, and it needs the trade checked against
 * the licence class. That judgement is genuinely a judgement, and it saves real
 * requests against a public government service.
 *
 * What the agent may not do is decide what any of it means. It gathers; the
 * exposure engine scores. The tools return facts, the agent chooses which facts
 * to go and get, and nothing it says can change one.
 */
import { Agent, AfterToolCallEvent } from '@strands-agents/sdk'
import { z } from 'zod'
import { lookupLicenseTool, permitActivityTool, scopeMatchTool } from '../tools/verify.js'
import { buildModel } from '../model.js'

const SYSTEM = [
  'You verify one Florida subcontractor licence for a general contractor.',
  '',
  'Always call lookup_license first.',
  '',
  'Then decide whether more is needed:',
  '- If the licence is NOT in good standing (suspended, delinquent, revoked, void,',
  '  expired, relinquished, deceased), call get_permit_activity. Work running under',
  '  a dead licence is the thing that matters, and permits are how you see it.',
  '- If the licence expires within 60 days, call get_permit_activity as well.',
  '- If a trade was given and the licence class might not cover it, call check_scope.',
  '- If the licence is current, valid well into the future, and the trade matches,',
  '  stop. Do not call anything else. Asking a public register questions whose',
  '  answer cannot change the outcome is waste.',
  '',
  'Never state a status, date or count that a tool did not return.',
  'You do not decide severity. You gather, and say what you gathered and why.',
].join('\n')

const Result = z.object({
  checkedPermits: z.boolean().describe('true if get_permit_activity was called'),
  checkedScope: z.boolean().describe('true if check_scope was called'),
  rationale: z
    .string()
    .describe('One short sentence: why you stopped where you did. No invented facts.'),
})

/**
 * Verify one subcontractor.
 *
 * Returns the facts the agent gathered plus a record of which sources it chose
 * to consult, so the decision is auditable rather than implied.
 */
export async function verifySubcontractor(sub, { county, model } = {}) {
  const used = []
  const facts = { license: null, permits: null, scope: null }

  const agent = new Agent({
    model: model ?? (await buildModel()),
    systemPrompt: SYSTEM,
    tools: [lookupLicenseTool(facts, { county }), permitActivityTool(facts, { county }), scopeMatchTool(facts)],
    structuredOutputSchema: Result,
    printer: false,
  })

  // The tools write their results into `facts` directly, so what the engine
  // scores is what the register returned, never the model's retelling of it.
  agent.addHook(AfterToolCallEvent, (event) => used.push(event.toolUse.name))

  const result = await agent.invoke(
    `Licence ${sub.licenseNumber}` +
      (sub.trade ? `, engaged for ${sub.trade} work.` : '.') +
      ' Verify it.',
  )

  return {
    ...facts,
    toolsUsed: used,
    rationale: result.structuredOutput?.rationale ?? null,
  }
}
