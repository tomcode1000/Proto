/**
 * Permit activity, by contractor licence number.
 *
 * This is the signal that separates a dangerous lapse from a cosmetic one. A
 * licence that expired while carrying live permits means work in progress on a
 * dead credential. The same licence with no permits in two years is paperwork.
 *
 * Counties publish permits through ArcGIS Feature Services. The join key is the
 * contractor number on the permit, which is the DBPR licence number.
 *
 * Zero dependencies: Node built-ins only.
 */

const TIMEOUT_MS = 30_000
const MIN_GAP_MS = 250

let lastRequestAt = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Pace requests to a public service, and keep results reproducible under load. */
async function throttle() {
  const wait = MIN_GAP_MS - (Date.now() - lastRequestAt)
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

/**
 * County permit sources. Adding a county is adding an entry here — the field
 * names differ per county, so they are declared rather than assumed.
 */
export const COUNTY_SOURCES = {
  'MIAMI-DADE': {
    label: 'Miami-Dade',
    url: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_permit_data/FeatureServer/0/query',
    contractorField: 'ContractorNumber',
    dateField: 'ApplicationDate',
  },
}

function buildQuery(source, licenseNumber, fromYear, toYear) {
  const params = new URLSearchParams({
    where:
      `${source.contractorField} = '${String(licenseNumber).toUpperCase()}' ` +
      `AND ${source.dateField} >= DATE '${fromYear}-01-01' ` +
      `AND ${source.dateField} < DATE '${toYear + 1}-01-01'`,
    outFields: `${source.contractorField},${source.dateField}`,
    returnGeometry: 'false',
    resultRecordCount: '2000',
    f: 'json',
  })
  return `${source.url}?${params}`
}

/**
 * Permit activity for one licence over a window of years.
 *
 * @param {string} licenseNumber DBPR licence number, e.g. "CCC1330456"
 * @param {object} [opts]
 * @param {string} [opts.county="MIAMI-DADE"]
 * @param {number} [opts.years=3] how many years back to look, inclusive of this year
 * @returns {Promise<{licenseNumber:string,county:string,byYear:Record<string,number>,
 *   totalPermits:number,mostRecentPermit:string|null,currentYearPermits:number}>}
 */
export async function getPermitActivity(licenseNumber, opts = {}) {
  const countyKey = (opts.county ?? 'MIAMI-DADE').toUpperCase()
  const source = COUNTY_SOURCES[countyKey]
  if (!source) {
    throw new Error(
      `No permit source configured for county "${countyKey}". ` +
        `Available: ${Object.keys(COUNTY_SOURCES).join(', ')}`,
    )
  }

  const thisYear = new Date().getUTCFullYear()
  const fromYear = thisYear - ((opts.years ?? 3) - 1)

  await throttle()
  const res = await fetch(buildQuery(source, licenseNumber, fromYear, thisYear), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Permit service returned HTTP ${res.status} for ${countyKey}`)

  const data = await res.json()
  if (data.error) throw new Error(`Permit query error: ${data.error.message ?? 'unknown'}`)

  // A truncated page would silently under-count permits, which under-scores
  // exposure and could hide a critical finding. Refuse the result instead.
  if (data.exceededTransferLimit) {
    throw new Error(
      `Permit service truncated results for ${licenseNumber} — refusing a partial count.`,
    )
  }

  const features = data.features ?? []
  const byYear = {}
  for (let y = fromYear; y <= thisYear; y++) byYear[y] = 0

  let mostRecent = null
  for (const f of features) {
    const ms = f.attributes?.[source.dateField]
    if (typeof ms !== 'number') continue
    const d = new Date(ms)
    const y = d.getUTCFullYear()
    if (y in byYear) byYear[y] += 1
    if (mostRecent === null || ms > mostRecent) mostRecent = ms
  }

  const monthsSince =
    mostRecent === null ? null : Math.floor((Date.now() - mostRecent) / (30.44 * 86_400_000))

  return {
    licenseNumber: String(licenseNumber).toUpperCase(),
    county: source.label,
    byYear,
    totalPermits: features.length,
    currentYearPermits: byYear[thisYear] ?? 0,
    mostRecentPermit: mostRecent ? new Date(mostRecent).toISOString().slice(0, 10) : null,
    /**
     * Months since the last permit. This, not the current-year count, is what
     * indicates open work: a lapsed licence cannot pull new permits (the county
     * blocks it), so the exposure is always work started while the licence was
     * healthy and still running after it died.
     */
    monthsSinceLastPermit: monthsSince,
  }
}
