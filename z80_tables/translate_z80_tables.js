#!/usr/bin/env node
import fs from 'fs'
/**
 * a hacky script to turn Philip Kendall's opcode tables into javascript source.
 * brace yourself.
 */
const [infile, outfile] = [process.argv[2], process.argv[3]]

if (typeof infile === 'undefined' || typeof outfile === 'undefined') {
  console.error('Please specify an input file and an output file.')
  process.exit(10)
}

if (!fs.existsSync(infile)) {
  console.error('Input file does not exist.')
  process.exit(11)
}

let input
try {
  input = fs.readFileSync(infile)
} catch (e) {
  console.error('Failed to read input file.')
  process.exit(12)
}

let splitInput = input.toString().split(/\n/).filter((line) => {
  // drop empty lines and comments
  if (line === '')
    return false
  if (line[0] === '#')
    return false
  return true
})

let outputBuffer = ''

splitInput.forEach((line) => {
  // each opcode line is in the format:
  // <byte> <instruction> <argument>
  // argument can be a number of things, we will branch accordingly (and parse accordingly)
  let [opcode, mnemonic, param] = line.split(/ /)
  mnemonic = mnemonic.toLowerCase()
  param = (typeof param !== 'undefined')
    ? param.toLowerCase()
    : undefined

  // @todo handle f register flags

  switch (mnemonic) {
    case 'nop':
      // do nothing
      // flags unaffected
      outputBuffer += `// ${mnemonic}\nthis.#opcodes[${opcode}] = () => {}\n`
      break

    case 'ld': {
      // load instruction: determine if direct between registers, to/from memory, etc.
      // flags unaffected
      const parts = param.split(/,/)

      if ((parts[0].length == 1 && parts[1].length == 1)
          || (parts[0].length == 2 && parts[1].length == 2)) {
        // simple byte/word register copy
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#regops.${parts[0]}(this.#regops.${parts[1]}()) }\n`
        break
      }

      if (parts[0].length == 1 && parts[1] == 'nn') {
        // simple byte load
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#regops.${parts[0]}(this.#getPC()) }\n`
        break
      }

      if (parts[0].length == 2 && parts[1] == 'nnnn') {
        // simple word load
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#regops.${parts[0]}(this.#word(hi, lo)) }\n`
        break
      }

      if (parts[0] == '(nnnn)' && parts[1].length == 1) {
        // write byte register to memory
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#ram[this.#word(hi, lo)] = this.#regops.${parts[1]}()\n}\n`
        break
      }

      if (parts[0] == '(nnnn)' && parts[1].length == 2) {
        // write word register to memory
        let [msb, lsb] = parts[1].split('')
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#ram[this.#word(hi, lo)] = this.#regops.${lsb}()\n  this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.${msb}()\n}\n`
        break
      }

      if (parts[0].length == 1 && parts[1] == '(nnnn)') {
        // load memory to byte register
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#regops.${parts[0]}(this.#ram[this.#word(hi, lo)])\n}\n`
        break
      }

      if (parts[0].length == 2 && parts[1] == '(nnnn)') {
        // load memory to word register
        let [msb, lsb] = parts[1].split('')
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#regops.${lsb}(this.#ram[this.#word(hi, lo)])\n  this.#regops.${msb}(this.#ram[this.#addWord(this.#word(hi, lo), 1)])\n}\n`
        break
      }

      if (parts[0].match(/\(..\)/) && parts[1] == 'nn') {
        let register = parts[0].replace(/[()]/g, '')
        // write byte to memory by register
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#ram[this.#regops.${register}()] = this.#getPC() }\n`
        break
      }

      if (parts[0].match(/\(..\)/) && parts[1].length == 1) {
        let register = parts[0].replace(/[()]/g, '')
        // write 8-bit register to memory by register
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#ram[this.#regops.${register}()] = this.#regops.${parts[1]}() }\n`
        break
      }

      if (parts[0].length == 1 && parts[1].match(/\(..\)/)) {
        let register = parts[1].replace(/[()]/g, '')
        // load 8-bit register from memory by register
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#regops.${parts[0]}(this.#ram[this.#regops.${register}()]) }\n`
        break
      }

      console.warn(`unhandled ld type: ${mnemonic} ${param}`)
      break
    }

    case 'exx':
      // swap bc, de, hl with bc', de', hl'
      outputBuffer += `// ${mnemonic}\nthis.#opcodes[${opcode}] = () => {\n  let [bc, de, hl] = [this.#regops.bc(), this.#regops.de(), this.#regops.hl()]\n  this.#regops.bc(this.#regops.bc2())\n  this.#regops.de(this.#regops.de2())\n  this.#regops.hl(this.#regops.hl2())\n  this.#regops.bc2(bc)\n  this.#regops.de2(de)\n  this.#regops.hl2(hl)\n}\n`
      break

    case 'ex':
      // exchange values with each other
      if (param == 'af,af\'') {
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  let af = this.#regops.af()\n  this.#regops.af(this.#regops.af2())\n  this.#regops.af2(af)\n}\n`
        break
      }

      console.warn(`unhandled ex param: ${mnemonic} ${param}`)
      break

    case 'ret':
      // return from a subroutine call (pop word from sp and load into pc)
      if (typeof param === 'undefined') {
        outputBuffer += `// ${mnemonic}\nthis.#opcodes[${opcode}] = () => { this.#regops.pc(this.#popWord()) }\n`
        break
      }

      switch (param) {
        case 'z': // zero bit
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () {\n  if (this.#regops.f() & this.#FREG_Z)\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'nz': // zero bit
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () {\n  if (!(this.#regops.f() & this.#FREG_Z))\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'c': // carry flag bit
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () {\n  if (this.#regops.f() & this.#FREG_C)\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'nc': // carry flag bit
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () {\n  if (!(this.#regops.f() & this.#FREG_C))\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'pe': // parity flag bit (equal)
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () {\n  if (this.#regops.f() & this.#FREG_P)\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'po': // parity flag bit (odd)
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () {\n  if (!(this.#regops.f() & this.#FREG_P))\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'p': // sign bit (what is 'p'?)
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () {\n  if (!(this.#regops.f() & this.#FREG_S))\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        case 'm': // sign bit (what is 'm'?)
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () {\n  if (this.#regops.f() & this.#FREG_S)\n    this.#regops.pc(this.#popWord())\n}\n`
          break

        default:
          console.warn(`unhandled ret param: ${mnemonic} ${param}`)
          break
      }

      break

    default:
      console.warn(`unhandled mnemonic: ${mnemonic}`)

  }
})

console.log(outputBuffer)
