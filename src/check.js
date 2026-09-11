/**
 * Single-licence check, end to end: agent -> live registry -> grounded answer.
 *
 * Usage: node --env-file=.env src/check.js CCC1330456
 */
import { Agent, BeforeToolCallEvent, AfterToolCallEvent } from '@strands-agents/sdk'
import { buildModel } from './model.js'
import { lookupLicenseTool } from './tools/license.js'

const licenseNumber = process.argv[2] ?? 'CCC1330456'

const agent = new Agent({
  model: await buildModel(),
  systemPrompt: [
    'You verify Florida contractor licences for a general contractor.',
    'Always call lookup_license, never answer about a licence from memory.',
    'Report only what the tool returned. Do not infer, soften, or embellish.',
    'Be terse.',
  ].join(' '),
  tools: [lookupLicenseTool],
  printer: false,
})

const calls = []
agent.addHook(BeforeToolCallEvent, (e) => calls.push(e.toolUse.name))
agent.addHook(AfterToolCallEvent, (e) => calls.push(`${e.toolUse.name}:done`))

const result = await agent.invoke(`What is the current standing of licence ${licenseNumber}?`)

console.log(`\n${String(result).trim()}`)
console.log(`\ntools: ${calls.join(' -> ') || '(none)'}`)
