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
import { loadRoster, saveRoster, addOne, addMany, removeOne, parseLines, fromSheet } from './roster.js'

const PORT = Number(process.env.PORT ?? 8787)

/** The in-flight sweep, so it can be aborted from the browser. */
let current = null

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const page = async (res, file) => {
  const html = await readFile(`public/${file}`, 'utf8')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
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
  'GET /api/sweep': streamSweep,

  'POST /api/kill': async (req, res) => {
    const wasRunning = Boolean(current)
    current?.abort()
    json(res, 200, { killed: wasRunning })
  },

  'POST /api/brief': (req, res) => brief(res),

  'GET /api/roster': async (req, res) => json(res, 200, await loadRoster()),

  'POST /api/roster/project': async (req, res) => {
    const patch = await body(req)
    const roster = await loadRoster()
    for (const key of ['project', 'generalContractor', 'county']) {
      if (patch[key] != null) roster[key] = patch[key]
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
}).listen(PORT, () => {
  console.log(`\n  Proto  →  http://localhost:${PORT}\n`)
})
