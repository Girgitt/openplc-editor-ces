/** Isolated saved-project fixtures. No mocked compiler, debugger or simulator. */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const pin = (id, type, x, y, side) => ({
  id, type, position: side, relPosition: { x, y }, glbPosition: { x, y },
  style: { top: y, ...(side === 'left' ? { left: 0 } : { right: 0 }) },
})
const base = (id, type, numericId, x, y, width, height, data) => ({
  id, type, position: { x, y }, width, height,
  data: { numericId: String(numericId), executionOrder: Number(numericId), draggable: true,
    selectable: true, deletable: true, ...data },
})
const fbdInput = (name, id, numericId, y) => {
  const out = pin('out', 'source', 90, 15, 'right')
  return base(id, 'input-variable', numericId, 30, y, 90, 30, {
    variant: 'input-variable', variable: { name }, negated: false,
    handles: [out], inputHandles: [], outputHandles: [out], outputConnector: out,
  })
}
const fbdOutput = (name, id, numericId, y) => {
  const inn = pin('in', 'target', 0, 15, 'left')
  return base(id, 'output-variable', numericId, 460, y, 90, 30, {
    variant: 'output-variable', variable: { name }, negated: false,
    handles: [inn], inputHandles: [inn], outputHandles: [], inputConnector: inn,
  })
}
const edge = (id, source, target, sourceHandle, targetHandle) => ({ id, source, target, sourceHandle, targetHandle })
const rsPins = [pin('S', 'target', 0, 48, 'left'), pin('R1', 'target', 0, 96, 'left')]
const qPin = pin('Q1', 'source', 120, 48, 'right')
export const fbdBody = {
  rung: {
    comment: '', selectedNodes: [],
    nodes: [
      fbdInput('v1', 'input-set', 1, 80), fbdInput('v2', 'input-reset', 2, 200),
      base('rs0', 'block', 3, 250, 65, 120, 144, {
        variant: {
          name: 'RS', type: 'function-block',
          variables: [
            { name: 'S', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
            { name: 'R1', class: 'input', type: { definition: 'base-type', value: 'BOOL' } },
            { name: 'Q1', class: 'output', type: { definition: 'base-type', value: 'BOOL' } },
          ],
        },
        variable: { name: 'RS0' }, executionControl: false,
        handles: [...rsPins, qPin], inputHandles: rsPins, outputHandles: [qPin],
        inputConnector: rsPins[0], outputConnector: qPin,
      }),
      fbdOutput('out1', 'output-result', 4, 100),
    ],
    edges: [
      edge('set-edge', 'input-set', 'rs0', 'out', 'S'),
      edge('reset-edge', 'input-reset', 'rs0', 'out', 'R1'),
      edge('result-edge', 'rs0', 'output-result', 'Q1', 'in'),
    ],
  },
}

const ladderHandle = (id, type, side, x, y) => ({
  id, type, position: side, glbPosition: { x, y }, relPosition: { x, y },
})
function ldContact(id, numericId, name, x, y = 100) {
  const inn = ladderHandle('in', 'target', 'left', x, y + 20)
  const out = ladderHandle('out', 'source', 'right', x + 60, y + 20)
  return base(id, 'contact', numericId, x, y, 60, 40, {
    variant: 'default', variable: { name }, inputConnector: inn, outputConnector: out,
    handles: [], inputHandles: [], outputHandles: [],
  })
}
function ldCoil(id, numericId, name, x) {
  const inn = ladderHandle('in', 'target', 'left', x, 120)
  const out = ladderHandle('out', 'source', 'right', x + 60, 120)
  return base(id, 'coil', numericId, x, 100, 60, 40, {
    variant: 'default', variable: { name }, inputConnector: inn, outputConnector: out,
    handles: [], inputHandles: [], outputHandles: [],
  })
}
const leftRail = base('rail-left', 'powerRail', 100, 0, 0, 10, 260, {
  variant: 'left', variable: { name: '' }, handles: [], inputHandles: [], outputHandles: [],
  outputConnector: ladderHandle('out', 'source', 'right', 10, 120),
  draggable: false, selectable: false, deletable: false,
})
const rightRail = base('rail-right', 'powerRail', 200, 510, 0, 10, 260, {
  variant: 'right', variable: { name: '' }, handles: [], inputHandles: [], outputHandles: [],
  inputConnector: ladderHandle('in', 'target', 'left', 510, 120),
  draggable: false, selectable: false, deletable: false,
})
export const ldAndBody = {
  name: 'M53_LD_AND', rungs: [{
    id: 'rung-0', comment: '', defaultBounds: [0, 0], reactFlowViewport: [0, 200], selectedNodes: [],
    nodes: [leftRail, ldContact('contact-v1', 1, 'v1', 100), ldContact('contact-v2', 2, 'v2', 240),
      ldCoil('coil-out', 3, 'out1', 400), rightRail],
    edges: [
      edge('r1', 'rail-left', 'contact-v1', 'out', 'in'),
      edge('r2', 'contact-v1', 'contact-v2', 'out', 'in'),
      edge('r3', 'contact-v2', 'coil-out', 'out', 'in'),
      edge('r4', 'coil-out', 'rail-right', 'out', 'in'),
    ],
  }],
}

function parallel(id, numericId, kind, x) {
  const inn = ladderHandle('in', 'target', 'left', x, 100)
  const out = ladderHandle('out', 'source', 'right', x + 20, 100)
  const branchIn = ladderHandle('pIn', 'target', 'left', x, 180)
  const branchOut = ladderHandle('pOut', 'source', 'right', x + 20, 180)
  return base(id, 'parallel', numericId, x, 80, 20, 100, {
    type: kind, variable: { name: '' }, handles: [], inputHandles: [], outputHandles: [],
    inputConnector: inn, outputConnector: out,
    parallelInputConnector: branchIn, parallelOutputConnector: kind === 'open' ? branchOut : undefined,
    parallelOpenReference: undefined, parallelCloseReference: undefined,
    draggable: false, selectable: false, deletable: false,
  })
}
export const ldOrBody = {
  name: 'M53_LD_OR', rungs: [{
    id: 'rung-0', comment: '', defaultBounds: [0, 0], reactFlowViewport: [0, 200], selectedNodes: [],
    nodes: [leftRail, parallel('branch-open', 50, 'open', 60),
      ldContact('contact-v1', 1, 'v1', 130),
      ldContact('contact-v2', 2, 'v2', 130, 160),
      parallel('branch-close', 51, 'close', 270),
      ldCoil('coil-out', 3, 'out1', 400), rightRail],
    edges: [
      edge('r1', 'rail-left', 'branch-open', 'out', 'in'),
      edge('r2', 'branch-open', 'contact-v1', 'out', 'in'),
      edge('r3', 'branch-open', 'contact-v2', 'pOut', 'in'),
      edge('r4', 'contact-v1', 'branch-close', 'out', 'in'),
      edge('r5', 'contact-v2', 'branch-close', 'out', 'pIn'),
      edge('r6', 'branch-close', 'coil-out', 'out', 'in'),
      edge('r7', 'coil-out', 'rail-right', 'out', 'in'),
    ],
  }],
}

const projectMeta = (name, declarations) => ({
  meta: { name, type: 'plc-project' },
  data: { pous: [], dataTypes: [], libraries: [],
    debugVariables: { global: [], pous: { [name]: declarations.map((x) => x.split(':')[0].trim()) } },
    configuration: { resource: {
      tasks: [{ name: 'task0', triggering: 'Cyclic', interval: 'T#20ms', priority: 1 }],
      instances: [{ name: 'instance0', task: 'task0', program: name }], globalVariables: [],
    } },
  },
})
const header = (name, declarations) => `PROGRAM ${name}\nVAR\n${declarations.map((x) => `  ${x};`).join('\n')}\nEND_VAR\n\n`

export const PROJECT_CASES = [
  { name: 'M53_FBD_RS', ext: 'fbd', body: fbdBody, vars: ['v1 : BOOL := FALSE', 'v2 : BOOL := FALSE', 'out1 : BOOL', 'RS0 : RS'],
    input: 'v1', output: 'out1', expect: 'TRUE' },
  { name: 'M53_LD_AND', ext: 'ld', body: ldAndBody, vars: ['v1 : BOOL := FALSE', 'v2 : BOOL := FALSE', 'out1 : BOOL'],
    input: 'v1', output: 'out1', expect: 'TRUE' },
  { name: 'M53_LD_OR', ext: 'ld', body: ldOrBody, vars: ['v1 : BOOL := FALSE', 'v2 : BOOL := FALSE', 'out1 : BOOL'],
    input: 'v1', output: 'out1', expect: 'TRUE' },
  { name: 'M53_ST_TON', ext: 'st', body: 'timer1(IN := enable, PT := T#100ms);\nout1 := timer1.Q;',
    vars: ['enable : BOOL := TRUE', 'out1 : BOOL', 'timer1 : TON'], output: 'out1', expect: 'TRUE' },
]

export async function createFixture(root, fixture) {
  await fs.mkdir(join(root, 'pous', 'programs'), { recursive: true })
  await fs.mkdir(join(root, 'devices'), { recursive: true })
  await fs.writeFile(join(root, 'project.json'), JSON.stringify(projectMeta(fixture.name, fixture.vars), null, 2))
  await fs.writeFile(join(root, 'devices/configuration.json'), JSON.stringify({
    deviceBoard: 'OpenPLC Simulator', communicationPort: '', selectedPlatformOptions: {},
  }))
  await fs.writeFile(join(root, 'devices/pin-mapping.json'), '{}')
  await fs.writeFile(join(root, 'pous/programs', `${fixture.name}.${fixture.ext}`),
    header(fixture.name, fixture.vars) + (typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body, null, 2)) +
    '\n\nEND_PROGRAM\n')
}
