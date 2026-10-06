import { Info } from 'lucide-react'

/**
 * The upstream SFC canvas is not implemented yet. M5-2B deliberately keeps
 * SFC PLCopen content lossless through the embedded editor without pretending
 * it can be authored here. CES remains the canonical persistence owner.
 */
export default function SfcEditor() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="flex max-w-xl gap-3 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
        <Info className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <div className="font-medium">SFC authoring is not available in this editor build.</div>
          <div className="mt-1">
            The SFC body is preserved losslessly through PLCopen load/save. Editing it here is disabled until the
            OpenPLC Editor provides an SFC authoring surface.
          </div>
        </div>
      </div>
    </div>
  )
}
