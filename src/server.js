/**
 * Control room.
 *
 * Serves the landing page and the application, and streams a live sweep over
 * server-sent events. The kill control aborts a run the way a closed laptop
 * would; starting again resumes from the journal rather than beginning over.
 *
 * Zero dependencies: Node's own http module.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { runSweep } from './sweeper.js'
import { recordRun, changes, timelineFor, load as loadHistory } from './history.js'
import { alertOnChange, sendTelegram } from './notify.js'
import { listProjects, createProject, setActive, deleteProject, activeId, migrateLegacyRoster } from './projects.js'
import {
  loadRoster,
  saveRoster,
  addOne,
  addMany,
  removeOne,
  parseLines,
  fromSheet,
  nextDueFrom,
  CADENCES,
} from './roster.js'

const PORT = Number(process.env.PORT ?? 8787)

/** The in-flight sweep, so it can be aborted from the browser. */
let current = null

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Pages share one icon sprite, injected at serve time so both surfaces are
 * guaranteed to be drawing from the same set rather than drifting apart.
 */
const page = async (res, file) => {
  const [html, icons] = await Promise.all([
    readFile(`public/${file}`, 'utf8'),
    readFile('public/icons.html', 'utf8'),
  ])
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html.replace('<body>', `<body>\n${icons}`))
}

async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Malformed request body.')
  }
}

/** Stamp the watch after a sweep actually finishes. */
async function markChecked() {
  const roster = await loadRoster()
  roster.schedule = { ...roster.schedule, lastRun: new Date().toISOString() }
  roster.schedule.nextDue = nextDueFrom(roster.schedule)
  await saveRoster(roster)
}

/**
 * The watch.
 *
 * A cadence nobody acts on is a preference, not a product, so the server checks
 * every few minutes whether the roster is due and runs it if so. The sweep is
 * consumed to completion here rather than streamed: there may be no browser open,
 * which is the entire point of scheduling it.
 */
function startWatch() {
  const TICK = 5 * 60_000

  setInterval(async () => {
    if (current) return // a run is already in flight

    const roster = await loadRoster().catch(() => null)
    if (!roster?.subcontractors.length) return
    if (!roster.schedule?.nextDue) return
    if (new Date(roster.schedule.nextDue) > new Date()) return

    console.log(`  scheduled check due, sweeping ${roster.subcontractors.length} subcontractors`)
    const controller = new AbortController()
    current = controller

    try {
      for await (const event of runSweep(roster, { signal: controller.signal })) {
        if (event.type === 'complete') {
          await recordRun(roster.project, event.findings)
          await markChecked()
          const alert = await alertOnChange(await loadRoster(), await changes()).catch((err) => ({
            sent: false,
            reason: err.message,
          }))
          console.log(
            `  scheduled check complete, ${event.needsAttention} need attention` +
              (alert.sent ? ', alert sent' : ''),
          )
        }
      }
    } catch (err) {
      console.error('  scheduled check failed:', err.message)
    } finally {
      current = null
    }
  }, TICK).unref()
}

