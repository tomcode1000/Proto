/**
 * Telegram alerts.
 *
 * The rule here is restraint. A channel that pings on every clean run gets muted
 * within a fortnight, and a muted channel reports nothing at all, including the
 * one week it mattered. So by default Proto speaks only when something moved.
 *
 * Zero dependencies: Telegram's bot API is a plain HTTPS call.
 */

const API = 'https://api.telegram.org'
const TIMEOUT_MS = 15_000

/** Telegram's HTML mode, so a company name with an ampersand cannot break the message. */
const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function sendTelegram({ botToken, chatId }, text) {
  if (!botToken || !chatId) throw new Error('Telegram is not configured.')

  const res = await fetch(`${API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  const data = await res.json().catch(() => ({}))
  if (!data.ok) {
    // Telegram's own wording is more useful than anything paraphrased.
    throw new Error(data.description || `Telegram refused the message (HTTP ${res.status}).`)
  }
  return data.result
}

const pretty = (s) => String(s ?? '').replace(/_/g, ' ').toLowerCase()

/**
 * The first message anyone gets.
 *
 * A watch that says nothing until something breaks leaves the operator unsure it
 * is running at all, so the baseline reports what was found and states plainly
 * that from here on it will only speak up when something moves.
 */
export function composeBaseline(project, findings, schedule) {
  const bad = findings.filter((f) => f.exposure.level !== 'NONE')
  const lines = [`<b>${esc(project || 'Proto')}</b>`, '', `First check complete. ${findings.length} verified.`]

  if (bad.length) {
    lines.push('', `<b>${bad.length} need attention</b>`)
    for (const f of bad) {
      lines.push(
        `• ${esc(f.name)} (${esc(f.licenseNumber)}) is ${esc(pretty(f.license?.status ?? 'not found'))}. ${esc(f.exposure.level)}.`,
      )
    }
  } else {
    lines.push('', 'Everything on this roster is in good standing.')
  }

  lines.push('', schedule ? `From now on you will only hear from Proto when something changes. Next check ${esc(schedule)}.` : 'From now on you will only hear from Proto when something changes.')
  return lines.join('\n')
}

/**
 * Compose the alert.
 *
 * It leads with what got worse, because that is the only part anyone needs to
 * act on this morning. Recoveries follow, so the reader knows the picture is
 * complete rather than filtered.
 */
export function composeAlert(project, change) {
  const lines = [`<b>${esc(project || 'Proto')}</b>`]

  if (change.appeared.length) {
    lines.push('', `<b>Needs action now</b>`)
    for (const x of change.appeared) {
      lines.push(`• ${esc(x.name)} (${esc(x.licence)}) is ${esc(pretty(x.status))}, was ${esc(pretty(x.was))}.`)
    }
  }

  if (change.statusChanged.length) {
    lines.push('', `<b>Status moved</b>`)
    for (const x of change.statusChanged) {
      lines.push(`• ${esc(x.name)} went from ${esc(pretty(x.was))} to ${esc(pretty(x.status))}.`)
    }
  }

  if (change.resolved.length) {
    lines.push('', `<b>Back in good standing</b>`)
    for (const x of change.resolved) lines.push(`• ${esc(x.name)} is now ${esc(pretty(x.status))}.`)
  }

  lines.push('', `${change.unchanged} unchanged of ${change.total} checked.`)
  return lines.join('\n')
}

/**
 * Send the alert for a completed run, if there is anything worth sending.
 *
 * Returns what it decided and why, so the caller can log a skip instead of
 * wondering whether the message silently failed.
 */
export async function alertOnChange(roster, change, findings = []) {
  const cfg = roster?.notify?.telegram
  if (!cfg?.enabled) return { sent: false, reason: 'disabled' }
  if (!cfg.botToken || !cfg.chatId) return { sent: false, reason: 'not-configured' }

  // The very first completed run has nothing to compare against, but it is the
  // one the operator is waiting on. Report it, then go quiet.
  if (!change?.ready) {
    if (change?.reason !== 'first-run') return { sent: false, reason: 'no-runs' }
    const when = roster.schedule?.nextDue
      ? new Date(roster.schedule.nextDue).toLocaleString()
      : null
    await sendTelegram(cfg, composeBaseline(roster.project, findings, when))
    return { sent: true, kind: 'baseline' }
  }

  if (change.quiet && roster.notify.onlyOnChange !== false) return { sent: false, reason: 'quiet' }

  await sendTelegram(cfg, composeAlert(roster.project, change))
  return { sent: true, kind: 'change' }
}
