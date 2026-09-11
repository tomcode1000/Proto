/**
 * Florida DBPR licence verification.
 *
 * Reads the state's public licensee portal — the registry of record — rather
 * than any cached copy of it. Proto exists because a licence can change status
 * between one check and the next, so this module never memoises a result.
 *
 * The portal is an ASP.NET app with a rotating antiforgery token, so a lookup is
 * three requests sharing one cookie jar:
 *
 *   1. GET  /portalsearches/VerifyLicensee                      -> token A
 *   2. POST /portalsearches/VerifyLicensee/SearchByLicenseNumber -> token B
 *   3. POST /portalsearches/VerifyLicensee/Results               -> results HTML
 *
 * Zero dependencies: Node built-ins only.
 */

const BASE = 'https://www.myfloridalicense.com'
const APP = '/portalsearches/VerifyLicensee'
const UA = 'Mozilla/5.0 (compatible; Proto/0.1; +licence-compliance-checker)'
const MIN_GAP_MS = 1200
const TIMEOUT_MS = 30_000

let lastRequestAt = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Keep a courteous gap between requests to a public government service. */
async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt)
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/** Minimal cookie jar: absorbs Set-Cookie, replays as a Cookie header. */
function makeJar() {
  const jar = new Map()
  return {
    absorb(res) {
      const lines =
        typeof res.headers.getSetCookie === 'function'
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean)
      for (const line of lines) {
        const [pair] = line.split(';')
        const eq = pair.indexOf('=')
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  }
}

function extractToken(html) {
  const m =
    html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/) ||
    html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/)
  return m?.[1] ?? null
}

async function request(jar, url, { method = 'GET', body = null } = {}) {
  await throttle()
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      ...(jar.header() ? { Cookie: jar.header() } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  })
  jar.absorb(res)
  if (!res.ok) throw new Error(`DBPR returned HTTP ${res.status} for ${url}`)
  return res.text()
}

const decodeEntities = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const text = (s) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

/**
 * Collapse the portal's free-text status into the states Proto reasons about.
 * Exposure scoring depends on this, so it stays a pure function and the raw
 * string is always carried alongside for audit.
 */
export function classifyStatus(raw) {
  const s = String(raw ?? '').toUpperCase()
  if (s.includes('NULL') && s.includes('VOID')) return 'NULL_AND_VOID'
  if (s.includes('SUSPEND')) return 'SUSPENDED'
  if (s.includes('REVOK')) return 'REVOKED'
  if (s.includes('DELINQ')) return 'DELINQUENT'
  if (s.includes('DECEASED')) return 'DECEASED'
  if (s.includes('RELINQUISH')) return 'RELINQUISHED'
  if (s.includes('EXPIRE')) return 'EXPIRED'
  if (s.includes('INACTIVE')) return 'INACTIVE'
  if (s.includes('CURRENT') || s.includes('ACTIVE')) return 'ACTIVE'
  return 'UNKNOWN'
}

/** True when the licence cannot lawfully support work right now. */
export function isDisqualifying(status) {
  return [
    'NULL_AND_VOID',
    'SUSPENDED',
    'REVOKED',
    'DELINQUENT',
    'EXPIRED',
    'DECEASED',
    'RELINQUISHED',
  ].includes(status)
}

function parseResults(html) {
  const count = html.match(/Search Results - ([\d,]+) Records?/)
  if (!count) throw new Error('DBPR_SHAPE_CHANGED: results header missing')

  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1])
  const records = []

  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1])
    if (cells.length < 5 || /License Type/.test(row)) continue

    const licCell = text(cells[3])
    const lic = licCell.match(/\b([A-Z]{2,6}\d{5,7})\b/)
    if (!lic) continue

    const [statusRaw, expiresRaw] = cells[4].split(/<br\s*\/?>/i)
    const id =
      cells[1].match(/name="ID"[^>]*value="([^"]+)"/) ||
      cells[1].match(/value="([^"]+)"[^>]*name="ID"/)

    records.push({
      licenseType: text(cells[0]),
      name: text(cells[1]),
      nameType: text(cells[2]),
      licenseNumber: lic[1],
      qualifier: licCell.replace(lic[1], '').trim(),
      statusRaw: text(statusRaw).replace(/,+$/, ''),
      expirationDate: expiresRaw ? text(expiresRaw) : '',
      detailId: id?.[1] ?? null,
    })
  }

  return { totalRecords: Number(count[1].replace(/,/g, '')), records }
}

/**
 * Look up one licence number against the live registry.
 *
 * @param {string} licenseNumber e.g. "CAC1816423"
 * @returns {Promise<object|null>} null when the registry holds no such licence
 */
