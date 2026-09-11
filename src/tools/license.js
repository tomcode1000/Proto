/**
 * The licence verification tool the agent calls.
 *
 * The tool returns facts only. Every judgement Proto makes about those facts ,
 * whether a licence is disqualifying, how exposed the project is, what to do
 * about it, is computed in `src/engine/`, never narrated by the model.
 */
import { tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { lookupLicense, isDisqualifying } from '../connectors/dbpr.js'

export const lookupLicenseTool = tool({
  name: 'lookup_license',
  description:
    'Verify a Florida contractor licence against the live state DBPR registry. ' +
    'Returns the current status, the qualifying agent, and the expiration date. ' +
    'Use this for any licence whose standing matters; never answer from memory.',
  inputSchema: z.object({
    licenseNumber: z
      .string()
      .describe('Florida licence number, e.g. CAC1816423 or CCC1330456'),
  }),
  callback: async ({ licenseNumber }) => {
    const record = await lookupLicense(licenseNumber)
    if (!record) {
      return {
        licenseNumber,
        found: false,
        note: 'No such licence in the DBPR registry. Treat as unverified, not as valid.',
      }
    }
    return { ...record, found: true, disqualifying: isDisqualifying(record.status) }
  },
})
