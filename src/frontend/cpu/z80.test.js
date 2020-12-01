/**
 * tests for the ProcessorZ80 class
 *
 * rob andrews <rob@aphlor.org>
 */

import z80 from './z80.js'

const haltException = 'cpu halted by opcode'

test('It returns a set of registers in their default state', () => {
  const cpuInstance = new z80
  const regs = cpuInstance.getRegisters()
  expect(regs).toStrictEqual({
    pc: 0x0000,
    sp: 0xffff,
    af: 0xffff,
    af2: 0xffff,
    bc: 0x0000,
    bc2: 0x0000,
    de: 0x0000,
    de2: 0x0000,
    hl: 0x0000,
    hl2: 0x0000,
    ix: 0x0000,
    iy: 0x0000,
    i: 0x00,
    r: 0x00,
    im: 0
  })
})

test('It returns the correct interrupt mode', () => {
  let program = new Uint8Array(3)
  program[0] = 0xed
  program[1] = 0x5e
  program[2] = 0x76
  const cpuInstance = new z80(program)
  cpuInstance.fetch()
  cpuInstance.execute()
  cpuInstance.fetch()
  let exception
  try {
    cpuInstance.execute()
  } catch (e) {
    exception = e
  }

  expect(exception).toBe(haltException)

  expect(cpuInstance.getRegisters().im).toBe(2)
})

test('It indicates when interrupts are disabled', () => {
  let program = new Uint8Array(2)
  program[0] = 0xf3
  program[1] = 0x76
  const cpuInstance = new z80(program)
  cpuInstance.fetch()
  cpuInstance.execute()
  cpuInstance.fetch()
  let exception
  try {
    cpuInstance.execute()
  } catch (e) {
    exception = e
  }

  expect(exception).toBe(haltException)

  expect(cpuInstance.getInterruptState()).toBe(false)
})

test('It converts an opcode instruction chain to a hexadecimal string', () => {
  let program = new Uint8Array(5)
  program[0] = 0xfd
  program[1] = 0xcb
  program[2] = 0xab
  program[3] = 0x10
  program[4] = 0x76
  const cpuInstance = new z80(program)
  cpuInstance.fetch()

  // the program above is a complicated indirect parameter-before-instruction, so this tests dd logic as well
  // in effect, the 0xab will be dropped and loaded into #preparedInstruction.dd and the next PC byte in the
  // call chain
  expect(cpuInstance.callChainToHex()).toBe('0xFDCB10')
})

test('It sends messages to an IO handler', () => {
  let program = new Uint8Array(5)
  program[0] = 0x3e
  program[1] = 0x21
  program[2] = 0xd3
  program[3] = 0x00
  program[4] = 0x76
  const cpuInstance = new z80(program)
  let buf = []
  cpuInstance.addIoHandler(0x00, (rw, data) => {
    buf.push(data)
  })

  cpuInstance.fetch()
  cpuInstance.execute()
  cpuInstance.fetch()
  cpuInstance.execute()

  expect(buf).toStrictEqual([0x21])
})