async function streamSweep(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const roster = await loadRoster()

  if (!roster.subcontractors.length) {
    res.write(
      `data: ${JSON.stringify({ type: 'error', message: 'The roster is empty. Add subcontractors first.' })}\n\n`,
    )
    return res.end()
  }

  const controller = new AbortController()
  current = controller
  req.on('close', () => controller.abort())

  try {
    for await (const event of runSweep(roster, {
      fresh: url.searchParams.get('fresh') === '1',
      signal: controller.signal,
    })) {
      // A finished sweep is what re-dates the watch and enters the record. An
      // abandoned one must do neither, or a run that died at three of thirty
      // would pass for a clean bill of health.
      if (event.type === 'complete') {
        await recordRun(roster.project, event.findings)
        await markChecked()
        await alertOnChange(await loadRoster(), await changes()).catch((err) =>
          console.error('  alert failed:', err.message),
        )
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
  } finally {
    current = null
    res.end()
  }
}

async function brief(res) {
  const raw = await readFile('out/findings.json', 'utf8').catch(() => null)
  if (!raw) return json(res, 409, { error: 'Run a sweep first.' })

  const { project, findings } = JSON.parse(raw)
  const actionable = findings
    .filter((f) => f.exposure.level !== 'NONE')
    .map((f) => ({
      subcontractor: f.name,
      licenceNumber: f.licenseNumber,
      trade: f.trade,
      registryStatus: f.license?.statusRaw ?? 'not found',
      exposure: f.exposure.level,
      findings: f.exposure.reasons,
      recommendedAction: f.exposure.action,
    }))

  if (!actionable.length) {
    return json(res, 200, {
      triage: 'Nothing needs attention. Every licence on this roster is in good standing.',
    })
  }

  const { buildGraph } = await import('./graph.js')
  const graph = await buildGraph()
  const result = await graph.invoke(
    `Project: ${project}\n\nVerified findings:\n${JSON.stringify(actionable, null, 2)}`,
  )

  const nodes = {}
  for (const node of result.results ?? []) {
    nodes[node.nodeId] = (node.content ?? []).map((b) => b.text ?? '').join('').trim()
  }
  json(res, 200, nodes)
}

const routes = {
  'GET /': (req, res) => page(res, 'index.html'),
  'GET /app': (req, res) => page(res, 'app.html'),
  'GET /slides': (req, res) => page(res, 'slides.html'),
  'GET /api/sweep': streamSweep,

  'POST /api/kill': async (req, res) => {
    const wasRunning = Boolean(current)
    current?.abort()
    json(res, 200, { killed: wasRunning })
  },

  'POST /api/brief': (req, res) => brief(res),

  'GET /api/roster': async (req, res) => json(res, 200, await loadRoster()),

  /** Every site this contractor runs, and which one is open. */
  'GET /api/projects': async (req, res) =>
    json(res, 200, { active: await activeId(), projects: await listProjects() }),

  'POST /api/projects/create': async (req, res) => {
    const { name } = await body(req)
    const id = await createProject(String(name ?? '').trim())
    json(res, 200, { id, active: id })
  },

  'POST /api/projects/switch': async (req, res) => {
    const { id } = await body(req)
    if (current) current.abort() // never leave a sweep running against the project you just left
    json(res, 200, { active: await setActive(id) })
  },

  'POST /api/projects/delete': async (req, res) => {
    const { id } = await body(req)
    json(res, 200, await deleteProject(id))
  },

  'GET /api/cadences': async (req, res) => json(res, 200, CADENCES),

  /** What moved since the previous sweep, the reason a schedule is worth having. */
  'POST /api/notify/test': async (req, res) => {
    try {
      const { botToken, chatId } = await body(req)
      await sendTelegram({ botToken, chatId }, 'Proto is connected. You will hear from it when a licence moves.')
      json(res, 200, { ok: true })
    } catch (err) {
      json(res, 400, { error: err.message })
    }
  },

  /** What moved since the previous sweep, which is why a schedule is worth having. */
  'GET /api/changes': async (req, res) => json(res, 200, await changes()),

  /**
   * Look up any licence against the register, roster or not.
   *
   * Someone typing a number into the filter is usually asking a question about a
   * subcontractor they are considering, not one they have already added. Making
   * them add it first to find out would be the wrong order.
   */
  'GET /api/lookup': async (req, res) => {
    const { searchParams } = new URL(req.url, `http://localhost:${PORT}`)
    const licence = (searchParams.get('licence') ?? '').trim().toUpperCase()
    if (!/^[A-Z]{2,6}[0-9]{5,7}$/.test(licence)) {
      return json(res, 400, { error: `"${licence}" does not look like a Florida licence number.` })
    }
    try {
      const { lookupLicense, isDisqualifying } = await import('./connectors/dbpr.js')
      const record = await lookupLicense(licence)
      if (!record) return json(res, 200, { found: false, licenseNumber: licence })
      const roster = await loadRoster()
      json(res, 200, {
        found: true,
        ...record,
        disqualifying: isDisqualifying(record.status),
        onRoster: roster.subcontractors.some((x) => x.licenseNumber === licence),
      })
    } catch (err) {
      // The register not answering is not the same as the licence not existing.
      json(res, 503, { error: 'The state register did not answer. Try again in a moment.' })
    }
  },

  /** Recent runs, for the trend the dashboard draws. Real readings, never a shape. */
  'GET /api/runs': async (req, res) => {
    const { runs } = await loadHistory()
    json(
      res,
      200,
      runs.slice(-12).map((r) => ({ at: r.at, total: r.total, needsAttention: r.needsAttention })),
    )
  },

  /** The evidence, in the format that gets attached to an email. */
  'GET /api/export.csv': async (req, res) => {
    const raw = await readFile('out/findings.json', 'utf8').catch(() => null)
    if (!raw) return json(res, 409, { error: 'Run a sweep first.' })

    const { project, checkedAt, findings } = JSON.parse(raw)
    const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
    const rows = [
      ['Project', 'Checked at', 'Subcontractor', 'Licence', 'Type', 'Trade', 'Registry status', 'Expires', 'Exposure', 'Findings', 'Action', 'Source'],
      ...findings.map((f) => [
        project, checkedAt, f.name, f.licenseNumber,
        f.license?.licenseType ?? '', f.trade ?? '',
        f.license?.statusRaw ?? 'not found', f.license?.expirationDate ?? '',
        f.exposure.level, f.exposure.reasons.join(' '), f.exposure.action,
        f.license?.sourceUrl ?? '',
      ]),
    ]

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="proto-findings.csv"',
    })
    // Spreadsheets on Windows expect CRLF, which is where this file is opened.
    res.end(rows.map((r) => r.map(cell).join(',')).join('\r\n'))
  },

  /** One subcontractor's readings over time, collapsed to the moments it moved. */
  'GET /api/timeline': async (req, res) => {
    const { searchParams } = new URL(req.url, `http://localhost:${PORT}`)
    const licence = searchParams.get('licence')
    if (!licence) return json(res, 400, { error: 'licence is required' })
    json(res, 200, await timelineFor(licence))
  },

  'POST /api/roster/project': async (req, res) => {
    const patch = await body(req)
    const roster = await loadRoster()
    for (const key of ['project', 'generalContractor', 'county']) {
      if (patch[key] != null) roster[key] = patch[key]
    }
    if (patch.notify) roster.notify = { ...roster.notify, ...patch.notify }
    if (patch.timeOfDay != null) roster.schedule = { ...roster.schedule, timeOfDay: patch.timeOfDay }
    if (patch.dayOfWeek != null) roster.schedule = { ...roster.schedule, dayOfWeek: Number(patch.dayOfWeek) }
    if (patch.cadence != null) {
      // Changing the cadence re-dates the next check from now, so a person who
      // switches from monthly to weekly is not left waiting out the old month.
      roster.schedule = { ...roster.schedule, cadence: patch.cadence }
      roster.schedule.nextDue = nextDueFrom(roster.schedule)
    }
    json(res, 200, await saveRoster(roster))
  },

  'POST /api/roster/add': async (req, res) => {
    try {
      json(res, 200, await addOne(await body(req)))
    } catch (err) {
      json(res, 400, { error: err.message })
    }
  },

  'POST /api/roster/remove': async (req, res) => {
    const { licenseNumber } = await body(req)
    json(res, 200, await removeOne(licenseNumber))
  },

  /** Parse without committing, so the operator sees what will be added. */
  'POST /api/roster/preview': async (req, res) => {
    try {
      const { text, sheetUrl } = await body(req)
      const rows = sheetUrl ? await fromSheet(sheetUrl) : parseLines(text)
      json(res, 200, { rows, count: rows.length })
    } catch (err) {
      json(res, 400, { error: err.message })
    }
  },

  'POST /api/roster/import': async (req, res) => {
    try {
      const { text, sheetUrl, rows } = await body(req)
      const parsed = rows ?? (sheetUrl ? await fromSheet(sheetUrl) : parseLines(text))
      json(res, 200, await addMany(parsed))
    } catch (err) {
      json(res, 400, { error: err.message })
    }
  },
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`)
  const handler = routes[`${req.method} ${pathname}`]

  try {
    if (handler) return await handler(req, res)
    json(res, 404, { error: 'not found' })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}).listen(PORT, async () => {
  console.log(`\n  Proto  →  http://localhost:${PORT}`)
  const { schedule } = await loadRoster().catch(() => ({ schedule: null }))
  const cadence = CADENCES[schedule?.cadence]
  console.log(`  Watch: ${cadence ? cadence.label.toLowerCase() : 'not set'}\n`)
  startWatch()
})
