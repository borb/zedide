#!/usr/bin/env node
"use strict"

import fs from 'fs'
import path from 'path'

/**
 * a hacky script to turn Philip Kendall's opcode tables into javascript source.
 * brace yourself.
 */
const [infile, outfile, base, register] = [process.argv[2], process.argv[3], process.argv[4], process.argv[5]]

if ((process.argv.indexOf('--help') !== -1) || (process.argv.indexOf('-h') !== -1)) {
  // output help information
  console.log(`${path.basename(process.argv[1])}: convert Z80 opcode tables from Philip Kendall's FUSE to JavaScript.\n` +
    `\n` +
    `Usage:\n` +
    `  ${path.basename(process.argv[1])} <input> <output> [<subtable index> <REGISTER name>] \n` +
    `\n` +
    `  Arguments:\n` +
    `    -h  --help    This help information\n` +
    `\n` +
    `  Parameters:\n` +
    `    <input>           The opcode file to read\n` +
    `    <output>          The JavaScript file to write\n` +
    `    <subtable index>  Byte prefix for shifted opcodes - can be more than one byte, e.g. ED, DDCB\n` +
    `    <REGISTER name>   Substitute occurences of REGISTER for this value - e.g. IX, IY\n` +
    `\n` +
    `  Author:\n` +
    `    rob andrews <rob@aphlor.org>\n`)
  process.exit(0)
}

if (typeof infile === 'undefined' || typeof outfile === 'undefined') {
  console.error('Please specify an input file and an output file.')
  process.exit(10)
}

if (!fs.existsSync(infile)) {
  console.error('Input file does not exist.')
  process.exit(11)
}

// setup the subtable prefix for the output data
let subtablePrefix = ''
if (typeof base !== 'undefined') {
  if ((base.length % 2) || base.match(/^[^a-z0-9]$/i)) {
    console.error(`Invalid value for 'base': ${base}`)
    process.exit(1)
  }
  let subtable = []
  for (let pos = 0; pos < base.length; pos++) {
    subtable.push(eval(`0x${base[pos++]}${base[pos]}`))
  }

  subtable.forEach((node) => {
    subtablePrefix += `[0x${node.toString('16')}]`
  })
}

// read and trim the input data
let input
try {
  input = fs.readFileSync(infile)
} catch (e) {
  console.error(`Failed to read input file: ${e}`)
  process.exit(12)
}

// if supplied, replace the word REGISTER with the actual register for the table in the input data
if (typeof register !== 'undefined') {
  input = input.toString().replace(/REGISTER/g, register)
}

// drop empty lines and comments
const splitInput = input.toString().split(/\n/).filter(
  (line) => ((line === '') || (line[0] === '#'))
    ? false
    : true
)

let outputBuffer = ''
let unhandled = {}

