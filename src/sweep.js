/**
 * Headless sweep.
 *
 * The same run the control room performs, without a browser: useful for a cron
 * entry, a deploy hook, or checking a roster over SSH. It consumes the one
 * sweeper the server uses rather than repeating its logic, because a second
 * copy of that loop drifts and then quietly disagrees with the first.
 *
 * Usage:
 *   node src/sweep.js            verify the active project
 *   node src/sweep.js --fresh    ignore any half finished run and start over
 *   node src/sweep.js --direct   skip the agent, read every source for everyone
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { loadRoster } from './roster.js'
import { runSweep } from './sweeper.js'
import { recordRun } from './history.js'

const BADGE = { CRITICAL: '!! CRITICAL', HIGH: '!  HIGH', MEDIUM: '.  MEDIUM', LOW: '.  low', NONE: '   ok' }

const args = process.argv.slice(2)
const roster = await loadRoster()

if (!roster.subcontractors.length) {
  console.error('The roster is empty. Add subcontractors before sweeping.')
  process.exit(1)
}

console.log(`\n${roster.project || 'Untitled project'}`)
console.log(`${roster.subcontractors.length} subcontractors, ${roster.county}\n`)

let findings = []

for await (const event of runSweep(roster, {
  fresh: args.includes('--fresh'),
  direct: args.includes('--direct'),
})) {
  if (event.type === 'skip') console.log(`  ${event.entry.licenseNumber}  already verified`)
  if (event.type === 'verified') {
    const tools = (event.entry.investigation?.toolsUsed ?? []).filter((t) => !/structured/.test(t))
    console.log(`  ${event.entry.licenseNumber}  ${event.entry.exposure.level.padEnd(9)} ${tools.length} calls`)
  }
  if (event.type === 'unreachable') console.log(`  ${event.sub.licenseNumber}  register did not answer`)
  if (event.type === 'complete') findings = event.findings
}

if (!findings.length) {
  console.log('\nNothing was established. Nothing recorded.\n')
  process.exit(1)
}

console.log('\n' + '-'.repeat(66))
for (const f of findings) {
  console.log(`\n${BADGE[f.exposure.level]}  ${f.name}`)
  console.log(`   ${f.licenseNumber}, ${f.license?.licenseType ?? 'unverified'}`)
  for (const reason of f.exposure.reasons) console.log(`   - ${reason}`)
  if (f.exposure.level !== 'NONE') console.log(`   action: ${f.exposure.action}`)
}

// A completed run enters the record and is left where the briefing can read it.
await recordRun(roster.project, findings)
await mkdir('out', { recursive: true })
await writeFile(
  'out/findings.json',
  JSON.stringify({ project: roster.project, checkedAt: new Date().toISOString(), findings }, null, 2),
)

const acting = findings.filter((f) => f.exposure.level !== 'NONE').length
console.log('\n' + '-'.repeat(66))
console.log(`${acting} of ${findings.length} need attention.\n`)
