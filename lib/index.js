/**
 * dsh-terminal-probe — host half.
 *
 * Plain loopback HTTP endpoints that the browser half posts terminal color
 * samples to and the agent reads back:
 *
 *   POST /api/terminal-probe/report        body: { samples: [...] } or a single
 *                                          sample object -> appended to
 *                                          $DSH_HOME/terminal-probe.jsonl
 *   GET  /api/terminal-probe/latest        last sample as JSON
 *   GET  /api/terminal-probe/reports?limit=N   trailing samples as a JSON array
 *   POST /api/terminal-probe/reset         truncate the probe file
 *
 * No dependencies beyond node built-ins and the injected webServer service.
 */

import { appendFileSync, existsSync, readFileSync, truncateSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const name = 'terminal-probe'

export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROBE_FILE = join(DSH_HOME, 'terminal-probe.jsonl')
const PROBE_RUN = join(DSH_HOME, 'terminal-probe-run.json')
const PROBE_REFRESH = join(DSH_HOME, 'terminal-probe-refresh.json')

function writeJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === ''
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : undefined)
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

function readTrailing(limit) {
  if (!existsSync(PROBE_FILE)) return []
  const text = readFileSync(PROBE_FILE, 'utf8')
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const out = []
  const take = Math.min(limit ?? 50, lines.length)
  for (const line of lines.slice(-take)) {
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip malformed line
    }
  }
  return out
}

export function apply(ctx) {
  const { webServer } = ctx

  const routes = [
    {
      kind: 'exact',
      path: '/api/terminal-probe/report',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'POST') !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        const body = await readJsonBody(req)
        if (body === undefined) return writeJson(res, 400, { error: 'invalid JSON body' })
        const items = Array.isArray(body?.samples) ? body.samples : [body]
        const lines = []
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          lines.push(JSON.stringify(item))
        }
        if (lines.length > 0) appendFileSync(PROBE_FILE, lines.join('\n') + '\n', 'utf8')
        writeJson(res, 200, { ok: true, stored: lines.length })
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/latest',
      handler: (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const all = readTrailing(1000)
        writeJson(res, 200, all.length > 0 ? all[all.length - 1] : null)
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/reports',
      handler: (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        const url = new URL(req.url ?? '/', 'http://localhost')
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10)
        writeJson(res, 200, { samples: readTrailing(Number.isFinite(limit) ? limit : 50) })
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/reset',
      handler: (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'POST') !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        if (existsSync(PROBE_FILE)) truncateSync(PROBE_FILE, 0)
        writeJson(res, 200, { ok: true })
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/run',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'POST') !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        const body = await readJsonBody(req)
        const url = new URL(req.url ?? '/', 'http://localhost')
        const qsSkins = url.searchParams.get('skins')
        const qsThemes = url.searchParams.get('themes')
        const skins = Array.isArray(body?.skins) && body.skins.length > 0 ? body.skins : (qsSkins ? qsSkins.split(',') : null)
        const themes = Array.isArray(body?.themes) && body.themes.length > 0 ? body.themes : (qsThemes ? qsThemes.split(',') : null)
        const run = {
          runId: Date.now(),
          ts: new Date().toISOString(),
          pending: true,
          skins,
          themes,
        }
        writeFileSync(PROBE_RUN, JSON.stringify(run), 'utf8')
        writeJson(res, 200, { ok: true, runId: run.runId })
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/run-state',
      handler: (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        let run = null
        if (existsSync(PROBE_RUN)) {
          try {
            run = JSON.parse(readFileSync(PROBE_RUN, 'utf8'))
          } catch {
            run = null
          }
        }
        writeJson(res, 200, run ?? { pending: false })
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/run-ack',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'POST') !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        const body = await readJsonBody(req)
        if (existsSync(PROBE_RUN)) {
          try {
            const runData = JSON.parse(readFileSync(PROBE_RUN, 'utf8'))
            if (body?.runId === runData.runId) {
              runData.pending = false
              writeFileSync(PROBE_RUN, JSON.stringify(runData), 'utf8')
            }
          } catch {
            // ignore
          }
        }
        writeJson(res, 200, { ok: true })
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/refresh',
      handler: (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'POST') !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        const state = { refreshId: Date.now(), ts: new Date().toISOString(), pending: true }
        writeFileSync(PROBE_REFRESH, JSON.stringify(state), 'utf8')
        writeJson(res, 200, { ok: true, refreshId: state.refreshId })
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/refresh-state',
      handler: (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        let state = null
        if (existsSync(PROBE_REFRESH)) {
          try {
            state = JSON.parse(readFileSync(PROBE_REFRESH, 'utf8'))
          } catch {
            state = null
          }
        }
        writeJson(res, 200, state ?? { pending: false })
      },
    },
    {
      kind: 'exact',
      path: '/api/terminal-probe/refresh-ack',
      handler: async (req, res) => {
        if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
        if ((req.method ?? 'POST') !== 'POST') return writeJson(res, 405, { error: `method not allowed: ${req.method}` })
        const body = await readJsonBody(req)
        if (existsSync(PROBE_REFRESH)) {
          try {
            const state = JSON.parse(readFileSync(PROBE_REFRESH, 'utf8'))
            if (body?.refreshId === state.refreshId) {
              state.pending = false
              writeFileSync(PROBE_REFRESH, JSON.stringify(state), 'utf8')
            }
          } catch {
            // ignore
          }
        }
        writeJson(res, 200, { ok: true })
      },
    },
  ]

  ctx.effect(() => {
    const disposers = routes.map((route) => webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'terminal-probe: routes')
}

export { PROBE_FILE }