export async function lookupLicense(licenseNumber) {
  const jar = makeJar()

  const entry = await request(jar, `${BASE}${APP}`)
  const tokenA = extractToken(entry)
  if (!tokenA) throw new Error('DBPR_SHAPE_CHANGED: no antiforgery token on entry page')

  const form = await request(jar, `${BASE}${APP}/SearchByLicenseNumber`, {
    method: 'POST',
    body: { __RequestVerificationToken: tokenA, BoardType: '', SearchType: 'SearchByLicenseNumber' },
  })
  const tokenB = extractToken(form)
  if (!tokenB) throw new Error('DBPR_SHAPE_CHANGED: no token on search form')

  const html = await request(jar, `${BASE}${APP}/Results`, {
    method: 'POST',
    body: {
      __RequestVerificationToken: tokenB,
      BoardType: '',
      SearchType: 'SearchByLicenseNumber',
      LicNbr: String(licenseNumber).toUpperCase().trim(),
      SearchHistoric: 'N',
    },
  })

  const { records } = parseResults(html)
  if (records.length === 0) return null

  // One licence number can return several rows (business DBA + qualifying agent).
  const business = records.find((r) => r.nameType.toUpperCase() === 'DBA') ?? records[0]
  const person = records.find((r) => r !== business) ?? business

  return {
    licenseNumber: business.licenseNumber,
    licenseType: business.licenseType,
    businessName: business.name,
    qualifierName: person !== business ? person.name : business.qualifier || business.name,
    status: classifyStatus(business.statusRaw),
    statusRaw: business.statusRaw,
    expirationDate: business.expirationDate,
    sourceUrl: business.detailId
      ? `${BASE}${APP}/LicenseDetail?ID=${business.detailId}`
      : `${BASE}${APP}`,
    checkedAt: new Date().toISOString(),
  }
}

// ── County search ────────────────────────────────────────────────────────────

/** CILB board code, and the profession codes Proto cares about. */
export const BOARD_CILB = '06'
export const LICENSE_TYPES = {
  '0601': 'Certified Air Conditioning Contractor',
  '0602': 'Certified Building Contractor',
  '0603': 'Certified Roofing Contractor',
  '0604': 'Certified Plumbing Contractor',
  '0605': 'Certified General Contractor',
  '0607': 'Certified Pool/Spa Contractor',
  '0608': 'Certified Residential Contractor',
}

/** DBPR county codes (subset Proto uses; the portal's own select values). */
export const COUNTY_CODES = { 'MIAMI-DADE': '23', BROWARD: '16', 'PALM BEACH': '60' }

/** The results page carries its own pager state, which the server validates. */
function extractPagerFields(html) {
  const forms = [...html.matchAll(/<form action="\/portalsearches\/VerifyLicensee\/Results"[^>]*>([\s\S]*?)<\/form>/g)]
  const form = forms.at(-1)?.[1]
  if (!form) throw new Error('DBPR_SHAPE_CHANGED: pager form missing')
  const fields = {}
  for (const input of form.matchAll(/<input[^>]*>/g)) {
    const name = input[0].match(/name="([^"]*)"/)?.[1]
    const type = input[0].match(/type="([^"]*)"/)?.[1]
    if (!name || type === 'submit' || type === 'radio') continue
    fields[name] = input[0].match(/value="([^"]*)"/)?.[1] ?? ''
  }
  return fields
}

/**
 * Walk a county's licence roll for one profession.
 * `licenseType` is required — the portal returns zero records without it.
 *
 * @returns {Promise<{total:number, records:object[]}>}
 */
export async function searchCounty({ county, licenseType, maxPages = 1 }) {
  const countyCode = COUNTY_CODES[String(county).toUpperCase()]
  if (!countyCode) throw new Error(`Unknown county "${county}"`)
  if (!licenseType) throw new Error('licenseType is required (the portal returns nothing without it)')

  const jar = makeJar()
  const entry = await request(jar, `${BASE}${APP}`)
  const tokenA = extractToken(entry)

  const form = await request(jar, `${BASE}${APP}/SearchByCity`, {
    method: 'POST',
    body: { __RequestVerificationToken: tokenA, BoardType: '', SearchType: 'SearchByCity' },
  })
  const tokenB = extractToken(form)

  let html = await request(jar, `${BASE}${APP}/Results`, {
    method: 'POST',
    body: {
      __RequestVerificationToken: tokenB,
      BoardType: '',
      SearchType: 'SearchByCity',
      Board: BOARD_CILB,
      LicenseType: licenseType,
      City: '',
      County: countyCode,
      State: 'FL',
      SpecQual: '',
      SearchHistoric: 'N',
      RecordsPerPage: '50',
    },
  })

  const all = []
  let total = 0
  for (let page = 1; page <= maxPages; page++) {
    const parsed = parseResults(html)
    total = parsed.totalRecords
    all.push(...parsed.records)
    if (page >= maxPages || parsed.records.length === 0) break
    const pager = extractPagerFields(html)
    pager.TypePagination = 'NEXT'
    html = await request(jar, `${BASE}${APP}/Results`, { method: 'POST', body: pager })
  }

  const records = all.map((r) => ({
    licenseNumber: r.licenseNumber,
    businessName: r.name,
    licenseType: r.licenseType,
    status: classifyStatus(r.statusRaw),
    statusRaw: r.statusRaw,
    expirationDate: r.expirationDate,
    nameType: r.nameType,
  }))

  return { total, records }
}
