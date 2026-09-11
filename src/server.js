/**
 * Control room.
 *
 * Serves the dashboard and streams a live sweep over server-sent events. The
 * kill button aborts the run the way a closed laptop would; pressing start again
 * resumes from the journal rather than beginning over.
 *
 * Zero dependencies: Node's own http module.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { runSweep } from './sweeper.js'

const PORT = Number(process.env.PORT ?? 8787)
const ROSTER = process.env.PROTO_ROSTER ?? 'data/roster.json'

/** The in-flight sweep, so it can be aborted from the browser. */
let current = null

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function streamSweep(req, res, { fresh }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const roster = JSON.parse(await readFile(ROSTER, 'utf8'))
  const controller = new AbortController()
  current = controller
  req.on('close', () => controller.abort())

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)

  try {
    for await (const event of runSweep(roster, { fresh, signal: controller.signal })) {
      send(event)
    }
  } catch (err) {
    send({ type: 'error', message: err.message })
  } finally {
    current = null
    res.end()
  }
}

async function brief(res) {
  const { buildGraph } = await import('./graph.js')
  const { project, findings } = JSON.parse(await readFile('out/findings.json', 'utf8').catch(() => 'null')) ?? {}
  if (!findings) return json(res, 409, { error: 'Run a sweep first.' })

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

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  try {
    if (url.pathname === '/') {
      const html = await readFile('public/index.html', 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }

    if (url.pathname === '/api/sweep') {
      return streamSweep(req, res, { fresh: url.searchParams.get('fresh') === '1' })
    }

    if (url.pathname === '/api/kill' && req.method === 'POST') {
      const wasRunning = Boolean(current)
      current?.abort()
      return json(res, 200, { killed: wasRunning })
    }

    if (url.pathname === '/api/brief' && req.method === 'POST') {
      return brief(res)
    }

    json(res, 404, { error: 'not found' })
  } catch (err) {
    json(res, 500, { error: err.message })
  }
}).listen(PORT, () => {
  console.log(`\n  Proto control room  →  http://localhost:${PORT}\n`)
})
