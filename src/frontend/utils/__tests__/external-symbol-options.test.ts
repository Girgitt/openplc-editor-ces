import { buildExternalSymbolOptionGroups } from '../external-symbol-options'

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
