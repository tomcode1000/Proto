/**
 * Exposure scoring.
 *
 * Pure functions, no network, no model. Every reason Proto gives is recomputed
 * from the record in front of it, so the explanation can never drift from the
 * evidence. This is deliberate: a language model narrating its own reasoning
 * about money and liability is the failure mode this project exists to avoid.
 *
 * The judgement being made is not "is this licence expiring", a calendar can
 * do that. It is "is this licence carrying work right now", which needs the
 * registry and the permit record together.
 */

import { isDisqualifying } from '../connectors/dbpr.js'

export const LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

/** Days from today until a DBPR date string (MM/DD/YYYY). Null when unparseable. */
export function daysUntil(dateStr, today = new Date()) {
  const m = String(dateStr ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null
  const [, mm, dd, yyyy] = m
  const target = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((target - now) / 86_400_000)
}

/**
 * Score one subcontractor's exposure to the general contractor.
 *
 * @param {object} input
 * @param {object|null} input.license  record from the DBPR connector, or null if not found
 * @param {object|null} input.permits  record from the permit connector, or null if unchecked
 * @param {string} [input.trade]       trade this sub is engaged for, if known
 * @param {Date}   [input.today]
 * @returns {{level:string, score:number, reasons:string[], action:string, carryingWork:boolean}}
 */
export function scoreExposure({ license, permits, trade, today = new Date() }) {
  const reasons = []

  if (!license) {
    return {
      level: 'HIGH',
      score: 70,
      carryingWork: false,
      reasons: ['No matching licence in the state registry, standing cannot be confirmed.'],
      action: 'Confirm the licence number with the subcontractor before any further work or payment.',
    }
  }

  const days = daysUntil(license.expirationDate, today)
  const dead = isDisqualifying(license.status)
  const current = permits?.currentYearPermits ?? 0
  const total = permits?.totalPermits ?? 0
  const latest = permits?.mostRecentPermit ?? null
  const monthsSince = permits?.monthsSinceLastPermit ?? null

  // Work plausibly still open. A lapsed licence cannot pull new permits, so
  // recency of the last permit, not a current-year count, is the signal that
  // a job is running under a credential that has since died.
  const openWork = monthsSince !== null && monthsSince <= 24
  const carryingWork = current > 0 || openWork

  // Risk comes from the licence's standing. Work in progress is an amplifier of
  // that risk, never a source of it: a healthy licence carrying twenty permits
  // is the normal case, not a finding.
  let score = 0

  if (dead) {
    // A dead licence is dead whether or not work is running under it.
    score += 60
    reasons.push(`Licence status is ${license.status.replace(/_/g, ' ')} (registry reads "${license.statusRaw}").`)
  } else if (days !== null && days <= 60) {
    // A deadline only matters to the extent work depends on it. A renewal date
    // on a subcontractor who has pulled nothing is administrative, not exposure.
    const base = days <= 30 ? 30 : 15
    score += carryingWork ? base : Math.round(base / 2)
    reasons.push(
      `Licence expires in ${days} day${days === 1 ? '' : 's'} (${license.expirationDate})` +
        (carryingWork ? '.' : ', with no work currently running under it.'),
    )
  }

  if (trade && license.licenseType && !licenseCoversTrade(license.licenseType, trade)) {
    score += 20
    reasons.push(`Engaged for ${trade}, but the licence held is "${license.licenseType}".`)
  }

  // Permit activity: scored only when something is already wrong, reported always.
  if (carryingWork) {
    const line =
      current > 0
        ? `${current} permit${current === 1 ? '' : 's'} pulled under this licence this year` +
          (latest ? `, most recently ${latest}.` : '.')
        : `${total} permit${total === 1 ? '' : 's'} on record, the last ${monthsSince} months ago (${latest}), ` +
          'work from that job may still be open.'
    if (score > 0) {
      // Recent work weighs more than old work: a job from eight months ago is
      // far likelier to still be running than one from two years ago.
      score += monthsSince !== null && monthsSince > 12 ? 15 : 30
      reasons.push(line)
      if (dead) {
        score += 10
        reasons.push('Work is in progress on a licence that cannot lawfully support it.')
      }
    } else {
      reasons.push(`${line} Licence is in good standing, so this is context, not exposure.`)
    }
  } else if (total > 0 && score > 0) {
    reasons.push(`${total} permits in the last three years, none this year${latest ? ` (last ${latest})` : ''}.`)
  }

  if (reasons.length === 0) {
    reasons.push(`Licence is ${license.status.toLowerCase()} and valid through ${license.expirationDate}.`)
  }

  return { level: levelFor(score), score, carryingWork, reasons, action: actionFor(score, dead, carryingWork) }
}

function levelFor(score) {
  if (score >= 85) return 'CRITICAL'
  if (score >= 55) return 'HIGH'
  if (score >= 30) return 'MEDIUM'
  if (score > 0) return 'LOW'
  return 'NONE'
}

function actionFor(score, dead, carryingWork) {
  if (dead && carryingWork) return 'Stop work and withhold the next draw until the licence is reinstated.'
  if (dead) return 'Do not schedule or pay this subcontractor until the licence is reinstated.'
  if (score >= 30) return 'Request proof of renewal before the next draw.'
  if (score > 0) return 'Monitor, no action needed this cycle.'
  return 'None.'
}

/** Rough trade/licence-class agreement. Deliberately conservative. */
export function licenseCoversTrade(licenseType, trade) {
  const t = String(trade).toLowerCase()
  const l = String(licenseType).toLowerCase()
  if (/roof/.test(t)) return /roofing|general|building/.test(l)
  if (/air|hvac|mechanic/.test(t)) return /air conditioning|mechanical/.test(l)
  if (/plumb/.test(t)) return /plumbing/.test(l)
  if (/electric/.test(t)) return /electric/.test(l)
  if (/pool|spa/.test(t)) return /pool/.test(l)
  return true // unknown trade: do not manufacture a finding
}

/** Rank scored subs so the dangerous ones surface above the merely expiring. */
export function rankByExposure(scored) {
  return [...scored].sort(
    (a, b) =>
      b.exposure.score - a.exposure.score ||
      Number(b.exposure.carryingWork) - Number(a.exposure.carryingWork) ||
      a.name.localeCompare(b.name),
  )
}
