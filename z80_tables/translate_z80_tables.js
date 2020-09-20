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
let unhandled = {}

splitInput.forEach((line) => {
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
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#regops.${parts[0]}(this.#word(hi, lo))\n}\n`
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
      // these ops are only 16-bit; don't need to worry about parity, half, etc.
      let [reg1, reg2] = param.split(/,/)

      if (reg1.length == 2 && ((reg2 === 'af\'') || (reg2.length == 2))) {
        // exchange between registers
        reg2 = reg2.replace(/^af'$/, 'af2')
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` +
          `  let temp = this.#regops.${reg1}()\n` +
          `  this.#regops.${reg1}(this.#regops.${reg2}())\n` +
          `  this.#regops.${reg2}(temp)\n` +
          `}\n`
        break
      }

      if (reg1.match(/\(..\)/)) {
        // exchange between ram and word register
        reg1 = reg1.replace(/[()]/g, '')
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` +
          `  let temp = this.#registers.${reg2}\n` +
          `  let [lo, hi] = [this.#ram[this.#registers.${reg1}], this.#ram[this.#addWord(this.#registers.${reg1}, 1)]]\n` +
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

    case 'di':
      // disable interrupts
      outputBuffer += `// ${mnemonic}\nthis.#opcodes[${opcode}] = () => { this.#interrupts = false }\n`
      break

    case 'ei':
      // enable interrupts
      outputBuffer += `// ${mnemonic}\nthis.#opcodes[${opcode}] = () => { this.#interrupts = true }\n`
      break

    case 'push':
      // push a value onto the stack (always a word)
      outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#pushWord(this.#registers.${param}) }\n`
      break

    case 'pop':
      // pop a value from the stack (always a word)
      outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#regops.${param}(this.#popWord()) }\n`
      break

    case 'inc':
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
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#registers.${param} = this.#addWord(this.#registers.${param}, 1) }\n`
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
          outputBuffer += `// ${mnemonic} ${param}\n` +
            `this.#opcodes[${opcode}] = () => {\n` +
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
          outputBuffer += `// ${mnemonic} ${param}\n` +
            `this.#opcodes[${opcode}] = () => {\n` +
            `  let old = this.#ram[this.#registers.hl]\n` +
            `  let new = this.#addByte(old, 1)\n` +
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

        default:
          console.warn(`unhandled inc param: ${mnemonic} ${param}`)
          break
      }
      break

    case 'dec':
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
          outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes[${opcode}] = () => { this.#registers.${param} = this.#subWord(this.#registers.${param}, 1) }\n`
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
          outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` +
          `  let old = this.#regops.${param}()\n` +
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
          outputBuffer += `// ${mnemonic} ${param}\n` +
            `this.#opcodes[${opcode}] = () => {\n` +
            `  let old = this.#ram[this.#registers.hl]\n` +
            `  let new = this.#subByte(old, 1)\n` +
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

        default:
          console.warn(`unhandled dec param: ${mnemonic} ${param}`)
          break
      }
      break

    case 'call':
    case 'jp':
      // call: call a subroutine (put pc on the stack so we can use ret)
      // jp: jump to another program location (change the pc to new location)
      let pushReturnAddress = (mnemonic == 'call')
        ? '  this.#pushWord(this.#registers.pc)\n'
        : ''

      if (param == 'nnnn') {
        // unconditional
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes.[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  this.#registers.pc = this.#word(hi, lo)\n${pushReturnAddress}}\n`
        break
      }

      if (mnemonic == 'jp' && param.match(/(hl|ix|iy)/)) {
        // unconditional using register value (jp only)
        outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes.[${opcode}] = () => { this.#registers.pc = this.#registers.${param} }\n`
        break
      }

      let [flagOp] = param.split(/,/)

      // leave early so we can shortcut the outputBuffer concat and save code
      // we do this because we ALWAYS need to pull the call address from pc&pc++,
      // even if we never meet the branch condition.
      if ('z,nz,c,nc,po,pe,p,m'.split(/,/).indexOf(flagOp) === -1) {
        console.warn(`unhandled call/jp param: ${mnemonic} ${param}`)
        break
      }

      outputBuffer += `// ${mnemonic} ${param}\nthis.#opcodes.[${opcode}] = () => {\n  let [lo, hi] = [this.#getPC(), this.#getPC()]\n  `
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
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
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
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
        `  this.#regops.f(\n` +
        `    this.#regops.f() | ((this.#regops.f() & this.#FREG_C) ? this.#FREG_H : this.#FREG_C)\n` +
        `    & ~(this.#FREG_F3 | this.#FREG_F5)\n` +
        `    | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `  )\n` +
        `}\n`
      break

    case 'add':
    case 'adc':
    {
      let [dst, src] = param.split(/,/)
      let carryPart = ''

      // check if mnemonic is 'adc' and account for the carry flag
      // funny how the carry flag isn't considered for overflow...
      if (mnemonic === 'adc') {
        // over/underflow is ok here as long as later ops clean up after this transaction
        carryPart = `  this.#regops.${dst}(this.this.#regops.${dst} + (this.#regops.f() & this.#FREG_C ? 1 : 0))\n`
      }

      if (dst.length == 2 && src.length == 2) {
        // reg word+reg word (destination is ALWAYS hl)
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add16(this.#regops.${dst}(), this.#regops.${src}()))\n` +
          `}\n`
        break
      }

      if (dst.length == 1 && src.length == 1) {
        // reg byte+reg byte (destination is ALWAYS a)
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add8(this.#regops.${dst}(), this.#regops.${src}()))\n` +
          `}\n`
        break
      }

      if (dst.length == 1 && src === 'nn') {
        // reg byte+byte
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add8(this.#regops.${dst}(), this.#getPC()))\n` +
          `}\n`
        break
      }

      if (dst.length == 1 && src.match(/\(..\)/)) {
        // byte add to a from memory location
        src = src.replace(/[()]/g, '')
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#add8(this.#regops.${dst}(), this.#ram[this.#regops.${src}()])\n` +
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

      if (dst.length == 1 && src.length == 1) {
        // reg byte-reg byte (destination always a)
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#sub8(this.#regops.${dst}(), this.#regops.${src}()))\n` +
          `}\n`
        break
      }

      // zilog mnemonic is 'sub nn', but for convention with add, support 'sub a,nn'
      if ((dst === 'nn' && typeof src === 'undefined') || (dst.length == 1 && src === 'nn')) {
        // reg byte-byte
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#sub8(this.#regops.${dst}(), this.#getPC()))\n` +
          `}\n`
        break
      }

      if (dst.length == 1 && src.match(/\(..\)/)) {
        // byte sub from a from memory location
        src = src.replace(/[()]/g, '')
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` + carryPart +
          `  this.#regops.${dst}(this.#sub8(this.#regops.${dst}(), this.#ram[this.#regops.${src}()])\n` +
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
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
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
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
        `  let carry = (this.#regops.f() & this.#FREG_C) ? 0x01 : 0x00\n` +
        `  let newCarry = (this.#regops.a() & 0x80) ? this.#FREG_C : 0\n` +
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
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
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
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
        `  let carry = (this.#regops.f() & this.#FREG_C) ? 0x80 : 0x00\n` +
        `  let newCarry = (this.#regops.a() & 0x01) ? this.#FREG_C : 0\n` +
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
      outputBuffer += `// ${mnemonic}\nthis.#opcodes[${opcode}] = () => { throw 'cpu halted by opcode' }\n`
      break

    case 'shift':
      // the opcode is a prefix to another table of opcodes (which can, in turn open another table of opcodes, i.e. $ddcb/$fdcb)
      outputBuffer += `// ${mnemonic} ${param} (subtable of operations)\nthis.#opcodes[${opcode}] = []\n`
      break

    case 'djnz':
      // dec b, if it's not zero, jump to pc+offset (signed)
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
        `  let [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]\n` +
        `  this.#regops.b(this.#sub8(this.#regops.b(), 1))\n` +
        `  if (this.#regops.b())\n` +
        `    this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))\n` +
        `}\n`
      break

    case 'jr':
      // like djnz, but either unconditional or based on flags

      if (param === 'offset') {
        // unconditional
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` +
          `  let [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]\n` +
          `  this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))\n` +
        `}\n`
        break
      }

      let [flag] = param.split(/,/)
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

      outputBuffer += `// ${mnemonic} ${param}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
        `  let [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]\n` +
        `  if (${condition})\n` +
        `    this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))\n` +
        `}\n`

      break

    case 'daa':
      // decimal adjust after addition; adjust a to contain two digit packed decimal
      // ported from fuse owing to not being sure how the BCD opcodes work
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
        `  let [add, carry] = [0, this.#regops.f() & this.#FREG_C]\n` +
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
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n`

        outputBuffer += mnemonic == 'in'
          ? `  this.#regops.a(this.#callIoHandler(this.#getPC(), 'r'))`
          : `  this.#callIoHandler(this.#getPC(), 'w', this.#regops.a())`

        outputBuffer += `\n}\n`
        break
      }

      console.warn(`unhandled ${mnemonic} param: ${mnenonic} ${param}`)
      break

    case 'cpl':
      // invert each bit in accumulator; leak f3 & f5, set n & h, retain cpzs
      outputBuffer += `// ${mnemonic}\n` +
        `this.#opcodes[${opcode}] = () => {\n` +
        `  this.#regops.a(this.#regops.a() ^ 0xff)\n` +
        `  this.#regops.f(\n` +
        `      this.#regops.f()\n` +
        `    & (this.#FREG_C | this.#FREG_P | this.#FREG_Z | this.#FREG_S)\n` +
        `    | (this.regops.a() & (this.#FREG_F3 | this.#FREG_F5))\n` +
        `    | this.#FREG_N | this.#FREG_H\n` +
        `  )\n` +
        `}\n`
      break

    case 'and':
      // bitwise and on a register, storing result in the first register (accumulator)
      // always sets h flag; every other flag is affected. trust nothing!
      let adjustedParam = (param === 'nn')
        ? 'a,nn'
        : param

      let [dst, src] = adjustedParam.split(/,/)

      if (dst.length === 1 && ((src.length === 1) || (src.length === 3))) {
        // src is register (three letter registers are ixh/ixl/iyh/iyl)
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` +
          `  this.#regops.${dst}(this.#regops.${dst}() & this.#regops.${src}())\n` +
          `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)\n` +
          `}\n`
        break
      }

      if (src === 'nn') {
        // src is a byte following the opcode
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` +
          `  this.#regops.${dst}(this.#regops.${dst}() & this.#getPC())\n` +
          `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)\n` +
          `}\n`
        break
      }

      if (src.match(/\(..\)/)) {
        // src is read from a location by register
        src = src.replace(/[()]/g, '')
        outputBuffer += `// ${mnemonic} ${param}\n` +
          `this.#opcodes[${opcode}] = () => {\n` +
          `  this.#regops.${dst}(this.#regops.${dst}() & this.#ram[this.#regops.${src}()])\n` +
          `  this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)\n` +
          `}\n`
        break
      }

      console.warn(`unhandled and param: ${mnemonic} ${param}`)
      break

    default:
      if (typeof unhandled[mnemonic] === 'undefined') {
        console.warn(`unhandled mnemonic: ${mnemonic}`)
        unhandled[mnemonic] = 0
      }
      unhandled[mnemonic]++
    }
})

console.log(outputBuffer)
