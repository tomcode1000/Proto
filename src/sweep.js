/**
 * Roster sweep: verify every subcontractor on a project against the live
 * registry, score the exposure, and rank by what is actually dangerous.
 *
 * The sweep is resumable. Each subcontractor is committed to the run journal
 * the moment it is verified, so a run that dies at nine of sixteen resumes at
 * ten, not at one.
 *
 * Usage:
 *   node --env-file=.env src/sweep.js [roster.json] [--fresh]
 *
 * To demonstrate recovery, set PROTO_CRASH_AFTER=<n> to kill the process after
 * n subcontractors, then run it again with no flag.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { lookupLicense } from './connectors/dbpr.js'
import { getPermitActivity } from './connectors/permits.js'
import { scoreExposure, rankByExposure } from './engine/exposure.js'
import { openJournal } from './journal.js'

const BADGE = { CRITICAL: '■ CRITICAL', HIGH: '■ HIGH', MEDIUM: '▪ MEDIUM', LOW: '· low', NONE: '· ok' }

const args = process.argv.slice(2)
const rosterPath = args.find((a) => !a.startsWith('--')) ?? 'data/roster.json'
const fresh = args.includes('--fresh')
const crashAfter = Number(process.env.PROTO_CRASH_AFTER ?? 0)

const roster = JSON.parse(await readFile(rosterPath, 'utf8'))
const journal = await openJournal(roster, { fresh })

console.log(`\n${roster.project}`)
console.log(`${roster.generalContractor} · ${roster.subcontractors.length} subcontractors · ${roster.county}`)
console.log(`run ${journal.runId} · checked ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z`)

if (journal.isResumed) {
  console.log(`\n  resuming, ${journal.doneCount()} of ${roster.subcontractors.length} already verified, picking up from there`)
}
console.log()

let verified = 0
for (const sub of roster.subcontractors) {
  if (journal.has(sub.licenseNumber)) {
    console.log(`  ${sub.licenseNumber} … already verified, skipping`)
    continue
  }

  process.stdout.write(`  checking ${sub.licenseNumber} … `)
  const license = await lookupLicense(sub.licenseNumber).catch(() => null)
  const permits = await getPermitActivity(sub.licenseNumber, { county: roster.county }).catch(() => null)
  const exposure = scoreExposure({ license, permits, trade: sub.trade })

  // Commit before moving on. Once this returns, this subcontractor never has to
  // be asked about again, whatever happens to the process next.
  await journal.commit(sub.licenseNumber, { ...sub, license, permits, exposure })
  console.log(exposure.level)

  if (crashAfter && ++verified >= crashAfter) {
    console.log(`\n  [simulated crash after ${verified} verified, journal holds ${journal.doneCount()}]`)
    process.exit(137)
  }
}

const scored = roster.subcontractors.map((s) => journal.get(s.licenseNumber)).filter(Boolean)

console.log('\n' + '─'.repeat(72))
for (const s of rankByExposure(scored)) {
  console.log(`\n${BADGE[s.exposure.level]}  ${s.name}`)
  console.log(`   ${s.licenseNumber} · ${s.license?.licenseType ?? 'unverified'}`)
  for (const reason of s.exposure.reasons) console.log(`   → ${reason}`)
  if (s.exposure.level !== 'NONE') console.log(`   action: ${s.exposure.action}`)
}

await mkdir('out', { recursive: true })
await writeFile(
  'out/findings.json',
  JSON.stringify({ project: roster.project, checkedAt: new Date().toISOString(), findings: scored }, null, 2),
)

console.log('\n' + '─'.repeat(72))
const acting = scored.filter((s) => s.exposure.level !== 'NONE').length
console.log(`${acting} of ${scored.length} need attention.`)

// The run is complete, so the journal has nothing left to protect.
await journal.clear()
console.log()
