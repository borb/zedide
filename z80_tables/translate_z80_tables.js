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
  param = (typeof param !== 'undefined') ? param.toLowerCase() : undefined

  // @todo handle f register flags

  switch (mnemonic) {
    case 'nop':
      // do nothing
      outputBuffer += `// ${mnemonic}\nthis.#opcodes[${opcode}] = () => {}\n`
      break
    case 'ld':
      // load instruction: determine if direct between registers, to/from memory, etc.
      let parts = param.split(/,/)

      if (parts[0].length == 1 && parts[1].length == 1) {
        // simple byte register copy
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#registers.${parts[0]} = this.#registers.${parts[1]} }\n`
        break
      }

      if (parts[0].length == 2 && parts[1].length == 2) {
        // simple word register copy (break into bytes)
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  this.#registers.${parts[0][0]} = this.#registers.${parts[1][0]}\n  this.#registers.${parts[0][1]} = this.#registers.${parts[1][1]}\n}\n`
        break
      }

      if (parts[0] == '(nnnn)' && parts[1].length == 1) {
        // write byte register to memory
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#ram[this.#word(hi, lo)] = this.#registers.${parts[1]}\n}\n`
      }

      console.warn(`unhandled ld type: ${mnemonic} ${param}`)
      break

  }
})

console.log(outputBuffer)
