/**
 * Roster input.
 *
 * The people this is built for keep their subcontractor list in a spreadsheet,
 * an email, or their head — never in a JSON file. So a roster can be built three
 * ways, and all three converge on the same shape:
 *
 *   1. one licence number at a time, with the name resolved from the registry
 *   2. pasted lines or CSV, for the list that already exists somewhere
 *   3. a Google Sheet published to the web, for a list that keeps changing
 *
 * The Sheets path deliberately uses "Publish to web → CSV" rather than the
 * Google API: no OAuth, no key, no dependency, and the contractor keeps editing
 * the sheet they already use.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { lookupLicense } from './connectors/dbpr.js'

const ROSTER_PATH = process.env.PROTO_ROSTER ?? 'data/roster.json'

/** Florida licence numbers: two to six letters, then five to seven digits. */
const LICENCE = /\b([A-Z]{2,6}\d{5,7})\b/i

const TRADES = [
  [/roof/i, 'roofing'],
  [/(air|hvac|a\/c|mechanic)/i, 'hvac'],
  [/plumb/i, 'plumbing'],
  [/electric/i, 'electrical'],
  [/pool|spa/i, 'pool'],
]

/** Guess a trade from a licence class or a free-text column. Never invents one. */
export function inferTrade(...hints) {
  const text = hints.filter(Boolean).join(' ')
  for (const [pattern, trade] of TRADES) if (pattern.test(text)) return trade
  return null
}

/**
 * How often the roster is re-checked.
 *
 * This is the product in one field. A licence verified once is a snapshot; a
 * licence verified every week is a watch. The cadence lives with the roster so
 * it survives a restart and travels with the project.
 */
export const CADENCES = {
  daily: { label: 'Every day', days: 1, blurb: 'For a site with draws going out weekly.' },
  weekly: { label: 'Every week', days: 7, blurb: 'The usual choice. Catches a lapse within days.' },
  fortnightly: { label: 'Every two weeks', days: 14, blurb: 'For steady projects with few subcontractors.' },
  monthly: { label: 'Every month', days: 30, blurb: 'The least worth doing. A lapse can sit for weeks.' },
  off: { label: 'Only when I ask', days: null, blurb: 'No automatic checks. You run them yourself.' },
}

export function nextDueFrom(schedule) {
  const days = CADENCES[schedule?.cadence]?.days
  if (!days) return null
  const from = schedule.lastRun ? new Date(schedule.lastRun) : new Date()
  return new Date(from.getTime() + days * 86_400_000).toISOString()
}

/** Whole days until the next check. Negative means it is overdue. */
export function daysUntilDue(schedule) {
  const due = schedule?.nextDue ?? nextDueFrom(schedule)
  return due ? Math.ceil((new Date(due) - Date.now()) / 86_400_000) : null
}

export async function loadRoster() {
  const raw = await readFile(ROSTER_PATH, 'utf8').catch(() => null)
  const roster = raw
    ? JSON.parse(raw)
    : { project: '', generalContractor: '', county: 'MIAMI-DADE', subcontractors: [] }

  roster.schedule ??= { cadence: 'weekly', lastRun: null, nextDue: null }
  roster.schedule.nextDue ??= nextDueFrom(roster.schedule)
  return roster
}

export async function saveRoster(roster) {
  await mkdir('data', { recursive: true })
  await writeFile(ROSTER_PATH, JSON.stringify(roster, null, 2) + '\n')
  return roster
}

/**
 * Add one licence, resolving its real identity from the registry.
 *
 * The name is never taken on trust from whoever typed it: the registry is asked,
 * so what lands on the roster is what the state actually has on file.
 */
export async function addOne({ licenseNumber, name, trade }) {
  const licence = String(licenseNumber ?? '').trim().toUpperCase()
  if (!LICENCE.test(licence)) {
    throw new Error(`"${licenseNumber}" does not look like a Florida licence number.`)
  }

  const roster = await loadRoster()
  if (roster.subcontractors.some((s) => s.licenseNumber === licence)) {
    throw new Error(`${licence} is already on this roster.`)
  }

  const record = await lookupLicense(licence).catch(() => null)

  const entry = {
    name: record?.businessName && record.businessName !== '.' ? record.businessName : name || licence,
    licenseNumber: licence,
    trade: trade || inferTrade(record?.licenseType) || null,
    resolved: Boolean(record),
  }

  roster.subcontractors.push(entry)
  await saveRoster(roster)
  return { entry, found: Boolean(record), licenseType: record?.licenseType ?? null }
}