// regexp helpers for simplify matching
const anyRegMatch = (reg) => reg.match(/^(a|b|c|d|e|h|l|ixh|ixl|iyh|iyl|bc|de|hl|ix|iy|sp|pc|af|af')$/)
const byteRegMatch = (reg) => reg.match(/^(a|b|c|d|e|h|l|ixh|ixl|iyh|iyl)$/)
const wordRegMatch = (reg) => reg.match(/^(bc|de|hl|ix|iy|sp|pc|af|af')$/)

splitInput.forEach((line) => {
  /**
   * FIXUPS! although hacky to look at, some of the 0x[df]dcb ops are recorded in opcodes as ld instructions
   * whilst they DO perform ld type operations (by setting bits in data then storing in a register), this would
   * mean excessive branching off of the ld case; let's reformat so they look like bit ops with a third parameter
   * (which should be a first parameter really); we'll cope with this in the handling
   */
  const verbatimOp = line.toLowerCase().replace(/^0x.. (.*)$/, '$1')
  const fixup = line.match(/^(0x..) LD (.),((RLC|RRC|RL|RR|SLA|SRA|SLL|SRL|RES|SET) .*)$/)
  if (fixup)
    line = `${fixup[1]} ${fixup[3]},${fixup[2]}`

  // each opcode line is in the format:
  // <byte> <instruction> <argument>
  // argument can be a number of things, we will branch accordingly (and parse accordingly)
  let [opcode, mnemonic, param] = line.split(/ /)
  mnemonic = mnemonic.toLowerCase()
  param = (typeof param !== 'undefined')
    ? param.toLowerCase()
    : undefined

  switch (mnemonic) {
    case 'nop':
      // do nothing
      // flags unaffected
      outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => {}\n`
      break

    case 'ld': {
      // load instruction: determine if direct between registers, to/from memory, etc.
      // flags unaffected
      const parts = param.split(/,/)

      if ((byteRegMatch(parts[0]) && byteRegMatch(parts[1]))
          || (wordRegMatch(parts[0]) && wordRegMatch(parts[1]))) {
        // simple byte/word register copy
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => { this.#regops.${parts[0]}(this.#regops.${parts[1]}()) }\n`
        break
      }

      if (byteRegMatch(parts[0]) && parts[1] == 'nn') {
        // simple byte load
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => { this.#regops.${parts[0]}(this.#getPC()) }\n`
        break
      }

      if (wordRegMatch(parts[0]) && parts[1] == 'nnnn') {
        // simple word load
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const [lo, hi] = [this.#getPC(), this.#getPC()]\n` +
          `  this.#regops.${parts[0]}(this.#word(hi, lo))\n` +
          `}\n`
        break
      }

      if (parts[0] == '(nnnn)' && byteRegMatch(parts[1])) {
        // write byte register to memory
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const [lo, hi] = [this.#getPC(), this.#getPC()]\n` +
          `  this.#ram[this.#word(hi, lo)] = this.#regops.${parts[1]}()\n` +
          `}\n`
        break
      }

      if (parts[0] == '(nnnn)' && wordRegMatch(parts[1])) {
        // write word register to memory
        const [msb, lsb] = parts[1].split('')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const [lo, hi] = [this.#getPC(), this.#getPC()]\n` +
          `  this.#ram[this.#word(hi, lo)] = this.#regops.${lsb}()\n` +
          `  this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.${msb}()\n` +
          `}\n`
        break
      }

      if (byteRegMatch(parts[0]) && parts[1] == '(nnnn)') {
        // load memory to byte register
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const [lo, hi] = [this.#getPC(), this.#getPC()]\n` +
          `  this.#regops.${parts[0]}(this.#ram[this.#word(hi, lo)])\n` +
          `}\n`
        break
      }

      if (wordRegMatch(parts[0]) && parts[1] == '(nnnn)') {
        // load memory to word register
        const [msb, lsb] = parts[1].split('')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const [lo, hi] = [this.#getPC(), this.#getPC()]\n` +
          `  this.#regops.${lsb}(this.#ram[this.#word(hi, lo)])\n` +
          `  this.#regops.${msb}(this.#ram[this.#addWord(this.#word(hi, lo), 1)])\n` +
          `}\n`
        break
      }

      if (parts[0].match(/\(..\)/) && parts[1] == 'nn') {
        const register = parts[0].replace(/[()]/g, '')
        // write byte to memory by register
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => { this.#ram[this.#regops.${register}()] = this.#getPC() }\n`
        break
      }

      if (parts[0].match(/\(..\+dd\)/) && parts[1] == 'nn') {
        const register = parts[0].substring(1, 3)
        // write byte to memory by register indirect mode (dd byte before nn byte)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#ram[this.#regops.${register}() + this.#uint8ToInt8(this.#getPC())] = this.#getPC()\n` +
          `}\n`
        break
      }

      if (parts[0].match(/\(..\)/) && byteRegMatch(parts[1])) {
        const register = parts[0].replace(/[()]/g, '')
        // write 8-bit register to memory by register
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => { this.#ram[this.#regops.${register}()] = this.#regops.${parts[1]}() }\n`
        break
      }

      if (byteRegMatch(parts[0]) && parts[1].match(/\(..\)/)) {
        const register = parts[1].replace(/[()]/g, '')
        // load 8-bit register from memory by register
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => { this.#regops.${parts[0]}(this.#ram[this.#regops.${register}()]) }\n`
        break
      }

      if (byteRegMatch(parts[0]) && parts[1].match(/\(..\+dd\)/)) {
        // indirect 8-bit read from register
        const register = parts[1].substring(1, 3)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.${parts[0]}(this.#ram[this.#registers.${register} + this.#uint8ToInt8(this.#getPC())])\n` +
          `}\n`
        break
      }

      if (parts[0].match(/\(..\+dd\)/) && byteRegMatch(parts[1])) {
        // store 8-bit register to indirect location
        const register = parts[0].substring(1, 3)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#ram[this.#registers.${register} + this.#uint8ToInt8(this.#getPC())] = this.#regops.${parts[1]}()\n` +
          `}\n`
        break
      }

      console.warn(`unhandled ld type: ${mnemonic} ${param}`)
      break
    }

    case 'exx':
      // swap bc, de, hl with bc', de', hl'
      outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => {\n  const [bc, de, hl] = [this.#regops.bc(), this.#regops.de(), this.#regops.hl()]\n  this.#regops.bc(this.#regops.bc2())\n  this.#regops.de(this.#regops.de2())\n  this.#regops.hl(this.#regops.hl2())\n  this.#regops.bc2(bc)\n  this.#regops.de2(de)\n  this.#regops.hl2(hl)\n}\n`
      break

    case 'ex':
      // exchange values with each other
      // these ops are only 16-bit; don't need to worry about parity, half, etc.
      let [reg1, reg2] = param.split(/,/)

      if (wordRegMatch(reg1) && wordRegMatch(reg2)) {
        // exchange between registers
        reg2 = reg2.replace(/^af'$/, 'af2')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const temp = this.#regops.${reg1}()\n` +
          `  this.#regops.${reg1}(this.#regops.${reg2}())\n` +
          `  this.#regops.${reg2}(temp)\n` +
          `}\n`
        break
      }

      if (reg1.match(/\(..\)/)) {
        // exchange between ram and word register
        reg1 = reg1.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const temp = this.#registers.${reg2}\n` +
          `  const [lo, hi] = [this.#ram[this.#registers.${reg1}], this.#ram[this.#addWord(this.#registers.${reg1}, 1)]]\n` +
          `  this.#registers.${reg2} = this.#word(hi, lo)\n` +
          `  this.#ram[this.#registers.${reg1}] = this.#lo(temp)\n` +
          `  this.#ram[this.#addWord(this.#registers.${reg1}, 1)] = this.#hi(temp)\n` +
          `}\n`
        break
      }

      console.warn(`unhandled ex param: ${mnemonic} ${param}`)
      break

    case 'ret':
      // return from a subroutine call (pop word from sp and load into pc)
      if (typeof param === 'undefined') {
        outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => { this.#regops.pc(this.#popWord()) }\n`
        break
      }

      switch (param) {
        case 'z': // zero bit
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () {\n  if (this.#regops.f() & this.#FREG_Z)\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'nz': // zero bit
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () {\n  if (!(this.#regops.f() & this.#FREG_Z))\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'c': // carry flag bit
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () {\n  if (this.#regops.f() & this.#FREG_C)\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'nc': // carry flag bit
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () {\n  if (!(this.#regops.f() & this.#FREG_C))\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'pe': // parity flag bit (equal)
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () {\n  if (this.#regops.f() & this.#FREG_P)\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'po': // parity flag bit (odd)
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () {\n  if (!(this.#regops.f() & this.#FREG_P))\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'p': // sign bit (what is 'p'?)
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () {\n  if (!(this.#regops.f() & this.#FREG_S))\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'm': // sign bit (what is 'm'?)
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () {\n  if (this.#regops.f() & this.#FREG_S)\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        default:
          console.warn(`unhandled ret param: ${mnemonic} ${param}`)
          break
      }

      break

    case 'di':
      // disable interrupts
      outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => { this.#interrupts = false }\n`
      break

    case 'ei':
      // enable interrupts
      outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => { this.#interrupts = true }\n`
      break

    case 'push':
      // push a value onto the stack (always a word)
      outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => { this.#pushWord(this.#registers.${param}) }\n`
      break

    case 'pop':
      // pop a value from the stack (always a word)
      outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => { this.#regops.${param}(this.#popWord()) }\n`
      break

    case 'inc': {
      // increment by one
      switch (param) {
        // there is no af, because incrementing the flag register makes no sense
        case 'bc':
        case 'de':
        case 'hl':
        case 'sp':
        case 'ix':
        case 'iy':
          // inc on these registers doesn't affect flags
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => { this.#registers.${param} = this.#addWord(this.#registers.${param}, 1) }\n`
          break

        // eight bit incs (no f, incing a flag register makes no sense)
        case 'a':
        case 'b':
        case 'c':
        case 'd':
        case 'e':
        case 'h':
        case 'l':
        case 'ixh':
        case 'ixl':
        case 'iyh':
        case 'iyl':
          // thanks to philip kendall; flag handling ported from fuse's z80_macros.h
          outputBuffer += `// ${verbatimOp}\n` +
            `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
            `  this.#regops.${param}(this.#addByte(this.#regops.${param}(), 1))\n` +
            `  this.#regops.f(\n` +
            `      this.#regops.f()\n` +
            `    | this.#FREG_C\n` +
            `    | ((this.#regops.${param}() & 0x0f) ? 0 : this.#FREG_H)\n` +
            `    | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)\n` +
            `    | this.#flagTable.sz53[this.#regops.${param}()]\n` +
            `  )\n` +
            `}\n`
          break


        case '(hl)':
          // increment 8-bit value in memory
          outputBuffer += `// ${verbatimOp}\n` +
            `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
            `  const old = this.#ram[this.#registers.hl]\n` +
            `  const new = this.#addByte(old, 1)\n` +
            `  this.#ram[this.#registers.hl] = new\n` +
            `  this.#regops.f(\n` +
            `      this.#regops.f()\n` +
            `    | this.#FREG_C\n` +
            `    | ((old & 0x0f) ? 0 : this.#FREG_H)\n` +
            `    | ((new == 0x80) ? this.#FREG_V : 0)\n` +
            `    | this.#flagTable.sz53[new]\n` +
            `  )\n` +
            `}\n`
          break

        case '(ix+dd)':
        case '(iy+dd)':
          // register indirect mode
          const register = param.substring(1, 3)
          outputBuffer += `// ${verbatimOp}\n` +
            `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
            `  const offset = this.#uint8ToInt8(this.#getPC())\n` +
            `  const old = this.#ram[this.#registers.${register} + offset]\n` +
            `  const new = this.#addByte(old, 1)\n` +
            `  this.#ram[this.#registers.${register} + offset] = new\n` +
            `  this.#regops.f(\n` +
            `      this.#regops.f()\n` +
            `    | this.#FREG_C\n` +
            `    | ((old & 0x0f) ? 0 : this.#FREG_H)\n` +
            `    | ((new == 0x80) ? this.#FREG_V : 0)\n` +
            `    | this.#flagTable.sz53[new]\n` +
            `  )\n` +
            `}\n`
          break

        default:
          console.warn(`unhandled inc param: ${mnemonic} ${param}`)
          break
      }
      break
    }

    case 'dec': {
      // decrement by one
      switch (param) {
        // there is no af, because decrementing the flag register makes no sense
        // sixteen bit decs
        case 'bc':
        case 'de':
        case 'hl':
        case 'sp':
        case 'ix':
        case 'iy':
          // dec on these registers doesn't affect flags
          outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => { this.#registers.${param} = this.#subWord(this.#registers.${param}, 1) }\n`
          break

        // eight bit decs (again, no f, decing a flag register makes no sense)
        case 'a':
        case 'b':
        case 'c':
        case 'd':
        case 'e':
        case 'h':
        case 'l':
        case 'ixh':
        case 'ixl':
        case 'iyh':
        case 'iyl':
          // again, thanks to philip kendall; flag handling ported from fuse's z80_macros.h
          outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const old = this.#regops.${param}()\n` +
          `  this.#regops.${param}(this.#subByte(this.#regops.${param}(), 1))\n` +
          `  this.#regops.f(\n` +
          `      this.#regops.f()\n` +
          `    | this.#FREG_C\n` +
          `    | ((old & 0x0f) ? 0 : this.#FREG_H)\n` +
          `    | this.#FREG_N\n` +
          `    | ((this.#regops.${param}() == 0x7f) ? this.#FREG_V : 0)\n` +
          `    | this.#flagTable.sz53[this.#regops.${param}()]\n` +
          `  )\n` +
          `}\n`
          break

        case '(hl)':
          // decrement 8-bit value in memory
          outputBuffer += `// ${verbatimOp}\n` +
            `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
            `  const old = this.#ram[this.#registers.hl]\n` +
            `  const new = this.#subByte(old, 1)\n` +
            `  this.#ram[this.#registers.hl] = new\n` +
            `  this.#regops.f(\n` +
            `      this.#regops.f()\n` +
            `    | this.#FREG_C\n` +
            `    | ((old & 0x0f) ? 0 : this.#FREG_H)\n` +
            `    | this.#FREG_N\n` +
            `    | ((new == 0x7f) ? this.#FREG_V : 0)\n` +
            `    | this.#flagTable.sz53[new]\n` +
            `  )\n` +
            `}\n`
          break

        case '(ix+dd)':
        case '(iy+dd)':
          // register indirect mode
          const register = param.substring(1, 3)
          outputBuffer += `// ${verbatimOp}\n` +
            `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
            `  const offset = this.#uint8ToInt8(this.#getPC())\n` +
            `  const old = this.#ram[this.#registers.${register} + offset]\n` +
            `  const new = this.#subByte(old, 1)\n` +
            `  this.#ram[this.#registers.${register} + offset] = new\n` +
            `  this.#regops.f(\n` +
            `      this.#regops.f()\n` +
            `    | this.#FREG_C\n` +
            `    | ((old & 0x0f) ? 0 : this.#FREG_H)\n` +
            `    | this.#FREG_N\n` +
            `    | ((new == 0x7f) ? this.#FREG_V : 0)\n` +
            `    | this.#flagTable.sz53[new]\n` +
            `  )\n` +
            `}\n`
          break

        default:
          console.warn(`unhandled dec param: ${mnemonic} ${param}`)
          break
      }
      break
    }

    case 'call':
    case 'jp':
      // call: call a subroutine (put pc on the stack so we can use ret)
      // jp: jump to another program location (change the pc to new location)
      const pushReturnAddress = (mnemonic == 'call')
        ? '  this.#pushWord(this.#registers.pc)\n'
        : ''

      if (param == 'nnnn') {
        // unconditional
        outputBuffer += `// ${verbatimOp}\nthis.#opcodes.[${opcode}] = () => {\n  const [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#registers.pc = this.#word(hi, lo)\n${pushReturnAddress}}\n`
        break
      }

      if (mnemonic == 'jp' && param.match(/(hl|ix|iy)/)) {
        // unconditional using register value (jp only)
        outputBuffer += `// ${verbatimOp}\nthis.#opcodes.[${opcode}] = () => { this.#registers.pc = this.#registers.${param} }\n`
        break
      }

      const [flagOp] = param.split(/,/)

      // leave early so we can shortcut the outputBuffer concat and save code
      // we do this because we ALWAYS need to pull the call address from pc&pc++,
      // even if we never meet the branch condition.
      if ('z,nz,c,nc,po,pe,p,m'.split(/,/).indexOf(flagOp) === -1) {
        console.warn(`unhandled call/jp param: ${mnemonic} ${param}`)
        break
      }

      outputBuffer += `// ${verbatimOp}\nthis.#opcodes.[${opcode}] = () => {\n  const [lo, hi] = [this.#getPC(), this.#getPC()]\n  `
      switch (flagOp) {
        case 'z':
        case 'c':
          outputBuffer += `if (this.#regops.f() & this.#FREG_${flagOp.toUpperCase()})`
          break
        case 'nz':
        case 'nc':
          outputBuffer += `if (!(this.#regops.f() & this.#FREG_${flagOp[1].toUpperCase()}))`
          break
        case 'pe':
          outputBuffer += `if (this.#regops.f() & this.#FREG_P)`
          break
        case 'po':
          outputBuffer += `if (!(this.#regops.f() & this.#FREG_P))`
          break
        case 'p':
          outputBuffer += `if (!(this.#regops.f() & this.#FREG_S))`
          break
        case 'm':
          outputBuffer += `if (this.#regops.f() & this.#FREG_S)`
          break
      }
      outputBuffer += `\n    this.#regops.pc(this.#word(hi, lo))\n${pushReturnAddress}}\n`
      break

    case 'scf':
      // set carry flag: c is set; p/v, z & s are unaffected; n & h are unset; f3 & f5 are set they leak out of the accumulator
      // explanation of below: take f, mask out n and h, mask out f3 and f5 then bring them back in if they leak from a.
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.f(\n` +
        `    this.#regops.f() & ~(this.#FREG_N | this.#FREG_H)\n` +
        `    & ~(this.#FREG_F3 | this.#FREG_F5)\n` +
        `    | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `  )\n` +
        `}\n`
      break

    case 'ccf':
      // ccf, which you'd think is "clear carry flag" but is actually "invert carry flag"
      // upon inspection of fuse, it seems to say "if c is set, set the h flag, else set c"
      // f3 and f5 leak out of the accumulator, as they do with scf. p, z & s unchanged.
      // i'm pretty sure i'm being trolled by cpu engineers from history.
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.f(\n` +
        `    this.#regops.f() | ((this.#regops.f() & this.#FREG_C) ? this.#FREG_H : this.#FREG_C)\n` +
        `    & ~(this.#FREG_F3 | this.#FREG_F5)\n` +
        `    | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `  )\n` +
        `}\n`
      break

    case 'add':
    case 'adc': {
      let [dst, src] = param.split(/,/)
      let carryPart = ''

      // check if mnemonic is 'adc' and account for the carry flag
      // funny how the carry flag isn't considered for overflow...
      if (mnemonic === 'adc') {
        // over/underflow is ok here as long as later ops clean up after this transaction
        carryPart = `  this.#regops.${dst}(this.this.#regops.${dst} + (this.#regops.f() & this.#FREG_C ? 1 : 0))\n`
      }

      if (wordRegMatch(dst) && wordRegMatch(src)) {
        // reg word+reg word (destination is ALWAYS hl)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add16(this.#regops.${dst}(), this.#regops.${src}()))\n` +
          `}\n`
        break
      }

      if (byteRegMatch(dst) && byteRegMatch(src)) {
        // reg byte+reg byte (destination is ALWAYS a)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add8(this.#regops.${dst}(), this.#regops.${src}()))\n` +
          `}\n`
        break
      }

      if (byteRegMatch(dst) && src === 'nn') {
        // reg byte+byte
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add8(this.#regops.${dst}(), this.#getPC()))\n` +
          `}\n`
        break
      }

      if (byteRegMatch(dst) && src.match(/\(..\)/)) {
        // byte add to a from memory location
        src = src.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add8(this.#regops.${dst}(), this.#ram[this.#regops.${src}()])\n` +
          `}\n`
        break
      }

      if (byteRegMatch(dst) && src.match(/\(..\+dd\)/)) {
        // byte add to a from indirect memory location
        src = src.substring(1, 3)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add8(this.#regops.${dst}(), this.#ram[this.#regops.${src}() + this.#uint8ToInt8(this.#getPC())])\n` +
          `}\n`
        break
      }

      console.warn(`unhandled add param: ${mnemonic} ${param}`)
      break
    }

    case 'sub':
    case 'sbc':
    {
      let [dst, src] = param.split(/,/)
      let carryPart = ''

      // amusing fact: base opcodes of the z80 don't have a 16-bit register subtract, but does have add

      // check if mnemonic is 'sbc' and account for the carry flag
      // funny how the carry flag isn't considered for underflow...
      if (mnemonic === 'sbc') {
        // over/underflow is ok here as long as later ops clean up after this transaction
        carryPart = `  this.#regops.${dst}(this.#regops.${dst} - (this.#regops.f() & this.#FREG_C ? 1 : 0))\n`
      }

      if (byteRegMatch(dst) && byteRegMatch(src)) {
        // reg byte-reg byte (destination always a)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#sub8(this.#regops.${dst}(), this.#regops.${src}()))\n` +
          `}\n`
        break
      }

      // zilog mnemonic is 'sub nn', but for convention with add, support 'sub a,nn'
      if ((dst === 'nn' && typeof src === 'undefined') || (byteRegMatch(dst) && src === 'nn')) {
        // reg byte-byte
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#sub8(this.#regops.${dst}(), this.#getPC()))\n` +
          `}\n`
        break
      }

      if (byteRegMatch(dst) && src.match(/\(..\)/)) {
        // byte sub from a from memory location
        src = src.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#sub8(this.#regops.${dst}(), this.#ram[this.#regops.${src}()])\n` +
          `}\n`
        break
      }

      if (byteRegMatch(dst) && src.match(/\(..\+dd\)/)) {
        // byte sub from a from indirect memory location
        src = src.substring(1, 3)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#sub8(this.#regops.${dst}(), this.#ram[this.#regops.${src}() + this.#uint8ToInt8(this.#getPC())])\n` +
          `}\n`
        break
      }

      console.warn(`unhandled sub param: ${mnemonic} ${param}`)
      break
    }

    case 'rlca':
      // roll left and carry from a
      // bit 7 becomes 0 and is copied to flag c
      // flags: keep p, z and s, F3 and F5 leak from accumulator, set c
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.a(this.#lo((this.#regops.a() << 1) | (this.#regops.a() >> 7))\n` +
        `  this.#regops.f(\n` +
        `    (this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S))\n` +
        `    | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `    | ((this.#regops.a() & 0x01) ? this.#FREG_C : 0)\n` +
        `  )\n` +
        `}\n`
      break

    case 'rla':
      // roll left, swapping the carry flag out
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  const carry = (this.#regops.f() & this.#FREG_C) ? 0x01 : 0x00\n` +
        `  const newCarry = (this.#regops.a() & 0x80) ? this.#FREG_C : 0\n` +
        `  this.#regops.a(this.#lo((this.#regops.a() << 1) | carry)\n` +
        `  this.#regops.f(\n` +
        `    (this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S))\n` +
        `    | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `    | newCarry\n` +
        `  )\n` +
        `}\n`
      break

    case 'rrca':
      // roll right and carry from a
      // bit 0 becomes 7 and is copied to flag c
      // flags: keep p, z and s, F3 and F5 leak from accumulator, set c
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.a(this.#lo((this.#regops.a() << 7) | (this.#regops.a() >> 1))\n` +
        `  this.#regops.f(\n` +
        `    (this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S))\n` +
        `    | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `    | ((this.#regops.a() & 0x80) ? this.#FREG_C : 0)\n` +
        `  )\n` +
        `}\n`
      break

    case 'rra':
      // roll right, swapping carry flag out
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  const carry = (this.#regops.f() & this.#FREG_C) ? 0x80 : 0x00\n` +
        `  const newCarry = (this.#regops.a() & 0x01) ? this.#FREG_C : 0\n` +
        `  this.#regops.a(this.#lo((this.#regops.a() >> 1) | carry)\n` +
        `  this.#regops.f(\n` +
        `    (this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S))\n` +
        `    | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `    | newCarry\n` +
        `  )\n` +
        `}\n`
      break

    case 'halt':
      // stop being a cpu and become a doorstop
      // @todo use a custom exception class?
      outputBuffer += `// ${verbatimOp}\nthis.#opcodes${subtablePrefix}[${opcode}] = () => { throw 'cpu halted by opcode' }\n`
      break

    case 'shift':
      // the opcode is a prefix to another table of opcodes (which can, in turn open another table of opcodes, i.e. $ddcb/$fdcb)
      outputBuffer += `// ${verbatimOp} (subtable of operations)\nthis.#opcodes[${opcode}] = []\n`
      break

    case 'djnz':
      // dec b, if it's not zero, jump to pc+offset (signed)
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]\n` +
        `  this.#regops.b(this.#sub8(this.#regops.b(), 1))\n` +
        `  if (this.#regops.b())\n` +
        `    this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))\n` +
        `}\n`
      break

    case 'jr':
      // like djnz, but either unconditional or based on flags

      if (param === 'offset') {
        // unconditional
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]\n` +
          `  this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))\n` +
        `}\n`
        break
      }

      const [flag] = param.split(/,/)
      let condition = ''

      // should be between c, nc, z, nz now
      switch (flag) {
        case 'z':
          condition = `this.#regops.f() & this.#FREG_Z`
          break

        case 'nz':
          condition = `(this.#regops.f() & this.#FREG_Z) == 0`
          break

        case 'c':
          condition = `this.#regops.f() & this.#FREG_C`
          break

        case 'nc':
          condition = `(this.#regops.f() & this.#FREG_C) == 0`
          break

        default:
          console.warn(`unhandled jr param: ${mnemonic} ${param}`)
          break
      }

      if (condition == '')
        break

      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]\n` +
        `  if (${condition})\n` +
        `    this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))\n` +
        `}\n`

      break

    case 'daa':
      // decimal adjust after addition; adjust a to contain two digit packed decimal
      // ported from fuse owing to not being sure how the BCD opcodes work
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  const [add, carry] = [0, this.#regops.f() & this.#FREG_C]\n` +
        `  \n` +
        `  if ((this.#regops.f() & this.#FREG_H) || ((this.#regops.a() & 0x0f) > 9))\n` +
        `    add = 6\n` +
        `  if (carry || (this.#regops.a() > 0x99))\n` +
        `    add |= 0x60\n` +
        `  if (this.#regops.a() > 0x99)\n` +
        `    carry = this.#FREG_C\n` +
        `  \n` +
        `  if (this.#regops.f() & this.#FREG_N)\n` +
        `    this.#regops.a(this.#sub8(this.#regops.a(), add))\n` +
        `  else\n` +
        `    this.#regops.a(this.#add8(this.#regops.a(), add))\n` +
        `  \n` +
        `  this.#regops.f(\n` +
        `      this.#regops.f()\n` +
        `    & ~(this.#FREG_C | this.#FREG_P))\n` +
        `    | carry\n` +
        `    | this.#flagTable.parity[this.#regops.a()]\n` +
        `  )\n` +
        `}\n`
      break

    case 'in':
    case 'out':
      // input/output
      let [arg1, arg2] = param.split(/,/)

      arg1 = arg1.replace(/[()]/g, '')
      arg2 = arg2.replace(/[()]/g, '')

      if (arg1 == 'nn' || arg2 == 'nn') {
        // read or write by port number in next byte (register is always a)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n`

        outputBuffer += mnemonic == 'in'
          ? `  this.#regops.a(this.#callIoHandler(this.#getPC(), 'r'))`
          : `  this.#callIoHandler(this.#getPC(), 'w', this.#regops.a())`

        outputBuffer += `\n}\n`
        break
      }

      console.warn(`unhandled ${mnemonic} param: ${mnemonic} ${param}`)
      break

    case 'cpl':
      // invert each bit in accumulator; leak f3 & f5, set n & h, retain cpzs
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.a(this.#regops.a() ^ 0xff)\n` +
        `  this.#regops.f(\n` +
        `      this.#regops.f()\n` +
        `    & (this.#FREG_C | this.#FREG_P | this.#FREG_Z | this.#FREG_S)\n` +
        `    | (this.regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `    | this.#FREG_N | this.#FREG_H\n` +
        `  )\n` +
        `}\n`
      break

    case 'and': {
      // bitwise and on a register, storing result in the first register (accumulator)
      // always sets h flag; every other flag is affected. trust nothing!
      const adjustedParam = (param === 'nn')
        ? 'a,nn'
        : param

      let [dst, src] = adjustedParam.split(/,/)

      if (byteRegMatch(dst) && byteRegMatch(src)) {
        // src is register (three letter registers are ixh/ixl/iyh/iyl)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.${dst}(this.#regops.${dst}() & this.#regops.${src}())\n` +
          `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)\n` +
          `}\n`
        break
      }

      if (src === 'nn') {
        // src is a byte following the opcode
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.${dst}(this.#regops.${dst}() & this.#getPC())\n` +
          `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)\n` +
          `}\n`
        break
      }

      if (src.match(/\(..\)/)) {
        // src is read from a location by register
        src = src.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.${dst}(this.#regops.${dst}() & this.#ram[this.#regops.${src}()])\n` +
          `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)\n` +
          `}\n`
        break
      }

      if (src.match(/\(..\+dd\)/)) {
        // src is read from an indirect location by register
        src = src.substring(1, 3)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.${dst}(this.#regops.${dst}() & this.#ram[this.#regops.${src}() + this.#uint8ToInt8(this.#getPC())])\n` +
          `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)\n` +
          `}\n`
        break
      }

      console.warn(`unhandled and param: ${mnemonic} ${param}`)
      break
    }

    case 'or':
    case 'xor': {
      // bitwise or/xor on a register, storing result in the first register (accumulator)
      // every flag is affected
      const adjustedParam = (param === 'nn')
        ? 'a,nn'
        : param

      const bitwiseOp = (mnemonic === 'or')
        ? '|'
        : '^'

      let [dst, src] = adjustedParam.split(/,/)

      if (byteRegMatch(dst) && byteRegMatch(src)) {
        // src is register (three letter registers are ixh/ixl/iyh/iyl)
        outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.${dst}(this.#regops.${dst}() ${bitwiseOp} this.#regops.${src}())\n` +
        `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])\n` +
        `}\n`
        break
      }

      if (src === 'nn') {
        // src is a byte following the opcode
        outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.${dst}(this.#regops.${dst}() ${bitwiseOp} this.#getPC())\n` +
        `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])\n` +
        `}\n`
        break
      }

      if (src.match(/\(..\)/)) {
        // src is read from a location by register
        src = src.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.${dst}(this.#regops.${dst}() ${bitwiseOp} this.#ram[this.#regops.${src}()])\n` +
        `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])\n` +
        `}\n`
        break
      }

      if (src.match(/\(..\+dd\)/)) {
        // src is read from an indirect location by register
        src = src.substring(1, 3)
        outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#regops.${dst}(this.#regops.${dst}() ${bitwiseOp} this.#ram[this.#regops.${src}() + this.#uint8ToInt8(this.#getPC())])\n` +
        `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])\n` +
        `}\n`
        break
      }

      console.warn(`unhandled ${mnemonic} param: ${mnemonic} ${param}`)
      break
    }

    case 'rst':
      // push the pc location following rst onto the stack and set pc to the mnemonic-prefilled address
      outputBuffer += `// ${verbatimOp}\n` +
        `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
        `  this.#pushWord(this.#registers.pc)\n` +
        `  this.#registers.pc = 0x${param}\n` +
        `}\n`
      break

    case 'cp': {
      // subtract register from a without changing a; change flags as if the action took place
      // sort of like a "simulate" action

      // fixup to retain consistency with the ix/iy/register relative ops
      // bit silly, since it's all on the accumulator anyway
      const adjustedParam = (param.indexOf(',') === -1)
        ? `a,${param}`
        : param

      let [dst, src] = adjustedParam.split(/,/)

      if (byteRegMatch(src)) {
        // register direct (not memory pointer or relative)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => this.#cp8(this.#regops.${dst}(), this.#regops.${src}())\n`
        break
      }

      if (src === 'nn') {
        // against value in (pc)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => this.#cp8(this.#regops.${dst}(), this.#getPC())\n`
        break
      }

      if (src.match(/\(.{2,3}\)/)) {
        src = src.replace(/[()]/g, '')
        // against value in (reg)
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => this.#cp8(this.#regops.${dst}(), this.#ram[this.#regops.${src}()])\n`
        break
      }

      if (src.match(/\(..\+dd\)/)) {
        src = src.substring(1, 3)
        // against value in (reg) + indirect
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => this.#cp8(this.#regops.${dst}(), this.#ram[this.#regops.${src}() + this.#uint8ToInt8(this.#getPC())])\n`
        break
      }

      console.warn(`unhandled ${mnemonic} param: ${mnemonic} ${param}`)
      break
    }

    case 'rlc': {
      // rotate left & carry 7 (to FREG_C and bit 0); incorporate carry flag if
      // affects all flags; c as above, sz53p by table values
      const [subject, dst] = param.split(/,/)

      if (byteRegMatch(subject)) {
        // register mode
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.${subject}(((this.#regops.${subject}() << 1) | (this.#regops.${subject}() >> 7)) & 0xff)\n` +
          `  this.#regops.f(\n` +
          `      ((this.#regops.${subject}() & 0x01) ? this.#FREG_C : 0)\n` +
          `    | this.#flagTable.sz53p[this.#regops.${subject}()]\n` +
          `  )\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\)/)) {
        // from memory via register
        const register = subject.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#ram[this.#regops.${register}()] = ((this.#ram[this.#regops.${register}()] << 1) | (this.#ram[this.#regops.${register}()] >> 7)) & 0xff\n` +
          `  this.#regops.f(\n` +
          `      ((this.#ram[this.#regops.${register}()] & 0x01) ? this.#FREG_C : 0)\n` +
          `    | this.#flagTable.sz53p[this.#ram[this.#regops.${register}()]]\n` +
          `  )\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\+dd\)/)) {
        // from memory via register plus offset
        const indirParam = subject.match(/\((..)\+dd\)/)

        let secondAssignment = ''
        if (typeof dst !== 'undefined') {
          // assign the result to another register
          secondAssignment = `this.#regops.${dst}(`
        }

        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = (dd) => {\n` +
          `  const location = this.#regops.${indirParam[1]}() + this.#uint8ToInt8(dd)\n` +
          `  ${secondAssignment}this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff${secondAssignment ? ')' : ''}\n` +
          `  this.#regops.f(\n` +
          `      ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)\n` +
          `    | this.#flagTable.sz53p[this.#ram[location]]\n` +
          `  )\n` +
          `}\n`
        break
      }

      console.warn(`unhandled rlc param: ${mnemonic} ${param}`)
      break
    }

    case 'rl': {
      // rotate left & and incorporate carry flag if set; bit 7 is lost from the product
      // affects all flags; c as above, sz53p by table values
      const [subject, dst] = param.split(/,/)

      if (byteRegMatch(subject)) {
        // register mode
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const carry = (this.#regops.${subject}() & 0x80) ? this.#FREG_C : 0\n` +
          `  this.#regops.${subject}(((this.#regops.${subject}() << 1) | (carry ? 0x01 : 0x00)) & 0xff)\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.${subject}()])\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\)/)) {
        // from memory via register
        const register = subject.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const carry = (this.#ram[this.#regops.${register}()] & 0x80) ? this.#FREG_C : 0\n` +
          `  this.#ram[this.#regops.${register}()] = ((this.#ram[this.#regops.${register}()] << 1) | (carry ? 0x01: 0x00)) & 0xff\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.${register}()]])\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\+dd\)/)) {
        // from memory via register plus offset
        const indirParam = subject.match(/\((..)\+dd\)/)

        let secondAssignment = ''
        if (typeof dst !== 'undefined') {
          // assign the result to another register
          secondAssignment = `this.#regops.${dst}(`
        }

        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = (dd) => {\n` +
          `  const location = this.#regops.${indirParam[1]}() + this.#uint8ToInt8(dd)\n` +
          `  const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0\n` +
          `  ${secondAssignment}this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff${secondAssignment ? ')' : ''}\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])\n` +
          `}\n`
        break
      }

      console.warn(`unhandled rl param: ${mnemonic} ${param}`)
      break
    }

    case 'rrc': {
      // rotate right & carry 0 (to FREG_C and bit 7)
      // affects all flags; c as above, sz53p by table values
      const [subject, dst] = param.split(/,/)

      if (byteRegMatch(subject)) {
        // register mode
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.${subject}(((this.#regops.${subject}() << 7) | (this.#regops.${subject}() >> 1)) & 0xff)\n` +
          `  this.#regops.f(\n` +
          `      ((this.#regops.${subject}() & 0x80) ? this.#FREG_C : 0)\n` +
          `    | this.#flagTable.sz53p[this.#regops.${subject}()]\n` +
          `  )\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\)/)) {
        // from memory via register
        const register = subject.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#ram[this.#regops.${register}()] = ((this.#ram[this.#regops.${register}()] << 7) | (this.#ram[this.#regops.${register}()] >> 1)) & 0xff\n` +
          `  this.#regops.f(\n` +
          `      ((this.#ram[this.#regops.${register}()] & 0x80) ? this.#FREG_C : 0)\n` +
          `    | this.#flagTable.sz53p[this.#ram[this.#regops.${register}()]]\n` +
          `  )\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\+dd\)/)) {
        // from memory via register plus offset
        const indirParam = subject.match(/\((..)\+dd\)/)

        let secondAssignment = ''
        if (typeof dst !== 'undefined') {
          // assign the result to another register
          secondAssignment = `this.#regops.${dst}(`
        }

        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = (dd) => {\n` +
          `  const location = this.#regops.${indirParam[1]}() + this.#uint8ToInt8(dd)\n` +
          `  ${secondAssignment}this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff${secondAssignment ? ')' : ''}\n` +
          `  this.#regops.f(\n` +
          `      ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)\n` +
          `    | this.#flagTable.sz53p[this.#ram[location]]\n` +
          `  )\n` +
          `}\n`
        break
      }

      console.warn(`unhandled rrc param: ${mnemonic} ${param}`)
      break
    }

    case 'rr': {
      // rotate right & and incorporate carry flag; bit 0 is lost from the product
      // affects all flags; c as above, sz53p by table values
      const [subject, dst] = param.split(/,/)

      if (byteRegMatch(subject)) {
        // register mode
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const carry = (this.#regops.${subject}() & 0x01) ? this.#FREG_C : 0\n` +
          `  this.#regops.${subject}(((this.#regops.${subject}() >> 1) | (carry ? 0x80 : 0x00)) & 0xff)\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.${subject}()])\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\)/)) {
        // from memory via register
        const register = subject.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const carry = (this.#ram[this.#regops.${register}()] & 0x01) ? this.#FREG_C : 0\n` +
          `  this.#ram[this.#regops.${register}()] = ((this.#ram[this.#regops.${register}()] >> 1) | (carry ? 0x80 : 0x00)) & 0xff\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.${register}()]])\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\+dd\)/)) {
        // from memory via register plus offset
        const indirParam = subject.match(/\((..)\+dd\)/)

        let secondAssignment = ''
        if (typeof dst !== 'undefined') {
          // assign the result to another register
          secondAssignment = `this.#regops.${dst}(`
        }

        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = (dd) => {\n` +
          `  const location = this.#regops.${indirParam[1]}() + this.#uint8ToInt8(dd)\n` +
          `  const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0\n` +
          `  ${secondAssignment}this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff${secondAssignment ? ')': ''}\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])\n` +
          `}\n`
        break
      }

      console.warn(`unhandled rr param: ${mnemonic} ${param}`)
      break
    }

    case 'sla':
    case 'sll':
      // shift left, copy bit 7 to carry flag
      // flags as rl/rlc/rr/rrc
      const [subject, dst] = param.split(/,/)

      if (byteRegMatch(subject)) {
        // register mode
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const carry = (this.#regops.${subject}() & 0x80) ? this.#FREG_C : 0\n` +
          `  this.#regops.${subject}(((this.#regops.${subject}() << 1)${mnemonic === 'sll' ? ' | 0x01' : ''}) & 0xff)\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.${subject}()])\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\)/)) {
        // from memory via register
        const register = subject.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const carry = (this.#ram[this.#regops.${register}()] & 0x80) ? this.#FREG_C : 0\n` +
          `  this.#ram[this.#regops.${register}()] = ((this.#ram[this.#regops.${register}()] << 1)${mnemonic === 'sll' ? ' | 0x01' : ''}) & 0xff\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.${register}()]])\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\+dd\)/)) {
        // from memory via register plus offset
        const indirParam = subject.match(/\((..)\+dd\)/)

        let secondAssignment = ''
        if (typeof dst !== 'undefined') {
          // assign the result to another register
          secondAssignment = `this.#regops.${dst}(`
        }

        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = (dd) => {\n` +
          `  const location = this.#regops.${indirParam[1]}() + this.#uint8ToInt8(dd)\n` +
          `  const carry = (this.#ram[this.#regops.${register}()] & 0x80) ? this.#FREG_C : 0\n` +
          `  ${secondAssignment}this.#ram[location] = ((this.#ram[location] << 1)${mnemonic === 'sll' ? ' | 0x01' : ''}) & 0xff${secondAssignment ? ')' : ''}\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])\n` +
          `}\n`
        break
      }

      console.warn(`unhandled ${mnemonic} param: ${mnemonic} ${param}`)
      break

    case 'sra':
    case 'srl': {
      // sla but right
      const [subject, dst] = param.split(/,/)

      if (byteRegMatch(subject)) {
        // register mode
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const carry = (this.#regops.${subject}() & 0x01) ? this.#FREG_C : 0\n` +
          `  this.#regops.${subject}(((this.#regops.${subject}() >> 1)${mnemonic === 'srl' ? ' | 0x80' : ''}) & 0xff)\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.${subject}()])\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\)/)) {
        // from memory via register
        const register = subject.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  const carry = (this.#ram[this.#regops.${register}()] & 0x01) ? this.#FREG_C : 0\n` +
          `  this.#ram[this.#regops.${register}()] = ((this.#ram[this.#regops.${register}()] >> 1)${mnemonic === 'srl' ? ' | 0x80' : ''}) & 0xff\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.${register}()]])\n` +
          `}\n`
        break
      }

      if (subject.match(/\(..\+dd\)/)) {
        // from memory via register plus offset
        const indirParam = subject.match(/\((..)\+dd\)/)

        let secondAssignment = ''
        if (typeof dst !== 'undefined') {
          // assign the result to another register
          secondAssignment = `this.#regops.${dst}(`
        }

        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = (dd) => {\n` +
          `  const location = this.#regops.${indirParam[1]}() + this.#uint8ToInt8(dd)\n` +
          `  const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0\n` +
          `  ${secondAssignment}this.#ram[location] = ((this.#ram[location] >> 1)${mnemonic === 'srl' ? ' | 0x80' : ''}) & 0xff${secondAssignment ? ')' : ''}\n` +
          `  this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])\n` +
          `}\n`
        break
      }

      console.warn(`unhandled ${mnemonic} param: ${mnemonic} ${param}`)
      break
    }

    case 'bit': {
      // test bit N of register/memory and affect flags
      // as with most ops, f3 and f5 leak out of the tested register; c is retained, h is set
      // if the bit is NOT set, p and z are set

      const [bit, testSubject] = param.split(/,/)

      if (byteRegMatch(testSubject)) {
        // test subject is a register
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.f(\n` +
          `      (this.#regops.f() & this.#FREG_C)\n` +
          `    | this.#FREG_H\n` +
          `    | (this.#regops.${testSubject}() & (this.#FREG_F3 | this.#FREG_F5))\n` +
          `    | (((this.#regops.${testSubject}() & (1 << ${bit})) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)\n` +
          `  )\n` +
          `}\n`
        break
      }

      if (testSubject.match(/\(..\)/)) {
        // test subject is a memory location by register
        const register = testSubject.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#regops.f(\n` +
          `      (this.#regops.f() & this.#FREG_C)\n` +
          `    | this.#FREG_H\n` +
          `    | (this.#ram[this.#regops.${register}()] & (this.#FREG_F3 | this.#FREG_F5))\n` +
          `    | (((this.#ram[this.#regops.${register}()] & (1 << ${bit})) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)\n` +
          `  )\n` +
          `}\n`
        break
      }

      if (testSubject.match(/\(..\+dd\)/)) {
        // test subject is a memory location by register+offset
        const indirParam = testSubject.match(/\((..)\+dd\)/)

        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = (dd) => {\n` +
          `  const location = this.#regops.${indirParam[1]}() + this.#uint8ToInt8(dd)\n` +
          `  this.#regops.f(\n` +
          `      (this.#regops.f() & this.#FREG_C)\n` +
          `    | this.#FREG_H\n` +
          `    | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))\n` +
          `    | (((this.#ram[location] & (1 << ${bit})) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)\n` +
          `  )\n` +
          `}\n`
        break
      }

      console.warn(`unhandled bit param: ${mnemonic} ${param}`)
      break
    }

    case 'set':
    case 'res': {
      // set/reset (clear) bit N of register/memory. flags unaffected. & with inverted bitmap should suffice for reset.
      const [bit, testSubject, dst] = param.split(/,/)

      if (byteRegMatch(testSubject)) {
        // register mode
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => this.#regops.${testSubject}(this.#regops.${testSubject}() & ${(mnemonic === 'res') ? '~' : ''}(1 << ${bit}))\n`
        break
      }

      if (testSubject.match(/\(..\)/)) {
        // address mode
        const register = testSubject.replace(/[()]/g, '')
        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = () => {\n` +
          `  this.#ram[this.#regops.${register}()] = this.#ram[this.#regops.${register}()] & ${(mnemonic === 'res') ? '~' : ''}(1 << ${bit})\n` +
          `}\n`
        break
      }

      if (testSubject.match(/\(..\+dd\)/)) {
        // address+offset mode (dd should be signed so can read backwards)
        const indirParam = testSubject.match(/\((..)\+dd\)/)

        let secondAssignment = ''
        if (typeof dst !== 'undefined') {
          // assign the result to another register
          secondAssignment = `this.#regops.${dst}(`
        }

        outputBuffer += `// ${verbatimOp}\n` +
          `this.#opcodes${subtablePrefix}[${opcode}] = (dd) => {\n` +
          `  const location = this.#regops.${indirParam[1]}() + this.#uint8ToInt8(dd)\n` +
          `  ${secondAssignment}this.#ram[location] = this.#ram[location] & ${(mnemonic === 'res') ? '~' : ''}(1 << ${bit})${secondAssignment ? ')' : ''}\n` +
          `}\n`
        break
      }

      console.warn(`unhandled ${mnemonic} param: ${mnemonic} ${param}`)
      break
    }

    default:
      if (typeof unhandled[mnemonic] === 'undefined') {
        console.warn(`unhandled mnemonic: ${mnemonic}`)
        unhandled[mnemonic] = 0
      }
      unhandled[mnemonic]++
    }
})

try {
  fs.writeFileSync(outfile, outputBuffer)
} catch (e) {
  console.error(`Failed to write output file: ${e}`)
  process.exit(1)
}
