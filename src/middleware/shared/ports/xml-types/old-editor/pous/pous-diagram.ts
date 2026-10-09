import { z } from 'zod'

import { interfaceXMLSchema } from './interface/interface-diagram'
import { fbdXMLSchema } from './languages/fbd-diagram'
import { ilXMLSchema } from './languages/il-diagram'
import { ladderXMLSchema } from './languages/ladder-diagram'
import { stXMLSchema } from './languages/st-diagram'

const pousSchema = z.object({
  pou: z.array(
    z.object({
      '@name': z.string(),
      '@pouType': z.enum(['program', 'function', 'functionBlock']),
      interface: interfaceXMLSchema,
      body: z.object({
        IL: ilXMLSchema.optional(),
        ST: stXMLSchema.optional(),
        LD: ladderXMLSchema.optional(),
        // TC6 2.01 body/addData, used for LD authoring geometry only.
        addData: z.object({ data: z.object({
          '@name': z.string(),
          '@handleUnknown': z.enum(['preserve', 'discard', 'implementation']),
          'openplc:ldGraph': z.object({ '@xmlns:openplc': z.string(), $: z.string() }),
        }) }).optional(),
        FBD: fbdXMLSchema.optional(),
        SFC: z.unknown().optional(),
      }),
      documentation: z
        .object({
          'xhtml:p': z.object({
            $: z.string(),
          }),
        })
        .optional(),
    }),
  ),
})
type PousXML = z.infer<typeof pousSchema>

export { pousSchema }
export type { PousXML }
