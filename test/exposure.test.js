import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreExposure, daysUntil, rankByExposure, licenseCoversTrade } from '../src/engine/exposure.js'

const TODAY = new Date('2026-09-11T00:00:00Z')

const active = (over = {}) => ({
  licenseNumber: 'CCC1330456',
  licenseType: 'Certified Roofing Contractor',
  businessName: 'GOTCHA COVERED ROOFING, LLC',
  status: 'ACTIVE',
  statusRaw: 'Current, Active',
  expirationDate: '08/31/2028',
  ...over,
})

const permits = (over = {}) => ({
  licenseNumber: 'CCC1330456',
  byYear: { 2024: 0, 2025: 0, 2026: 0 },
  totalPermits: 0,
  currentYearPermits: 0,
  mostRecentPermit: null,
  ...over,
})

test('daysUntil parses DBPR dates and handles junk', () => {
  assert.equal(daysUntil('09/21/2026', TODAY), 10)
  assert.equal(daysUntil('09/11/2026', TODAY), 0)
  assert.equal(daysUntil('', TODAY), null)
  assert.equal(daysUntil('2026-09-21', TODAY), null)
})

test('a healthy licence with no work scores NONE', () => {
  const r = scoreExposure({ license: active(), permits: permits(), today: TODAY })
  assert.equal(r.level, 'NONE')
  assert.equal(r.score, 0)
})

test('delinquent licence carrying current work is CRITICAL', () => {
  const r = scoreExposure({
    license: active({ status: 'DELINQUENT', statusRaw: 'Delinquent, Active' }),
    permits: permits({ currentYearPermits: 9, totalPermits: 14, mostRecentPermit: '2026-08-02' }),
    today: TODAY,
  })
  assert.equal(r.level, 'CRITICAL')
  assert.equal(r.carryingWork, true)
  assert.match(r.action, /Stop work/)
  assert.ok(r.reasons.some((x) => /9 permits/.test(x)), 'cites the real permit count')
})

test('the demo contrast: dangerous lapse outranks cosmetic expiry', () => {
  const dangerous = {
    name: 'Roofing sub',
    exposure: scoreExposure({
      license: active({ status: 'DELINQUENT', statusRaw: 'Delinquent' }),
      permits: permits({ currentYearPermits: 9, totalPermits: 12, mostRecentPermit: '2026-08-02' }),
      today: TODAY,
    }),
  }
  const cosmetic = {
    name: 'Dormant registered sub',
    exposure: scoreExposure({
      license: active({ expirationDate: '10/05/2026' }),
      permits: permits(),
      today: TODAY,
    }),
  }
  const ranked = rankByExposure([cosmetic, dangerous])
  assert.equal(ranked[0].name, 'Roofing sub')
  assert.equal(ranked[0].exposure.level, 'CRITICAL')
  assert.equal(ranked[1].exposure.level, 'LOW')
})

test('a missing licence is exposure, not absence of it', () => {
  const r = scoreExposure({ license: null, permits: null, today: TODAY })
  assert.equal(r.level, 'HIGH')
  assert.match(r.reasons[0], /cannot be confirmed/)
})

test('scope mismatch is flagged, unknown trades are not invented', () => {
  const mismatch = scoreExposure({ license: active(), permits: permits(), trade: 'plumbing', today: TODAY })
  assert.ok(mismatch.reasons.some((x) => /Engaged for plumbing/.test(x)))

  const unknown = scoreExposure({ license: active(), permits: permits(), trade: 'landscaping', today: TODAY })
  assert.equal(unknown.level, 'NONE')

  assert.equal(licenseCoversTrade('Certified Roofing Contractor', 'roofing'), true)
  assert.equal(licenseCoversTrade('Certified Roofing Contractor', 'electrical'), false)
})

test('every reason is traceable to a field, never generated prose', () => {
  const r = scoreExposure({
    license: active({ status: 'SUSPENDED', statusRaw: 'Suspended' }),
    permits: permits({ currentYearPermits: 2, totalPermits: 5, mostRecentPermit: '2026-07-13' }),
    today: TODAY,
  })
  assert.ok(r.reasons.every((x) => typeof x === 'string' && x.length > 0))
  assert.ok(r.reasons.some((x) => x.includes('Suspended')), 'quotes the registry string verbatim')
  assert.ok(r.reasons.some((x) => x.includes('2026-07-13')), 'cites the real permit date')
})

test('a county with no permit source is reported as unchecked, not as quiet', () => {
  const r = scoreExposure({
    license: active({ status: 'DELINQUENT', statusRaw: 'Delinquent' }),
    permits: null,
    today: TODAY,
  })
  assert.ok(
    r.reasons.some((x) => /not available for this county/.test(x)),
    'says the source was unavailable',
  )
  assert.ok(
    !r.reasons.some((x) => /No permit activity on record/.test(x)),
    'never claims there was no activity',
  )
  assert.equal(r.carryingWork, false)
})
