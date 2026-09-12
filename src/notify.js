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

/** One subcontractor, as a line someone can act on without opening anything. */
function line(f) {
  const lic = f.license
  const bits = [
    `<b>${esc(f.name)}</b>`,
    `  ${esc(f.licenseNumber)}${f.trade ? `, ${esc(f.trade)}` : ''}`,
  ]

  if (!lic) {
    bits.push('  Not found in the register. Treat as unverified.')
    return bits.join('\n')
  }

  bits.push(`  ${esc(lic.statusRaw)}${lic.expirationDate ? `, expires ${esc(lic.expirationDate)}` : ''}`)
  if (lic.licenseType) bits.push(`  ${esc(lic.licenseType)}`)

  if (f.exposure.level !== 'NONE') {
    // The reasons are the whole point of scoring deterministically, and this is
    // the one surface with no interface to click into. Sending a severity
    // without them invites the reader to guess from whatever else is on the
    // line: a suspended licence expiring in 2028 reads as though the date
    // decided it, when the date had nothing to do with it.
    bits.push(`  <b>${esc(f.exposure.level)}</b>`)
    for (const reason of f.exposure.reasons) bits.push(`    ${esc(reason)}`)
    bits.push(`  Do this: ${esc(f.exposure.action)}`)
  }
  return bits.join('\n')
}

/**
 * The first message anyone gets.
 *
 * A watch that says nothing until something breaks leaves the operator unsure it
 * is running at all. The baseline is the full picture, every subcontractor with
 * its number, class, status and expiry, because this is the one message where
 * the reader has no prior state to compare against and needs the whole roster in
 * front of them. Everything after it is an exception report.
 */
export function composeBaseline(project, findings, nextCheck) {
  const bad = findings.filter((f) => f.exposure.level !== 'NONE')
  const ok = findings.filter((f) => f.exposure.level === 'NONE')

  const out = [
    `<b>${esc(project || 'Proto')}</b>`,
    `First check complete. ${findings.length} subcontractor${findings.length === 1 ? '' : 's'} verified against the state register.`,
  ]

  if (bad.length) {
    out.push('', `<b>NEEDS ATTENTION, ${bad.length}</b>`)
    for (const f of bad) out.push('', line(f))
  }

  if (ok.length) {
    out.push('', `<b>IN GOOD STANDING, ${ok.length}</b>`)
    for (const f of ok) out.push('', line(f))
  }

  out.push('', ',')
  out.push(
    nextCheck
      ? `Next check ${esc(nextCheck)}. From now on Proto reports only what changes, and tells you when a check finds nothing.`
      : 'From now on Proto reports only what changes, and tells you when a check finds nothing.',
  )
  return out.join('\n')
}

/**
 * Nothing moved.
 *
 * Reported rather than swallowed, because a channel that only ever speaks with
 * bad news gives the reader no way to tell working from broken. It is careful
 * not to say "all clear" when findings are still outstanding from a previous
 * check: nothing changing is not the same as nothing being wrong.
 */
export function composeQuiet(project, findings, nextCheck) {
  const outstanding = findings.filter((f) => f.exposure.level !== 'NONE')

  const out = [`<b>${esc(project || 'Proto')}</b>`]

  if (!outstanding.length) {
    out.push(
      '',
      `All clear. ${findings.length} subcontractor${findings.length === 1 ? '' : 's'} checked, every licence in good standing, nothing changed since the last check.`,
    )
  } else {
    out.push(
      '',
      `Nothing changed since the last check. ${findings.length} checked, but ${outstanding.length} still ${outstanding.length === 1 ? 'needs' : 'need'} attention:`,
    )
    for (const f of outstanding) out.push('', line(f))
  }

  if (nextCheck) out.push('', `Next check ${esc(nextCheck)}.`)
  return out.join('\n')
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

  const when = roster.schedule?.nextDue
    ? new Date(roster.schedule.nextDue).toLocaleString()
    : null

  // A quiet check is still a check, and saying so is what makes the silence in
  // between trustworthy.
  if (change.quiet) {
    await sendTelegram(cfg, composeQuiet(roster.project, findings, when))
    return { sent: true, kind: 'quiet' }
  }

  await sendTelegram(cfg, composeAlert(roster.project, change))
  return { sent: true, kind: 'change' }
}
