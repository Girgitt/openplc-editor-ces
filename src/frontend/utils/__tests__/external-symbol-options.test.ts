import {
  buildExternalSymbolOptionGroups,
  externalSymbolLocationPresentation,
} from '../external-symbol-options'

describe('buildExternalSymbolOptionGroups', () => {
  it('keeps the PLC binding token separate from the CES display name and groups deterministically', () => {
    const groups = buildExternalSymbolOptionGroups('location', [
      {
        id: 'signal:2',
        name: 'Speed',
        displayName: 'Pump P101 / Speed',
        type: 'REAL',
        direction: 'input',
        group: 'PLC-01 / Local IO',
        binding: 'CES_P101_SPEED',
      },
      {
        id: 'signal:1',
        name: 'RunFb',
        displayName: 'Pump P101 / Run feedback',
        type: 'BOOL',
        direction: 'input',
        group: 'PLC-01 / Local IO',
        binding: 'CES_P101_RUN_FB',
      },
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('PLC-01 / Local IO · input')
    expect(groups[0].options.map((option) => option.value)).toEqual(['CES_P101_RUN_FB', 'CES_P101_SPEED'])
    expect(groups[0].options[0].label).toContain('Pump P101 / Run feedback')
  })
})

describe('externalSymbolLocationPresentation', () => {
  const symbols = [
    {
      id: 'signal:1',
      name: 'Pump_Run_Cmd',
      displayName: '/PLC-1/Pump_Run_Cmd',
      type: 'BOOL',
      direction: 'input' as const,
      group: 'System tags',
      binding: 'CES_b5dd9477',
    },
  ]

  it('shows the human-friendly signal name while preserving binding details in the title', () => {
    expect(externalSymbolLocationPresentation('CES_b5dd9477', symbols)).toEqual({
      label: 'Pump_Run_Cmd',
      title: '/PLC-1/Pump_Run_Cmd\nSystem tags · input · BOOL\nBinding: CES_b5dd9477',
    })
  })

  it('falls back to the raw location when the binding is not in the current CES catalog', () => {
    expect(externalSymbolLocationPresentation('manual_alias', symbols)).toEqual({ label: 'manual_alias' })
  })
})
