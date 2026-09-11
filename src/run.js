/**
 * Full run: verified findings in, ranked briefing and a drafted notice out.
 *
 * Usage: node --env-file=.env src/run.js [out/findings.json]
 */
import { readFile } from 'node:fs/promises'
import { buildGraph, traceNodes } from './graph.js'

const path = process.argv[2] ?? 'out/findings.json'
const { project, findings } = JSON.parse(await readFile(path, 'utf8'))

// Only what the agent layer needs, and nothing it could contradict.
const actionable = findings
  .filter((f) => f.exposure.level !== 'NONE')
  .map((f) => ({
    subcontractor: f.name,
    licenceNumber: f.licenseNumber,
    trade: f.trade,
    licenceType: f.license?.licenseType ?? 'unverified',
    registryStatus: f.license?.statusRaw ?? 'not found',
    expires: f.license?.expirationDate ?? null,
    exposure: f.exposure.level,
    findings: f.exposure.reasons,
    recommendedAction: f.exposure.action,
  }))

console.log(`\n${project}`)
console.log(`${actionable.length} findings need attention.\n`)

const graph = await buildGraph()
traceNodes(graph, (phase, node) => console.log(`  [${node}] ${phase}`))

const result = await graph.invoke(
  `Project: ${project}\n\nVerified findings:\n${JSON.stringify(actionable, null, 2)}`,
)

const textOf = (node) =>
  (node.content ?? [])
    .map((block) => block.text ?? '')
    .join('')
    .trim()

for (const node of result.results ?? []) {
  const body = textOf(node)
  if (!body) continue
  const title = node.nodeId.toUpperCase()
  console.log(`\n── ${title} ` + '─'.repeat(Math.max(4, 66 - title.length)) + '\n')
  console.log(body)
}
