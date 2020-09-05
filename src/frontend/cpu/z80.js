/**
 * Z80 CPU simulator for javascript
 *
 * thanks to bitwise ops in javascript, many features of simulating a z80 cpu are made simple.
 * this includes handling 8- and 16-bit over/underflow, signs, etc.
 *
 * rob andrews <rob@aphlor.org>
 */
class ProcessorZ80
{
  // interrupts
  #interrupts = true

  // cpu registers (initial states)
  #registers = {
    // program counter
    pc: 0x0000,
    // stack pointer (works backwards; sp is always current pop val, push goes to sp--)
    sp: 0xffff,
    // accumulator & flags
    af: 0xffff,
    af2: 0xffff,
    // general purpose
    bc: 0x0000,
    bc2: 0x0000,
    de: 0x0000,
    de2: 0x0000,
    hl: 0x0000,
    hl2: 0x0000,
    // indirect
    ix: 0x0000,
    iy: 0x0000,
    i: 0x00,
    r: 0x00
  }

  // shorthand getter/setter access for registers, prevents having to recombine hi/lo bytes
  // into words before writing to registers in opcode emulation.
  // this REALLY helps with the translate_z80_tables.js dat->js generator.
  #regops = {
    // generic read/write (prefixed with _ to discourage use outside of here)
    _gen: (register, newVal) => {
      if (typeof newVal === 'undefined')
        return this.#registers[register]
      this.#registers[register] = newVal
    },
    // 8-bit ops (excluding i and r, which use {}._gen())
    _genHi: (register, newVal) => {
      if (typeof newVal === 'undefined')
        return this.#hi(this.#registers[register])
      this.#registers[register] = this.#word(newVal, this.#lo(this.#registers[register]))
    },
    _genLo: (register, newVal) => {
      if (typeof newVal === 'undefined')
        return this.#lo(this.#registers[register])
      this.#registers[register] = this.#word(this.#hi(this.#registers[register], newval))
    },

    // map the above three methods to shorthand register operations

    pc: (newPC) => this.#regops._gen('pc', newPC), // no 8-bit split
    sp: (newSP) => this.#regops._gen('sp', newSP), // no 8-bit split

    a: (newA) => this.#regops._genHi('af', newA),
    f: (newF) => this.#regops._genLo('af', newF),
    af: (newAF) => this.#regops._gen('af', newAF),
    af2: (newAF2) => this.#regops._gen('af2', newAF2),

    b: (newB) => this.#regops._genHi('bc', newB),
    c: (newC) => this.#regops._genLo('bc', newC),
    bc: (newBC) => this.#regops._gen('bc', newBC),
    bc2: (newBC2) => this.#regops._gen('bc2', newBC2),

    d: (newD) => this.#regops._genHi('de', newD),
    e: (newE) => this.#regops._genLo('de', newE),
    de: (newDE) => this.#regops._gen('de', newDE),
    de2: (newDE2) => this.#regops._gen('de2', newDE2),

    h: (newH) => this.#regops._genHi('hl', newH),
    l: (newL) => this.#regops._genLo('hl', newL),
    hl: (newHL) => this.#regops._gen('hl', newHL),
    hl2: (newHL2) => this.#regops._gen('hl2', newHL2),

    ixh: (newIXH) => this.#regops._genHi('ix', newIXH),
    ixl: (newIXL) => this.#regops._genLo('ix', newIXL),
    ix: (newIX) => this.#regops._gen('ix', newIX),

    iyh: (newIYH) => this.#regops._genHi('iy', newIYH),
    iyl: (newIYL) => this.#regops._genLo('iy', newIYL),
    iy: (newIY) => this.#regops._gen('iy', newIY),

    i: (newI) => this.#regops._gen('i', newI), // no 16-bit combination
    r: (newR) => this.#regops._gen('r', newR)  // no 16-bit combination
  }

  // F register bitmasks
  #FREG_C  = 0x01         // carry/borrow (inc/dec didn't fit in register)
  #FREG_N  = 0x02         // set if last opcode was subtraction
  #FREG_P  = 0x04         // parity
  #FREG_V  = this.#FREG_P // overflow (shared with parity)
  #FREG_F3 = 0x08         // undocumented (usually copy of P/V)
  #FREG_H  = 0x10         // half carry (3->4 during bcd; fuse's z80 core doesn't implement this)
  #FREG_F5 = 0x20         // undocumented (usually copy of H)
  #FREG_Z  = 0x40         // set if last used value is zero
  #FREG_S  = 0x80         // set if last used value is negative (if 2-comp & msb == 1, set)

  // memory area (64KB)
  #ram = new Uint8Array(Math.pow(2, 16))

  // opcode instruction table
  #opcodes = []

  // flag tables for F3, F5, Z and S flags (ported from philip kendall's z80.c line 133)
  #flagTable = {
    sz53: [],
    parity: [],
    sz53p: [], // will contain ORed values for adjacent array members of above
  }

  // half carry and overflow (underflow for sub?) tables. ported from fuse emulator with gratitude.
  #halfCarryAdd = [0, this.#FREG_H, this.#FREG_H, this.#FREG_H, 0, 0, 0, this.#FREG_H]
  #halfCarrySub = [0, 0, this.#FREG_H, 0, this.#FREG_H, 0, this.#FREG_H, this.#FREG_H]
  #overflowAdd = [0, 0, 0, this.#FREG_V, this.#FREG_V, 0, 0, 0]
  #overflowSub = [0, this.#FREG_V, 0, 0, 0, 0, this.#FREG_V, 0]

  /**
   * Generate the flagTable tables for sign, zero, parity/overflow, F3 and F5 undocumented flags.
   *
   * Ported directly from Philip Kendall's z80.c (fuse emulator), line 133, with immense gratitude.
   */
  #initialiseFlagTables = () => {
    for (let i = 0; i < 0x100; i++) {
      let [j, parity] = [i, 0]

      for (let k = 0; k < 8; k++) {
        parity ^= j & 1
        j >>= 1
      }

      this.#flagTable.sz53.push(i & (this.#FREG_F3 | this.#FREG_F5 | this.#FREG_S))
      this.#flagTable.parity.push(parity ? 0 : this.#FREG_P)
      this.#flagTable.sz53p.push(this.#flagTable.sz53[i] | this.#flagTable.parity[i])
    }

    // whatever happens, a value of zero always means the zero flag is set
    this.#flagTable.sz53[0] |= this.#FREG_Z
    this.#flagTable.sz53p[0] |= this.#FREG_Z
  }

  // Ported from Philip Kendall's ADD16, with changes by myself
  #add16 = (value1, value2) => {
    let [overflowedResult, finalResult] = [value1 + value2, this.#addWord(value1, value2)]
    let hcaLookup = ((value1 & 0x0800) >> 11) |
                    ((value2 & 0x0800) >> 10) |
                    ((overflowedResult & 0x0800) >> 9)

    // affect the flags according to the half carry add lookup and return the product
    // summary: v, z, s unaffected; c set if > 0xffff, f3 & f5 are weird
    this.#regops.f(
      this.#regops.f() & (this.#FREG_V | this.#FREG_Z | this.#FREG_S) |
      ((overflowedResult & 0x10000) ? this.#FREG_C : 0) |
      ((overflowedResult >> 8) & (this.#FREG_F3 | this.#FREG_F5)) |
      this.#halfCarryAdd[hcaLookup]
    )
    return finalResult
  }

  // ...and ported from Philip Kendall's ADD with changes by myself
  #add8 = (value1, value2) => {
    // in reality, all adds stack onto the accumulator, but let's retain convention with add16
    let [overflowedResult, finalResult] = [value1 + value2, this.#addByte(value1, value2)]
    let hcaLookup = ((value1 & 0x88) >> 3) |
                    ((value2 & 0x88) >> 2) |
                    ((overflowedResult & 0x88) >> 1)

    // flag affection; this is simpler in comparison to add16. unlike add16, add a,* affects ALL flags
    this.#regops.f(
      (overflowedResult & 0x100 ? this.#FREG_C : 0) |
      this.#halfCarryAdd[hcaLookup & 0x07] |
      this.#overflowAdd[hcaLookup >> 4] |
      this.#flagTable.sz53[finalResult]
    )

    return finalResult
  }

  // ...also PK's SUB with subtle changes
  #sub8 = (value1, value2) => {
    let [underflowedResult, finalResult] = [value1 - value2, this.#subByte(value1, value2)]
    let hcsLookup = ((value1 & 0x88) >> 3) |
                    ((value2 & 0x88) >> 2) |
                    ((underflowedResult & 0x88) >> 1)

    // flag affection (simple like add8; except N flag is set)
    this.#regops.f(
      (underflowedResult & 0x100 ? this.#FREG_C : 0) |
      this.#FREG_N |
      this.#halfCarrySub[hcsLookup & 0x07] |
      this.#overflowSub[hcsLookup >> 4] |
      this.#flagTable.sz53[value1]
    )
  }

  /**
   * Get the upper byte of a number (MSB)
   *
   * @param number  value Value to fetch 8 MSBs from
   * @return number
   */
  #hi = (value) => {
    return (value & 0xff00) >> 8
  }

  /**
   * Get the lower byte of a number (MSB)
   *
   * @param number  value Value to fetch 8 LSBs from
   * @return number
   */
  #lo = (value) => {
    return (value & 0x00ff) // no shift needed, it's the lsb already
  }

  /**
   * Create a word (16-bit value) from two bytes
   *
   * @param number high High byte for word
   * @param number low  Low byte for word
   * @return number
   */
  #word = (high, low) => {
    return (high << 8) | low
  }

  /**
   * Add two bytes
   *
   * @param number  base  Number to add to
   * @param number  value Number to add
   * @return number
   */
  #addByte = (base, value) => {
    return (base + value) & 0xff
  }

  /**
   * Add two words
   *
   * @param number  base  Number to add to
   * @param number  value Number to add
   * @return number
   */
  #addWord = (base, value) => {
    return (base + value) & 0xffff
  }

  /**
   * Subtract two bytes
   *
   * @param number  base  Number to sub to
   * @param number  value Number to sub
   * @return number
   */
  #subByte = (base, value) => {
    return (base - value) & 0xff
  }

  /**
   * Subtract two words
   *
   * @param number  base  Number to sub to
   * @param number  value Number to sub
   * @return number
   */
  #subWord = (base, value) => {
    return (base - value) & 0xffff
  }

  /**
   * Put a byte on the stack
   *
   * @param number  val Number to push
   */
  #pushByte = (val) => {
    this.#registers.sp = this.#subWord(this.#registers.sp, 1)
    this.#ram[this.#registers.sp] = val
  }

  /**
   * Pull a byte from the stack
   *
   * @return number
   */
  #popByte = () => {
    let stackByte = this.#ram[this.#registers.sp]
    this.#registers.sp = this.#addWord(this.#registers.sp, 1)
    return stackByte
  }

  /**
   * Put a word on the stack
   *
   * @param number  val Number to push
   */
  #pushWord = (val) => {
    this.#pushByte(this.#hi(val))
    this.#pushByte(this.#lo(val))
  }

  /**
   * Pull a word from the stack
   *
   * @return number
   */
  #popWord = () => {
    let [lo, hi] = [this.#popByte(), this.#popByte()]
    return this.#word(hi, lo)
  }

  /**
   * Shorthand get a byte from the program counter and inc pc
   *
   * @return number
   */
  #getPC = () => {
    let val = this.#ram[this.#registers.pc++]
    this.#registers.pc = this.#registers.pc & 0xffff
    return val
  }

  /**
   * Setup the opcodes in this.#opcodes ready for use
   * This seems like an unusual way of doing things, but:
   * - as of 2020, javascript cannot use hex numbers as numerical array indexes
   * - as of 2020, javascript does not have private class methods
   *
   * So in order to facilitate private methods, this is a private variable assigned
   * to an anonymous function which sets numerical array indexes to anonymous
   * functions using hex.
   *
   * @return void
   */
  #initOpcodes = () => {
    // START: this block is AUTOMATICALLY GENERATED SEE /z80_tables/*
    // END: this block is AUTOMATICALLY GENERATED SEE /z80_tables/*
  }

  /**
   * Constructor
   *
   * @param Uint8Array ram    64KB of memory for the CPU
   */
  constructor(ram = null)
  {
    // initialise memory to zero
    for (i = 0; i < Math.pow(2, 16); i++) {
      this.#ram[i] = 0
    }

    // we have a ram buffer to start with, so use that
    if (ram !== null) {
      this.#ram = ram
    }

    // initialise the F register flag tables
    this.#initialiseFlagTables()

    // setup the cpu opcodes
    this.#initOpcodes()
  }

  /**
   * Get a copy of the registers
   *
   * @return Object
   */
  getRegisters()
  {
    return this.#registers
  }

  /**
   * Fetch and execute an instruction
   *
   * @return void
   */
  fetchExecute()
  {
  }
}

export default ProcessorZ80