export async function removeOne(licenseNumber) {
  const roster = await loadRoster()
  const before = roster.subcontractors.length
  roster.subcontractors = roster.subcontractors.filter(
    (s) => s.licenseNumber !== String(licenseNumber).toUpperCase(),
  )
  await saveRoster(roster)
  return { removed: before - roster.subcontractors.length }
}

/**
 * Parse pasted text or CSV into roster entries.
 *
 * Tolerant on purpose: a licence number anywhere on a line is enough. Someone
 * pasting a column out of a spreadsheet should not have to reformat it first.
 */
export function parseLines(text) {
  const rows = []
  const seen = new Set()

  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = line.match(LICENCE)
    if (!match) continue

    const licence = match[1].toUpperCase()
    if (seen.has(licence)) continue
    seen.add(licence)

    // Whatever else is on the line is a name and possibly a trade.
    const rest = line
      .replace(match[1], '')
      .split(/[,\t;]/)
      .map((c) => c.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)

    // A trade column holds a single word — "roofing", "HVAC", "plumbing".
    // A company name may contain the same word without being one: "Gotcha
    // Covered Roofing LLC" and "Westdade Air" are names. So a cell counts as a
    // trade only when it is one word (or a known two-word trade), never merely
    // because a trade word appears somewhere inside it.
    const isTradeCell = (cell) =>
      (!/\s/.test(cell) && Boolean(inferTrade(cell))) || /^(air conditioning|a\/c)$/i.test(cell)
    const nameCells = rest.filter((cell) => !isTradeCell(cell) && /[a-z]{3}/i.test(cell))

    rows.push({
      licenseNumber: licence,
      // The longest non-trade cell is the likeliest name. It is only a hint:
      // whatever the registry returns wins when the licence resolves.
      name: nameCells.sort((a, b) => b.length - a.length)[0] ?? null,
      trade: rest.map((cell) => (isTradeCell(cell) ? inferTrade(cell) : null)).find(Boolean) ?? null,
    })
  }

  return rows
}

/**
 * Turn a Google Sheets link into its published CSV form.
 *
 * Accepts a normal /edit link or an already-published one. Returns null when it
 * is not a Sheets URL, so the caller can say so plainly rather than fetching
 * something unexpected.
 */
export function sheetCsvUrl(url) {
  const input = String(url ?? '').trim()
  if (!/docs\.google\.com\/spreadsheets/.test(input)) return null
  if (/output=csv|\/pub\?/.test(input)) return input

  const id = input.match(/\/d\/(?:e\/)?([a-zA-Z0-9-_]+)/)?.[1]
  if (!id) return null

  const gid = input.match(/[#&?]gid=(\d+)/)?.[1] ?? '0'
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`
}

/** Fetch a published sheet and parse it the same way pasted text is parsed. */
export async function fromSheet(url) {
  const csvUrl = sheetCsvUrl(url)
  if (!csvUrl) throw new Error('That is not a Google Sheets link.')

  const res = await fetch(csvUrl, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    throw new Error(
      'Could not read that sheet. In Google Sheets choose File → Share → Publish to web, ' +
        'or set link sharing to "Anyone with the link".',
    )
  }

  const body = await res.text()
  if (/<html/i.test(body)) {
    throw new Error('That sheet is private. Publish it to the web, or allow anyone with the link.')
  }

  return parseLines(body)
}

/**
 * Add many at once. Each licence is resolved against the registry, so importing
 * a list is also the first verification of it.
 */
export async function addMany(rows) {
  const results = { added: [], skipped: [], failed: [] }

  for (const row of rows) {
    try {
      const { entry, found } = await addOne(row)
      results.added.push({ ...entry, found })
    } catch (err) {
      if (/already on this roster/.test(err.message)) results.skipped.push(row.licenseNumber)
      else results.failed.push({ licenseNumber: row.licenseNumber, reason: err.message })
    }
  }

  return results
}
