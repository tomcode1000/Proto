/**
 * The tools the verification agent may call.
 *
 * Each one writes what it found into a facts object the caller owns, and returns
 * the same thing to the model. That is deliberate: the engine later scores the
 * facts object, never the model's account of it, so a model that misreports a
 * status cannot change what Proto reports. It can only waste a call.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { lookupLicense, isDisqualifying } from '../connectors/dbpr.js'
import { getPermitActivity } from '../connectors/permits.js'
import { licenseCoversTrade } from '../engine/exposure.js'

export const lookupLicenseTool = (facts, { county } = {}) =>
  tool({
    name: 'lookup_license',
    description:
      'Read a Florida licence from the live state register. Returns its status, the ' +
      'qualifying agent, the licence class and the expiry date. Always call this first.',
    inputSchema: z.object({
      licenseNumber: z.string().describe('Florida licence number, for example CCC1332414'),
    }),
    callback: async ({ licenseNumber }) => {
      // A failure to reach the register is thrown, not flattened into "not found".
      // The sweeper catches it and records the subcontractor as unreachable.
      const record = await lookupLicense(licenseNumber)
      if (!record) {
        facts.license = null
        facts.notFound = true
        return { found: false, note: 'The register holds no such licence. Treat as unverified, not valid.' }
      }
      facts.license = record
      return {
        found: true,
        status: record.status,
        statusRaw: record.statusRaw,
        inGoodStanding: !isDisqualifying(record.status),
        licenseType: record.licenseType,
        businessName: record.businessName,
        expirationDate: record.expirationDate,
      }
    },
  })

export const permitActivityTool = (facts, { county } = {}) =>
  tool({
    name: 'get_permit_activity',
    description:
      'Count permits pulled under a licence in the last three years, and how long ago ' +
      'the last one was. Use this to find out whether work is running under a licence ' +
      'that is not in good standing.',
    inputSchema: z.object({
      licenseNumber: z.string().describe('The same licence number'),
    }),
    callback: async ({ licenseNumber }) => {
      const activity = await getPermitActivity(licenseNumber, { county }).catch(() => null)
      facts.permits = activity
      if (!activity) return { available: false, note: 'Permit records could not be read for this county.' }
      return {
        available: true,
        totalPermits: activity.totalPermits,
        currentYearPermits: activity.currentYearPermits,
        mostRecentPermit: activity.mostRecentPermit,
        monthsSinceLastPermit: activity.monthsSinceLastPermit,
      }
    },
  })

export const scopeMatchTool = (facts) =>
  tool({
    name: 'check_scope',
    description:
      'Check whether a licence class covers the trade the subcontractor was engaged for. ' +
      'Use when a trade is known and may not match the class held.',
    inputSchema: z.object({
      licenseType: z.string().describe('The licence class the register returned'),
      trade: z.string().describe('The trade the subcontractor was engaged for'),
    }),
    callback: async ({ licenseType, trade }) => {
      const covers = licenseCoversTrade(licenseType, trade)
      facts.scope = { licenseType, trade, covers }
      return {
        covers,
        note: covers
          ? 'The class covers the trade.'
          : 'The class does not obviously cover the trade. Worth flagging.',
      }
    },
  })
