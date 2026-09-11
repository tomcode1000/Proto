/**
 * Day-0 gate.
 *
 * Proves the three Strands primitives Proto is built on are all live:
 *   1. the agent loop reaches a model
 *   2. a Zod-typed tool is selected and executed
 *   3. lifecycle hooks fire around that tool call
 *
 * If this prints a verdict, the foundation is sound. Run: npm run smoke
 */
import { Agent, tool, BeforeToolCallEvent, AfterToolCallEvent } from '@strands-agents/sdk'
import { z } from 'zod'
import { buildModel } from './model.js'

const lookupLicense = tool({
  name: 'lookup_license',
  description: 'Look up the current status of a Florida contractor license by number.',
  inputSchema: z.object({
    licenseNumber: z.string().describe('License number, e.g. CCC1330456'),
  }),
  callback: async ({ licenseNumber }) => {
    // Day-0 stub. Day 1 replaces this with the live DBPR lookup.
    return { licenseNumber, status: 'DELINQUENT', expiresOn: '2026-08-31' }
  },
})

const traced = []

async function main() {
  const model = await buildModel()

  const agent = new Agent({
    model,
    systemPrompt:
      'You verify Florida contractor licenses. Use the tools available. Be terse and factual.',
    tools: [lookupLicense],
  })

  agent.addHook(BeforeToolCallEvent, (event) => {
    traced.push(`before:${event.toolUse.name}`)
  })
  agent.addHook(AfterToolCallEvent, (event) => {
    traced.push(`after:${event.toolUse.name}`)
  })

  const result = await agent.invoke('What is the status of license CCC1330456?')

  console.log('\n--- agent ---')
  console.log(String(result))
  console.log('\n--- hooks fired ---')
  console.log(traced.length ? traced.join('  ->  ') : '(none — tool was not called)')

  const ok = traced.includes('before:lookup_license') && traced.includes('after:lookup_license')
  console.log(`\nDay-0 gate: ${ok ? 'PASS' : 'FAIL'} — model reached, tool executed, hooks fired.`)
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('\nDay-0 gate: FAIL\n')
  console.error(err.message)
  process.exit(1)
})
