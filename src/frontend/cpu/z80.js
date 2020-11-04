'use strict'

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
    r: 0x00,
    // interrupt mode
    im: 0
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
      this.#registers[register] = this.#word(this.#hi(this.#registers[register]), newVal)
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

  // input/output handlers
  #ioHandlers = []

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

  // ...PK's SUB for 16-bit ops
  #sub16 = (value1, value2) => {
    let [underflowedResult, finalResult] = [value1 - value2, this.#subWord(value1, value2)]
    let hcsLookup = (((value1 & 0x8800) >> 11) |
                     ((value2 & 0x8800) >> 10) |
                     ((underflowedResult & 0x8800) >> 9)) & 0xff

    // affect the flags for half carry sub, return product
    this.#regops.f(
      (underflowedResult & 0x10000 ? this.#FREG_C : 0) |
      this.#FREG_N |
      this.#overflowSub[hcsLookup >> 4] |
      this.#halfCarrySub[hcsLookup & 0x07] |
      (finalResult === 0 ? this.#FREG_Z : 0) |
      ((finalResult >> 8) & (this.#FREG_F3 | this.#FREG_F5 | this.#FREG_S))
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
    let [underflowedResult, finalResult] = [this.#subWord(value1, value2), this.#subByte(value1, value2)]
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

    return finalResult
  }

  // PK's CP; honestly, zilog/intel - if cp is like sub without storing the product, why is it so different?
  #cp8 = (value1, value2) => {
    let tempResult = this.#subWord(value1, value2)
    let hcsLookup = ((value1 & 0x88) >> 3) |
                    ((value2 & 0x88) >> 2) |
                    ((tempResult & 0x88) >> 1)

    // flag affection (simple like add8; except N flag is set)
    this.#regops.f(
      (tempResult & 0x100 ? this.#FREG_C : (tempResult ? 0 : this.#FREG_Z)) |
      this.#FREG_N |
      this.#halfCarrySub[hcsLookup & 0x07] |
      this.#overflowSub[hcsLookup >> 4] |
      (value2 & (this.#FREG_F3 | this.#FREG_F5)) |
      (tempResult & this.#FREG_S)
    )
  }

  /**
   * Get the upper byte of a number (MSB)
   *
   * @param number  value Value to fetch 8 MSBs from
   * @return number
   */
  #hi = (value) => (value & 0xff00) >> 8

  /**
   * Get the lower byte of a number (MSB)
   *
   * @param number  value Value to fetch 8 LSBs from
   * @return number
   */
  #lo = (value) => (value & 0x00ff) // no shift needed, it's the lsb already

  /**
   * Create a word (16-bit value) from two bytes
   *
   * @param number high High byte for word
   * @param number low  Low byte for word
   * @return number
   */
  #word = (high, low) => (high << 8) | low

  /**
   * Add two bytes
   *
   * @param number  base  Number to add to
   * @param number  value Number to add
   * @return number
   */
  #addByte = (base, value) => (base + value) & 0xff

  /**
   * Add two words
   *
   * @param number  base  Number to add to
   * @param number  value Number to add
   * @return number
   */
  #addWord = (base, value) => (base + value) & 0xffff

  /**
   * Subtract two bytes
   *
   * @param number  base  Number to sub to
   * @param number  value Number to sub
   * @return number
   */
  #subByte = (base, value) => (base - value) & 0xff

  /**
   * Subtract two words
   *
   * @param number  base  Number to sub to
   * @param number  value Number to sub
   * @return number
   */
  #subWord = (base, value) => (base - value) & 0xffff

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
   * Change unsigned 8-bit integer into signed 8-bit integer (two's compliment);
   * mathematically, this is akin to saying "if bit 8 is set, invert and deduct from -1"
   * but simplified you can perform a numerical comparison and deduct 0x100
   *
   * @param number val  Value to convert to int8
   * @return number
   */
  #uint8ToInt8 = (val) => val > 127 ? val - 256 : val

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
    // nop
    this.#opcodes[0x00] = () => {}
    // ld bc,nnnn
    this.#opcodes[0x01] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.bc(this.#word(hi, lo))
    }
    // ld (bc),a
    this.#opcodes[0x02] = () => { this.#ram[this.#regops.bc()] = this.#regops.a() }
    // inc bc
    this.#opcodes[0x03] = () => { this.#registers.bc = this.#addWord(this.#registers.bc, 1) }
    // inc b
    this.#opcodes[0x04] = () => {
      this.#regops.b(this.#addByte(this.#regops.b(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.b() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.b()]
      )
    }
    // dec b
    this.#opcodes[0x05] = () => {
      const old = this.#regops.b()
      this.#regops.b(this.#subByte(this.#regops.b(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.b() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.b()]
      )
    }
    // ld b,nn
    this.#opcodes[0x06] = () => { this.#regops.b(this.#getPC()) }
    // rlca
    this.#opcodes[0x07] = () => {
      this.#regops.a(this.#lo((this.#regops.a() << 1) | (this.#regops.a() >> 7)))
      this.#regops.f(
        (this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S))
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | ((this.#regops.a() & 0x01) ? this.#FREG_C : 0)
      )
    }
    // ex af,af'
    this.#opcodes[0x08] = () => {
      const temp = this.#regops.af()
      this.#regops.af(this.#regops.af2())
      this.#regops.af2(temp)
    }
    // add hl,bc
    this.#opcodes[0x09] = () => {
      this.#regops.hl(this.#add16(this.#regops.hl(), this.#regops.bc()))
    }
    // ld a,(bc)
    this.#opcodes[0x0a] = () => { this.#regops.a(this.#ram[this.#regops.bc()]) }
    // dec bc
    this.#opcodes[0x0b] = () => { this.#registers.bc = this.#subWord(this.#registers.bc, 1) }
    // inc c
    this.#opcodes[0x0c] = () => {
      this.#regops.c(this.#addByte(this.#regops.c(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.c() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.c()]
      )
    }
    // dec c
    this.#opcodes[0x0d] = () => {
      const old = this.#regops.c()
      this.#regops.c(this.#subByte(this.#regops.c(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.c() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.c()]
      )
    }
    // ld c,nn
    this.#opcodes[0x0e] = () => { this.#regops.c(this.#getPC()) }
    // rrca
    this.#opcodes[0x0f] = () => {
      this.#regops.a(this.#lo((this.#regops.a() << 7) | (this.#regops.a() >> 1)))
      this.#regops.f(
        (this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S))
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | ((this.#regops.a() & 0x80) ? this.#FREG_C : 0)
      )
    }
    // djnz offset
    this.#opcodes[0x10] = () => {
      const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]
      this.#regops.b(this.#sub8(this.#regops.b(), 1))
      if (this.#regops.b())
        this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))
    }
    // ld de,nnnn
    this.#opcodes[0x11] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.de(this.#word(hi, lo))
    }
    // ld (de),a
    this.#opcodes[0x12] = () => { this.#ram[this.#regops.de()] = this.#regops.a() }
    // inc de
    this.#opcodes[0x13] = () => { this.#registers.de = this.#addWord(this.#registers.de, 1) }
    // inc d
    this.#opcodes[0x14] = () => {
      this.#regops.d(this.#addByte(this.#regops.d(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.d() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.d()]
      )
    }
    // dec d
    this.#opcodes[0x15] = () => {
      const old = this.#regops.d()
      this.#regops.d(this.#subByte(this.#regops.d(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.d() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.d()]
      )
    }
    // ld d,nn
    this.#opcodes[0x16] = () => { this.#regops.d(this.#getPC()) }
    // rla
    this.#opcodes[0x17] = () => {
      const carry = (this.#regops.f() & this.#FREG_C) ? 0x01 : 0x00
      const newCarry = (this.#regops.a() & 0x80) ? this.#FREG_C : 0
      this.#regops.a(this.#lo((this.#regops.a() << 1) | carry))
      this.#regops.f(
        (this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S))
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | newCarry
      )
    }
    // jr offset
    this.#opcodes[0x18] = () => {
      const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]
      this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))
    }
    // add hl,de
    this.#opcodes[0x19] = () => {
      this.#regops.hl(this.#add16(this.#regops.hl(), this.#regops.de()))
    }
    // ld a,(de)
    this.#opcodes[0x1a] = () => { this.#regops.a(this.#ram[this.#regops.de()]) }
    // dec de
    this.#opcodes[0x1b] = () => { this.#registers.de = this.#subWord(this.#registers.de, 1) }
    // inc e
    this.#opcodes[0x1c] = () => {
      this.#regops.e(this.#addByte(this.#regops.e(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.e() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.e()]
      )
    }
    // dec e
    this.#opcodes[0x1d] = () => {
      const old = this.#regops.e()
      this.#regops.e(this.#subByte(this.#regops.e(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.e() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.e()]
      )
    }
    // ld e,nn
    this.#opcodes[0x1e] = () => { this.#regops.e(this.#getPC()) }
    // rra
    this.#opcodes[0x1f] = () => {
      const carry = (this.#regops.f() & this.#FREG_C) ? 0x80 : 0x00
      const newCarry = (this.#regops.a() & 0x01) ? this.#FREG_C : 0
      this.#regops.a(this.#lo((this.#regops.a() >> 1) | carry))
      this.#regops.f(
        (this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S))
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | newCarry
      )
    }
    // jr nz,offset
    this.#opcodes[0x20] = () => {
      const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]
      if ((this.#regops.f() & this.#FREG_Z) == 0)
        this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))
    }
    // ld hl,nnnn
    this.#opcodes[0x21] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.hl(this.#word(hi, lo))
    }
    // ld (nnnn),hl
    this.#opcodes[0x22] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#ram[this.#word(hi, lo)] = this.#regops.l()
      this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.h()
    }
    // inc hl
    this.#opcodes[0x23] = () => { this.#registers.hl = this.#addWord(this.#registers.hl, 1) }
    // inc h
    this.#opcodes[0x24] = () => {
      this.#regops.h(this.#addByte(this.#regops.h(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.h() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.h()]
      )
    }
    // dec h
    this.#opcodes[0x25] = () => {
      const old = this.#regops.h()
      this.#regops.h(this.#subByte(this.#regops.h(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.h() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.h()]
      )
    }
    // ld h,nn
    this.#opcodes[0x26] = () => { this.#regops.h(this.#getPC()) }
    // daa
    this.#opcodes[0x27] = () => {
      const [add, carry] = [0, this.#regops.f() & this.#FREG_C]

      if ((this.#regops.f() & this.#FREG_H) || ((this.#regops.a() & 0x0f) > 9))
        add = 6
      if (carry || (this.#regops.a() > 0x99))
        add |= 0x60
      if (this.#regops.a() > 0x99)
        carry = this.#FREG_C

      if (this.#regops.f() & this.#FREG_N)
        this.#regops.a(this.#sub8(this.#regops.a(), add))
      else
        this.#regops.a(this.#add8(this.#regops.a(), add))

      this.#regops.f(
          this.#regops.f()
        & ~(this.#FREG_C | this.#FREG_P)
        | carry
        | this.#flagTable.parity[this.#regops.a()]
      )
    }
    // jr z,offset
    this.#opcodes[0x28] = () => {
      const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]
      if (this.#regops.f() & this.#FREG_Z)
        this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))
    }
    // add hl,hl
    this.#opcodes[0x29] = () => {
      this.#regops.hl(this.#add16(this.#regops.hl(), this.#regops.hl()))
    }
    // ld hl,(nnnn)
    this.#opcodes[0x2a] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.l(this.#ram[this.#word(hi, lo)])
      this.#regops.h(this.#ram[this.#addWord(this.#word(hi, lo), 1)])
    }
    // dec hl
    this.#opcodes[0x2b] = () => { this.#registers.hl = this.#subWord(this.#registers.hl, 1) }
    // inc l
    this.#opcodes[0x2c] = () => {
      this.#regops.l(this.#addByte(this.#regops.l(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.l() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.l()]
      )
    }
    // dec l
    this.#opcodes[0x2d] = () => {
      const old = this.#regops.l()
      this.#regops.l(this.#subByte(this.#regops.l(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.l() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.l()]
      )
    }
    // ld l,nn
    this.#opcodes[0x2e] = () => { this.#regops.l(this.#getPC()) }
    // cpl
    this.#opcodes[0x2f] = () => {
      this.#regops.a(this.#regops.a() ^ 0xff)
      this.#regops.f(
          this.#regops.f()
        & (this.#FREG_C | this.#FREG_P | this.#FREG_Z | this.#FREG_S)
        | (this.regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | this.#FREG_N | this.#FREG_H
      )
    }
    // jr nc,offset
    this.#opcodes[0x30] = () => {
      const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]
      if ((this.#regops.f() & this.#FREG_C) == 0)
        this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))
    }
    // ld sp,nnnn
    this.#opcodes[0x31] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.sp(this.#word(hi, lo))
    }
    // ld (nnnn),a
    this.#opcodes[0x32] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#ram[this.#word(hi, lo)] = this.#regops.a()
    }
    // inc sp
    this.#opcodes[0x33] = () => { this.#registers.sp = this.#addWord(this.#registers.sp, 1) }
    // inc (hl)
    this.#opcodes[0x34] = () => {
      const oldByte = this.#ram[this.#registers.hl]
      const newByte = this.#addByte(oldByte, 1)
      this.#ram[this.#registers.hl] = newByte
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((oldByte & 0x0f) ? 0 : this.#FREG_H)
        | ((newByte == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[newByte]
      )
    }
    // dec (hl)
    this.#opcodes[0x35] = () => {
      const oldByte = this.#ram[this.#registers.hl]
      const newByte = this.#subByte(oldByte, 1)
      this.#ram[this.#registers.hl] = newByte
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((oldByte & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((newByte == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[newByte]
      )
    }
    // ld (hl),nn
    this.#opcodes[0x36] = () => { this.#ram[this.#regops.hl()] = this.#getPC() }
    // scf
    this.#opcodes[0x37] = () => {
      this.#regops.f(
        this.#regops.f() & (this.#FREG_P | this.#FREG_Z | this.#FREG_S)
        | this.#FREG_C
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
      )
    }
    // jr c,offset
    this.#opcodes[0x38] = () => {
      const [offset, instructionBase] = [this.#getPC(), this.#registers.pc - 2]
      if (this.#regops.f() & this.#FREG_C)
        this.#registers.pc = this.#addWord(instructionBase, this.#uint8ToInt8(offset))
    }
    // add hl,sp
    this.#opcodes[0x39] = () => {
      this.#regops.hl(this.#add16(this.#regops.hl(), this.#regops.sp()))
    }
    // ld a,(nnnn)
    this.#opcodes[0x3a] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.a(this.#ram[this.#word(hi, lo)])
    }
    // dec sp
    this.#opcodes[0x3b] = () => { this.#registers.sp = this.#subWord(this.#registers.sp, 1) }
    // inc a
    this.#opcodes[0x3c] = () => {
      this.#regops.a(this.#addByte(this.#regops.a(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.a() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.a()]
      )
    }
    // dec a
    this.#opcodes[0x3d] = () => {
      const old = this.#regops.a()
      this.#regops.a(this.#subByte(this.#regops.a(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.a() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.a()]
      )
    }
    // ld a,nn
    this.#opcodes[0x3e] = () => { this.#regops.a(this.#getPC()) }
    // ccf
    this.#opcodes[0x3f] = () => {
      this.#regops.f(
        this.#regops.f() | ((this.#regops.f() & this.#FREG_C) ? this.#FREG_H : this.#FREG_C)
        & ~(this.#FREG_F3 | this.#FREG_F5)
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
      )
    }
    // ld b,b
    this.#opcodes[0x40] = () => { this.#regops.b(this.#regops.b()) }
    // ld b,c
    this.#opcodes[0x41] = () => { this.#regops.b(this.#regops.c()) }
    // ld b,d
    this.#opcodes[0x42] = () => { this.#regops.b(this.#regops.d()) }
    // ld b,e
    this.#opcodes[0x43] = () => { this.#regops.b(this.#regops.e()) }
    // ld b,h
    this.#opcodes[0x44] = () => { this.#regops.b(this.#regops.h()) }
    // ld b,l
    this.#opcodes[0x45] = () => { this.#regops.b(this.#regops.l()) }
    // ld b,(hl)
    this.#opcodes[0x46] = () => { this.#regops.b(this.#ram[this.#regops.hl()]) }
    // ld b,a
    this.#opcodes[0x47] = () => { this.#regops.b(this.#regops.a()) }
    // ld c,b
    this.#opcodes[0x48] = () => { this.#regops.c(this.#regops.b()) }
    // ld c,c
    this.#opcodes[0x49] = () => { this.#regops.c(this.#regops.c()) }
    // ld c,d
    this.#opcodes[0x4a] = () => { this.#regops.c(this.#regops.d()) }
    // ld c,e
    this.#opcodes[0x4b] = () => { this.#regops.c(this.#regops.e()) }
    // ld c,h
    this.#opcodes[0x4c] = () => { this.#regops.c(this.#regops.h()) }
    // ld c,l
    this.#opcodes[0x4d] = () => { this.#regops.c(this.#regops.l()) }
    // ld c,(hl)
    this.#opcodes[0x4e] = () => { this.#regops.c(this.#ram[this.#regops.hl()]) }
    // ld c,a
    this.#opcodes[0x4f] = () => { this.#regops.c(this.#regops.a()) }
    // ld d,b
    this.#opcodes[0x50] = () => { this.#regops.d(this.#regops.b()) }
    // ld d,c
    this.#opcodes[0x51] = () => { this.#regops.d(this.#regops.c()) }
    // ld d,d
    this.#opcodes[0x52] = () => { this.#regops.d(this.#regops.d()) }
    // ld d,e
    this.#opcodes[0x53] = () => { this.#regops.d(this.#regops.e()) }
    // ld d,h
    this.#opcodes[0x54] = () => { this.#regops.d(this.#regops.h()) }
    // ld d,l
    this.#opcodes[0x55] = () => { this.#regops.d(this.#regops.l()) }
    // ld d,(hl)
    this.#opcodes[0x56] = () => { this.#regops.d(this.#ram[this.#regops.hl()]) }
    // ld d,a
    this.#opcodes[0x57] = () => { this.#regops.d(this.#regops.a()) }
    // ld e,b
    this.#opcodes[0x58] = () => { this.#regops.e(this.#regops.b()) }
    // ld e,c
    this.#opcodes[0x59] = () => { this.#regops.e(this.#regops.c()) }
    // ld e,d
    this.#opcodes[0x5a] = () => { this.#regops.e(this.#regops.d()) }
    // ld e,e
    this.#opcodes[0x5b] = () => { this.#regops.e(this.#regops.e()) }
    // ld e,h
    this.#opcodes[0x5c] = () => { this.#regops.e(this.#regops.h()) }
    // ld e,l
    this.#opcodes[0x5d] = () => { this.#regops.e(this.#regops.l()) }
    // ld e,(hl)
    this.#opcodes[0x5e] = () => { this.#regops.e(this.#ram[this.#regops.hl()]) }
    // ld e,a
    this.#opcodes[0x5f] = () => { this.#regops.e(this.#regops.a()) }
    // ld h,b
    this.#opcodes[0x60] = () => { this.#regops.h(this.#regops.b()) }
    // ld h,c
    this.#opcodes[0x61] = () => { this.#regops.h(this.#regops.c()) }
    // ld h,d
    this.#opcodes[0x62] = () => { this.#regops.h(this.#regops.d()) }
    // ld h,e
    this.#opcodes[0x63] = () => { this.#regops.h(this.#regops.e()) }
    // ld h,h
    this.#opcodes[0x64] = () => { this.#regops.h(this.#regops.h()) }
    // ld h,l
    this.#opcodes[0x65] = () => { this.#regops.h(this.#regops.l()) }
    // ld h,(hl)
    this.#opcodes[0x66] = () => { this.#regops.h(this.#ram[this.#regops.hl()]) }
    // ld h,a
    this.#opcodes[0x67] = () => { this.#regops.h(this.#regops.a()) }
    // ld l,b
    this.#opcodes[0x68] = () => { this.#regops.l(this.#regops.b()) }
    // ld l,c
    this.#opcodes[0x69] = () => { this.#regops.l(this.#regops.c()) }
    // ld l,d
    this.#opcodes[0x6a] = () => { this.#regops.l(this.#regops.d()) }
    // ld l,e
    this.#opcodes[0x6b] = () => { this.#regops.l(this.#regops.e()) }
    // ld l,h
    this.#opcodes[0x6c] = () => { this.#regops.l(this.#regops.h()) }
    // ld l,l
    this.#opcodes[0x6d] = () => { this.#regops.l(this.#regops.l()) }
    // ld l,(hl)
    this.#opcodes[0x6e] = () => { this.#regops.l(this.#ram[this.#regops.hl()]) }
    // ld l,a
    this.#opcodes[0x6f] = () => { this.#regops.l(this.#regops.a()) }
    // ld (hl),b
    this.#opcodes[0x70] = () => { this.#ram[this.#regops.hl()] = this.#regops.b() }
    // ld (hl),c
    this.#opcodes[0x71] = () => { this.#ram[this.#regops.hl()] = this.#regops.c() }
    // ld (hl),d
    this.#opcodes[0x72] = () => { this.#ram[this.#regops.hl()] = this.#regops.d() }
    // ld (hl),e
    this.#opcodes[0x73] = () => { this.#ram[this.#regops.hl()] = this.#regops.e() }
    // ld (hl),h
    this.#opcodes[0x74] = () => { this.#ram[this.#regops.hl()] = this.#regops.h() }
    // ld (hl),l
    this.#opcodes[0x75] = () => { this.#ram[this.#regops.hl()] = this.#regops.l() }
    // halt
    this.#opcodes[0x76] = () => { throw 'cpu halted by opcode' }
    // ld (hl),a
    this.#opcodes[0x77] = () => { this.#ram[this.#regops.hl()] = this.#regops.a() }
    // ld a,b
    this.#opcodes[0x78] = () => { this.#regops.a(this.#regops.b()) }
    // ld a,c
    this.#opcodes[0x79] = () => { this.#regops.a(this.#regops.c()) }
    // ld a,d
    this.#opcodes[0x7a] = () => { this.#regops.a(this.#regops.d()) }
    // ld a,e
    this.#opcodes[0x7b] = () => { this.#regops.a(this.#regops.e()) }
    // ld a,h
    this.#opcodes[0x7c] = () => { this.#regops.a(this.#regops.h()) }
    // ld a,l
    this.#opcodes[0x7d] = () => { this.#regops.a(this.#regops.l()) }
    // ld a,(hl)
    this.#opcodes[0x7e] = () => { this.#regops.a(this.#ram[this.#regops.hl()]) }
    // ld a,a
    this.#opcodes[0x7f] = () => { this.#regops.a(this.#regops.a()) }
    // add a,b
    this.#opcodes[0x80] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.b()))
    }
    // add a,c
    this.#opcodes[0x81] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.c()))
    }
    // add a,d
    this.#opcodes[0x82] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.d()))
    }
    // add a,e
    this.#opcodes[0x83] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.e()))
    }
    // add a,h
    this.#opcodes[0x84] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.h()))
    }
    // add a,l
    this.#opcodes[0x85] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.l()))
    }
    // add a,(hl)
    this.#opcodes[0x86] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#ram[this.#regops.hl()]))
    }
    // add a,a
    this.#opcodes[0x87] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.a()))
    }
    // adc a,b
    this.#opcodes[0x88] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.b()))
    }
    // adc a,c
    this.#opcodes[0x89] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.c()))
    }
    // adc a,d
    this.#opcodes[0x8a] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.d()))
    }
    // adc a,e
    this.#opcodes[0x8b] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.e()))
    }
    // adc a,h
    this.#opcodes[0x8c] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.h()))
    }
    // adc a,l
    this.#opcodes[0x8d] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.l()))
    }
    // adc a,(hl)
    this.#opcodes[0x8e] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#ram[this.#regops.hl()]))
    }
    // adc a,a
    this.#opcodes[0x8f] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.a()))
    }
    // sub a,b
    this.#opcodes[0x90] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.b()))
    }
    // sub a,c
    this.#opcodes[0x91] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.c()))
    }
    // sub a,d
    this.#opcodes[0x92] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.d()))
    }
    // sub a,e
    this.#opcodes[0x93] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.e()))
    }
    // sub a,h
    this.#opcodes[0x94] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.h()))
    }
    // sub a,l
    this.#opcodes[0x95] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.l()))
    }
    // sub a,(hl)
    this.#opcodes[0x96] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#ram[this.#regops.hl()]))
    }
    // sub a,a
    this.#opcodes[0x97] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.a()))
    }
    // sbc a,b
    this.#opcodes[0x98] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.b()))
    }
    // sbc a,c
    this.#opcodes[0x99] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.c()))
    }
    // sbc a,d
    this.#opcodes[0x9a] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.d()))
    }
    // sbc a,e
    this.#opcodes[0x9b] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.e()))
    }
    // sbc a,h
    this.#opcodes[0x9c] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.h()))
    }
    // sbc a,l
    this.#opcodes[0x9d] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.l()))
    }
    // sbc a,(hl)
    this.#opcodes[0x9e] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#ram[this.#regops.hl()]))
    }
    // sbc a,a
    this.#opcodes[0x9f] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.a()))
    }
    // and a,b
    this.#opcodes[0xa0] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.b())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,c
    this.#opcodes[0xa1] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.c())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,d
    this.#opcodes[0xa2] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.d())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,e
    this.#opcodes[0xa3] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.e())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,h
    this.#opcodes[0xa4] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.h())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,l
    this.#opcodes[0xa5] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.l())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,(hl)
    this.#opcodes[0xa6] = () => {
      this.#regops.a(this.#regops.a() & this.#ram[this.#regops.hl()])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,a
    this.#opcodes[0xa7] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.a())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // xor a,b
    this.#opcodes[0xa8] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.b())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,c
    this.#opcodes[0xa9] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.c())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,d
    this.#opcodes[0xaa] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.d())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,e
    this.#opcodes[0xab] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.e())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,h
    this.#opcodes[0xac] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.h())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,l
    this.#opcodes[0xad] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.l())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,(hl)
    this.#opcodes[0xae] = () => {
      this.#regops.a(this.#regops.a() ^ this.#ram[this.#regops.hl()])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,a
    this.#opcodes[0xaf] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.a())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,b
    this.#opcodes[0xb0] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.b())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,c
    this.#opcodes[0xb1] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.c())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,d
    this.#opcodes[0xb2] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.d())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,e
    this.#opcodes[0xb3] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.e())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,h
    this.#opcodes[0xb4] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.h())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,l
    this.#opcodes[0xb5] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.l())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,(hl)
    this.#opcodes[0xb6] = () => {
      this.#regops.a(this.#regops.a() | this.#ram[this.#regops.hl()])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,a
    this.#opcodes[0xb7] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.a())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // cp b
    this.#opcodes[0xb8] = () => this.#cp8(this.#regops.a(), this.#regops.b())
    // cp c
    this.#opcodes[0xb9] = () => this.#cp8(this.#regops.a(), this.#regops.c())
    // cp d
    this.#opcodes[0xba] = () => this.#cp8(this.#regops.a(), this.#regops.d())
    // cp e
    this.#opcodes[0xbb] = () => this.#cp8(this.#regops.a(), this.#regops.e())
    // cp h
    this.#opcodes[0xbc] = () => this.#cp8(this.#regops.a(), this.#regops.h())
    // cp l
    this.#opcodes[0xbd] = () => this.#cp8(this.#regops.a(), this.#regops.l())
    // cp (hl)
    this.#opcodes[0xbe] = () => this.#cp8(this.#regops.a(), this.#ram[this.#regops.hl()])
    // cp a
    this.#opcodes[0xbf] = () => this.#cp8(this.#regops.a(), this.#regops.a())
    // ret nz
    this.#opcodes[0xc0] = () => {
      if (!(this.#regops.f() & this.#FREG_Z))
        this.#regops.pc(this.#popWord())
    }
    // pop bc
    this.#opcodes[0xc1] = () => { this.#regops.bc(this.#popWord()) }
    // jp nz,nnnn
    this.#opcodes[0xc2] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (!(this.#regops.f() & this.#FREG_Z))
        this.#regops.pc(this.#word(hi, lo))
    }
    // jp nnnn
    this.#opcodes[0xc3] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#registers.pc = this.#word(hi, lo)
    }
    // call nz,nnnn
    this.#opcodes[0xc4] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (!(this.#regops.f() & this.#FREG_Z))
        this.#regops.pc(this.#word(hi, lo))
      this.#pushWord(this.#registers.pc)
    }
    // push bc
    this.#opcodes[0xc5] = () => { this.#pushWord(this.#registers.bc) }
    // add a,nn
    this.#opcodes[0xc6] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#getPC()))
    }
    // rst 00
    this.#opcodes[0xc7] = () => {
      this.#pushWord(this.#registers.pc)
      this.#registers.pc = 0x00
    }
    // ret z
    this.#opcodes[0xc8] = () => {
      if (this.#regops.f() & this.#FREG_Z)
        this.#regops.pc(this.#popWord())
    }
    // ret
    this.#opcodes[0xc9] = () => { this.#regops.pc(this.#popWord()) }
    // jp z,nnnn
    this.#opcodes[0xca] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (this.#regops.f() & this.#FREG_Z)
        this.#regops.pc(this.#word(hi, lo))
    }
    // shift cb (subtable of operations)
    this.#opcodes[0xcb] = []
    // call z,nnnn
    this.#opcodes[0xcc] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (this.#regops.f() & this.#FREG_Z)
        this.#regops.pc(this.#word(hi, lo))
      this.#pushWord(this.#registers.pc)
    }
    // call nnnn
    this.#opcodes[0xcd] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#registers.pc = this.#word(hi, lo)
      this.#pushWord(this.#registers.pc)
    }
    // adc a,nn
    this.#opcodes[0xce] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#getPC()))
    }
    // rst 8
    this.#opcodes[0xcf] = () => {
      this.#pushWord(this.#registers.pc)
      this.#registers.pc = 0x8
    }
    // ret nc
    this.#opcodes[0xd0] = () => {
      if (!(this.#regops.f() & this.#FREG_C))
        this.#regops.pc(this.#popWord())
    }
    // pop de
    this.#opcodes[0xd1] = () => { this.#regops.de(this.#popWord()) }
    // jp nc,nnnn
    this.#opcodes[0xd2] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (!(this.#regops.f() & this.#FREG_C))
        this.#regops.pc(this.#word(hi, lo))
    }
    // out (nn),a
    this.#opcodes[0xd3] = () => {
      this.#callIoHandler(this.#getPC(), 'w', this.#regops.a())
    }
    // call nc,nnnn
    this.#opcodes[0xd4] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (!(this.#regops.f() & this.#FREG_C))
        this.#regops.pc(this.#word(hi, lo))
      this.#pushWord(this.#registers.pc)
    }
    // push de
    this.#opcodes[0xd5] = () => { this.#pushWord(this.#registers.de) }
    // sub nn
    this.#opcodes[0xd6] = () => {
      this.#regops.nn(this.#sub8(this.#regops.nn(), this.#getPC()))
    }
    // rst 10
    this.#opcodes[0xd7] = () => {
      this.#pushWord(this.#registers.pc)
      this.#registers.pc = 0x10
    }
    // ret c
    this.#opcodes[0xd8] = () => {
      if (this.#regops.f() & this.#FREG_C)
        this.#regops.pc(this.#popWord())
    }
    // exx
    this.#opcodes[0xd9] = () => {
      const [bc, de, hl] = [this.#regops.bc(), this.#regops.de(), this.#regops.hl()]
      this.#regops.bc(this.#regops.bc2())
      this.#regops.de(this.#regops.de2())
      this.#regops.hl(this.#regops.hl2())
      this.#regops.bc2(bc)
      this.#regops.de2(de)
      this.#regops.hl2(hl)
    }
    // jp c,nnnn
    this.#opcodes[0xda] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (this.#regops.f() & this.#FREG_C)
        this.#regops.pc(this.#word(hi, lo))
    }
    // in a,(nn)
    this.#opcodes[0xdb] = () => {
      this.#regops.a(this.#callIoHandler(this.#getPC(), 'r'))
    }
    // call c,nnnn
    this.#opcodes[0xdc] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (this.#regops.f() & this.#FREG_C)
        this.#regops.pc(this.#word(hi, lo))
      this.#pushWord(this.#registers.pc)
    }
    // shift dd (subtable of operations)
    this.#opcodes[0xdd] = []
    // sbc a,nn
    this.#opcodes[0xde] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#getPC()))
    }
    // rst 18
    this.#opcodes[0xdf] = () => {
      this.#pushWord(this.#registers.pc)
      this.#registers.pc = 0x18
    }
    // ret po
    this.#opcodes[0xe0] = () => {
      if (!(this.#regops.f() & this.#FREG_P))
        this.#regops.pc(this.#popWord())
    }
    // pop hl
    this.#opcodes[0xe1] = () => { this.#regops.hl(this.#popWord()) }
    // jp po,nnnn
    this.#opcodes[0xe2] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (!(this.#regops.f() & this.#FREG_P))
        this.#regops.pc(this.#word(hi, lo))
    }
    // ex (sp),hl
    this.#opcodes[0xe3] = () => {
      const temp = this.#registers.hl
      const [lo, hi] = [this.#ram[this.#registers.sp], this.#ram[this.#addWord(this.#registers.sp, 1)]]
      this.#registers.hl = this.#word(hi, lo)
      this.#ram[this.#registers.sp] = this.#lo(temp)
      this.#ram[this.#addWord(this.#registers.sp, 1)] = this.#hi(temp)
    }
    // call po,nnnn
    this.#opcodes[0xe4] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (!(this.#regops.f() & this.#FREG_P))
        this.#regops.pc(this.#word(hi, lo))
      this.#pushWord(this.#registers.pc)
    }
    // push hl
    this.#opcodes[0xe5] = () => { this.#pushWord(this.#registers.hl) }
    // and nn
    this.#opcodes[0xe6] = () => {
      this.#regops.a(this.#regops.a() & this.#getPC())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // rst 20
    this.#opcodes[0xe7] = () => {
      this.#pushWord(this.#registers.pc)
      this.#registers.pc = 0x20
    }
    // ret pe
    this.#opcodes[0xe8] = () => {
      if (this.#regops.f() & this.#FREG_P)
        this.#regops.pc(this.#popWord())
    }
    // jp hl
    this.#opcodes[0xe9] = () => { this.#registers.pc = this.#registers.hl }
    // jp pe,nnnn
    this.#opcodes[0xea] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (this.#regops.f() & this.#FREG_P)
        this.#regops.pc(this.#word(hi, lo))
    }
    // ex de,hl
    this.#opcodes[0xeb] = () => {
      const temp = this.#regops.de()
      this.#regops.de(this.#regops.hl())
      this.#regops.hl(temp)
    }
    // call pe,nnnn
    this.#opcodes[0xec] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (this.#regops.f() & this.#FREG_P)
        this.#regops.pc(this.#word(hi, lo))
      this.#pushWord(this.#registers.pc)
    }
    // shift ed (subtable of operations)
    this.#opcodes[0xed] = []
    // xor a,nn
    this.#opcodes[0xee] = () => {
      this.#regops.a(this.#regops.a() ^ this.#getPC())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // rst 28
    this.#opcodes[0xef] = () => {
      this.#pushWord(this.#registers.pc)
      this.#registers.pc = 0x28
    }
    // ret p
    this.#opcodes[0xf0] = () => {
      if (!(this.#regops.f() & this.#FREG_S))
        this.#regops.pc(this.#popWord())
    }
    // pop af
    this.#opcodes[0xf1] = () => { this.#regops.af(this.#popWord()) }
    // jp p,nnnn
    this.#opcodes[0xf2] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (!(this.#regops.f() & this.#FREG_S))
        this.#regops.pc(this.#word(hi, lo))
    }
    // di
    this.#opcodes[0xf3] = () => { this.#interrupts = false }
    // call p,nnnn
    this.#opcodes[0xf4] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (!(this.#regops.f() & this.#FREG_S))
        this.#regops.pc(this.#word(hi, lo))
      this.#pushWord(this.#registers.pc)
    }
    // push af
    this.#opcodes[0xf5] = () => { this.#pushWord(this.#registers.af) }
    // or nn
    this.#opcodes[0xf6] = () => {
      this.#regops.a(this.#regops.a() | this.#getPC())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // rst 30
    this.#opcodes[0xf7] = () => {
      this.#pushWord(this.#registers.pc)
      this.#registers.pc = 0x30
    }
    // ret m
    this.#opcodes[0xf8] = () => {
      if (this.#regops.f() & this.#FREG_S)
        this.#regops.pc(this.#popWord())
    }
    // ld sp,hl
    this.#opcodes[0xf9] = () => { this.#regops.sp(this.#regops.hl()) }
    // jp m,nnnn
    this.#opcodes[0xfa] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (this.#regops.f() & this.#FREG_S)
        this.#regops.pc(this.#word(hi, lo))
    }
    // ei
    this.#opcodes[0xfb] = () => { this.#interrupts = true }
    // call m,nnnn
    this.#opcodes[0xfc] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      if (this.#regops.f() & this.#FREG_S)
        this.#regops.pc(this.#word(hi, lo))
      this.#pushWord(this.#registers.pc)
    }
    // shift fd (subtable of operations)
    this.#opcodes[0xfd] = []
    // cp nn
    this.#opcodes[0xfe] = () => this.#cp8(this.#regops.a(), this.#getPC())
    // rst 38
    this.#opcodes[0xff] = () => {
      this.#pushWord(this.#registers.pc)
      this.#registers.pc = 0x38
    }
    // rlc b
    this.#opcodes[0xcb][0x00] = () => {
      this.#regops.b(((this.#regops.b() << 1) | (this.#regops.b() >> 7)) & 0xff)
      this.#regops.f(
          ((this.#regops.b() & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.b()]
      )
    }
    // rlc c
    this.#opcodes[0xcb][0x01] = () => {
      this.#regops.c(((this.#regops.c() << 1) | (this.#regops.c() >> 7)) & 0xff)
      this.#regops.f(
          ((this.#regops.c() & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.c()]
      )
    }
    // rlc d
    this.#opcodes[0xcb][0x02] = () => {
      this.#regops.d(((this.#regops.d() << 1) | (this.#regops.d() >> 7)) & 0xff)
      this.#regops.f(
          ((this.#regops.d() & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.d()]
      )
    }
    // rlc e
    this.#opcodes[0xcb][0x03] = () => {
      this.#regops.e(((this.#regops.e() << 1) | (this.#regops.e() >> 7)) & 0xff)
      this.#regops.f(
          ((this.#regops.e() & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.e()]
      )
    }
    // rlc h
    this.#opcodes[0xcb][0x04] = () => {
      this.#regops.h(((this.#regops.h() << 1) | (this.#regops.h() >> 7)) & 0xff)
      this.#regops.f(
          ((this.#regops.h() & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.h()]
      )
    }
    // rlc l
    this.#opcodes[0xcb][0x05] = () => {
      this.#regops.l(((this.#regops.l() << 1) | (this.#regops.l() >> 7)) & 0xff)
      this.#regops.f(
          ((this.#regops.l() & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.l()]
      )
    }
    // rlc (hl)
    this.#opcodes[0xcb][0x06] = () => {
      this.#ram[this.#regops.hl()] = ((this.#ram[this.#regops.hl()] << 1) | (this.#ram[this.#regops.hl()] >> 7)) & 0xff
      this.#regops.f(
          ((this.#ram[this.#regops.hl()] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[this.#regops.hl()]]
      )
    }
    // rlc a
    this.#opcodes[0xcb][0x07] = () => {
      this.#regops.a(((this.#regops.a() << 1) | (this.#regops.a() >> 7)) & 0xff)
      this.#regops.f(
          ((this.#regops.a() & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.a()]
      )
    }
    // rrc b
    this.#opcodes[0xcb][0x08] = () => {
      this.#regops.b(((this.#regops.b() << 7) | (this.#regops.b() >> 1)) & 0xff)
      this.#regops.f(
          ((this.#regops.b() & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.b()]
      )
    }
    // rrc c
    this.#opcodes[0xcb][0x09] = () => {
      this.#regops.c(((this.#regops.c() << 7) | (this.#regops.c() >> 1)) & 0xff)
      this.#regops.f(
          ((this.#regops.c() & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.c()]
      )
    }
    // rrc d
    this.#opcodes[0xcb][0x0a] = () => {
      this.#regops.d(((this.#regops.d() << 7) | (this.#regops.d() >> 1)) & 0xff)
      this.#regops.f(
          ((this.#regops.d() & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.d()]
      )
    }
    // rrc e
    this.#opcodes[0xcb][0x0b] = () => {
      this.#regops.e(((this.#regops.e() << 7) | (this.#regops.e() >> 1)) & 0xff)
      this.#regops.f(
          ((this.#regops.e() & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.e()]
      )
    }
    // rrc h
    this.#opcodes[0xcb][0x0c] = () => {
      this.#regops.h(((this.#regops.h() << 7) | (this.#regops.h() >> 1)) & 0xff)
      this.#regops.f(
          ((this.#regops.h() & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.h()]
      )
    }
    // rrc l
    this.#opcodes[0xcb][0x0d] = () => {
      this.#regops.l(((this.#regops.l() << 7) | (this.#regops.l() >> 1)) & 0xff)
      this.#regops.f(
          ((this.#regops.l() & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.l()]
      )
    }
    // rrc (hl)
    this.#opcodes[0xcb][0x0e] = () => {
      this.#ram[this.#regops.hl()] = ((this.#ram[this.#regops.hl()] << 7) | (this.#ram[this.#regops.hl()] >> 1)) & 0xff
      this.#regops.f(
          ((this.#ram[this.#regops.hl()] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[this.#regops.hl()]]
      )
    }
    // rrc a
    this.#opcodes[0xcb][0x0f] = () => {
      this.#regops.a(((this.#regops.a() << 7) | (this.#regops.a() >> 1)) & 0xff)
      this.#regops.f(
          ((this.#regops.a() & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#regops.a()]
      )
    }
    // rl b
    this.#opcodes[0xcb][0x10] = () => {
      const carry = (this.#regops.b() & 0x80) ? this.#FREG_C : 0
      this.#regops.b(((this.#regops.b() << 1) | (carry ? 0x01 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.b()])
    }
    // rl c
    this.#opcodes[0xcb][0x11] = () => {
      const carry = (this.#regops.c() & 0x80) ? this.#FREG_C : 0
      this.#regops.c(((this.#regops.c() << 1) | (carry ? 0x01 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.c()])
    }
    // rl d
    this.#opcodes[0xcb][0x12] = () => {
      const carry = (this.#regops.d() & 0x80) ? this.#FREG_C : 0
      this.#regops.d(((this.#regops.d() << 1) | (carry ? 0x01 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.d()])
    }
    // rl e
    this.#opcodes[0xcb][0x13] = () => {
      const carry = (this.#regops.e() & 0x80) ? this.#FREG_C : 0
      this.#regops.e(((this.#regops.e() << 1) | (carry ? 0x01 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.e()])
    }
    // rl h
    this.#opcodes[0xcb][0x14] = () => {
      const carry = (this.#regops.h() & 0x80) ? this.#FREG_C : 0
      this.#regops.h(((this.#regops.h() << 1) | (carry ? 0x01 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.h()])
    }
    // rl l
    this.#opcodes[0xcb][0x15] = () => {
      const carry = (this.#regops.l() & 0x80) ? this.#FREG_C : 0
      this.#regops.l(((this.#regops.l() << 1) | (carry ? 0x01 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.l()])
    }
    // rl (hl)
    this.#opcodes[0xcb][0x16] = () => {
      const carry = (this.#ram[this.#regops.hl()] & 0x80) ? this.#FREG_C : 0
      this.#ram[this.#regops.hl()] = ((this.#ram[this.#regops.hl()] << 1) | (carry ? 0x01: 0x00)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.hl()]])
    }
    // rl a
    this.#opcodes[0xcb][0x17] = () => {
      const carry = (this.#regops.a() & 0x80) ? this.#FREG_C : 0
      this.#regops.a(((this.#regops.a() << 1) | (carry ? 0x01 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.a()])
    }
    // rr b
    this.#opcodes[0xcb][0x18] = () => {
      const carry = (this.#regops.b() & 0x01) ? this.#FREG_C : 0
      this.#regops.b(((this.#regops.b() >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.b()])
    }
    // rr c
    this.#opcodes[0xcb][0x19] = () => {
      const carry = (this.#regops.c() & 0x01) ? this.#FREG_C : 0
      this.#regops.c(((this.#regops.c() >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.c()])
    }
    // rr d
    this.#opcodes[0xcb][0x1a] = () => {
      const carry = (this.#regops.d() & 0x01) ? this.#FREG_C : 0
      this.#regops.d(((this.#regops.d() >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.d()])
    }
    // rr e
    this.#opcodes[0xcb][0x1b] = () => {
      const carry = (this.#regops.e() & 0x01) ? this.#FREG_C : 0
      this.#regops.e(((this.#regops.e() >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.e()])
    }
    // rr h
    this.#opcodes[0xcb][0x1c] = () => {
      const carry = (this.#regops.h() & 0x01) ? this.#FREG_C : 0
      this.#regops.h(((this.#regops.h() >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.h()])
    }
    // rr l
    this.#opcodes[0xcb][0x1d] = () => {
      const carry = (this.#regops.l() & 0x01) ? this.#FREG_C : 0
      this.#regops.l(((this.#regops.l() >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.l()])
    }
    // rr (hl)
    this.#opcodes[0xcb][0x1e] = () => {
      const carry = (this.#ram[this.#regops.hl()] & 0x01) ? this.#FREG_C : 0
      this.#ram[this.#regops.hl()] = ((this.#ram[this.#regops.hl()] >> 1) | (carry ? 0x80 : 0x00)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.hl()]])
    }
    // rr a
    this.#opcodes[0xcb][0x1f] = () => {
      const carry = (this.#regops.a() & 0x01) ? this.#FREG_C : 0
      this.#regops.a(((this.#regops.a() >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.a()])
    }
    // sla b
    this.#opcodes[0xcb][0x20] = () => {
      const carry = (this.#regops.b() & 0x80) ? this.#FREG_C : 0
      this.#regops.b(((this.#regops.b() << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.b()])
    }
    // sla c
    this.#opcodes[0xcb][0x21] = () => {
      const carry = (this.#regops.c() & 0x80) ? this.#FREG_C : 0
      this.#regops.c(((this.#regops.c() << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.c()])
    }
    // sla d
    this.#opcodes[0xcb][0x22] = () => {
      const carry = (this.#regops.d() & 0x80) ? this.#FREG_C : 0
      this.#regops.d(((this.#regops.d() << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.d()])
    }
    // sla e
    this.#opcodes[0xcb][0x23] = () => {
      const carry = (this.#regops.e() & 0x80) ? this.#FREG_C : 0
      this.#regops.e(((this.#regops.e() << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.e()])
    }
    // sla h
    this.#opcodes[0xcb][0x24] = () => {
      const carry = (this.#regops.h() & 0x80) ? this.#FREG_C : 0
      this.#regops.h(((this.#regops.h() << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.h()])
    }
    // sla l
    this.#opcodes[0xcb][0x25] = () => {
      const carry = (this.#regops.l() & 0x80) ? this.#FREG_C : 0
      this.#regops.l(((this.#regops.l() << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.l()])
    }
    // sla (hl)
    this.#opcodes[0xcb][0x26] = () => {
      const carry = (this.#ram[this.#regops.hl()] & 0x80) ? this.#FREG_C : 0
      this.#ram[this.#regops.hl()] = ((this.#ram[this.#regops.hl()] << 1)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.hl()]])
    }
    // sla a
    this.#opcodes[0xcb][0x27] = () => {
      const carry = (this.#regops.a() & 0x80) ? this.#FREG_C : 0
      this.#regops.a(((this.#regops.a() << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.a()])
    }
    // sra b
    this.#opcodes[0xcb][0x28] = () => {
      const carry = (this.#regops.b() & 0x01) ? this.#FREG_C : 0
      this.#regops.b(((this.#regops.b() >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.b()])
    }
    // sra c
    this.#opcodes[0xcb][0x29] = () => {
      const carry = (this.#regops.c() & 0x01) ? this.#FREG_C : 0
      this.#regops.c(((this.#regops.c() >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.c()])
    }
    // sra d
    this.#opcodes[0xcb][0x2a] = () => {
      const carry = (this.#regops.d() & 0x01) ? this.#FREG_C : 0
      this.#regops.d(((this.#regops.d() >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.d()])
    }
    // sra e
    this.#opcodes[0xcb][0x2b] = () => {
      const carry = (this.#regops.e() & 0x01) ? this.#FREG_C : 0
      this.#regops.e(((this.#regops.e() >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.e()])
    }
    // sra h
    this.#opcodes[0xcb][0x2c] = () => {
      const carry = (this.#regops.h() & 0x01) ? this.#FREG_C : 0
      this.#regops.h(((this.#regops.h() >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.h()])
    }
    // sra l
    this.#opcodes[0xcb][0x2d] = () => {
      const carry = (this.#regops.l() & 0x01) ? this.#FREG_C : 0
      this.#regops.l(((this.#regops.l() >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.l()])
    }
    // sra (hl)
    this.#opcodes[0xcb][0x2e] = () => {
      const carry = (this.#ram[this.#regops.hl()] & 0x01) ? this.#FREG_C : 0
      this.#ram[this.#regops.hl()] = ((this.#ram[this.#regops.hl()] >> 1)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.hl()]])
    }
    // sra a
    this.#opcodes[0xcb][0x2f] = () => {
      const carry = (this.#regops.a() & 0x01) ? this.#FREG_C : 0
      this.#regops.a(((this.#regops.a() >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.a()])
    }
    // sll b
    this.#opcodes[0xcb][0x30] = () => {
      const carry = (this.#regops.b() & 0x80) ? this.#FREG_C : 0
      this.#regops.b(((this.#regops.b() << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.b()])
    }
    // sll c
    this.#opcodes[0xcb][0x31] = () => {
      const carry = (this.#regops.c() & 0x80) ? this.#FREG_C : 0
      this.#regops.c(((this.#regops.c() << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.c()])
    }
    // sll d
    this.#opcodes[0xcb][0x32] = () => {
      const carry = (this.#regops.d() & 0x80) ? this.#FREG_C : 0
      this.#regops.d(((this.#regops.d() << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.d()])
    }
    // sll e
    this.#opcodes[0xcb][0x33] = () => {
      const carry = (this.#regops.e() & 0x80) ? this.#FREG_C : 0
      this.#regops.e(((this.#regops.e() << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.e()])
    }
    // sll h
    this.#opcodes[0xcb][0x34] = () => {
      const carry = (this.#regops.h() & 0x80) ? this.#FREG_C : 0
      this.#regops.h(((this.#regops.h() << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.h()])
    }
    // sll l
    this.#opcodes[0xcb][0x35] = () => {
      const carry = (this.#regops.l() & 0x80) ? this.#FREG_C : 0
      this.#regops.l(((this.#regops.l() << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.l()])
    }
    // sll (hl)
    this.#opcodes[0xcb][0x36] = () => {
      const carry = (this.#ram[this.#regops.hl()] & 0x80) ? this.#FREG_C : 0
      this.#ram[this.#regops.hl()] = ((this.#ram[this.#regops.hl()] << 1) | 0x01) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.hl()]])
    }
    // sll a
    this.#opcodes[0xcb][0x37] = () => {
      const carry = (this.#regops.a() & 0x80) ? this.#FREG_C : 0
      this.#regops.a(((this.#regops.a() << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.a()])
    }
    // srl b
    this.#opcodes[0xcb][0x38] = () => {
      const carry = (this.#regops.b() & 0x01) ? this.#FREG_C : 0
      this.#regops.b(((this.#regops.b() >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.b()])
    }
    // srl c
    this.#opcodes[0xcb][0x39] = () => {
      const carry = (this.#regops.c() & 0x01) ? this.#FREG_C : 0
      this.#regops.c(((this.#regops.c() >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.c()])
    }
    // srl d
    this.#opcodes[0xcb][0x3a] = () => {
      const carry = (this.#regops.d() & 0x01) ? this.#FREG_C : 0
      this.#regops.d(((this.#regops.d() >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.d()])
    }
    // srl e
    this.#opcodes[0xcb][0x3b] = () => {
      const carry = (this.#regops.e() & 0x01) ? this.#FREG_C : 0
      this.#regops.e(((this.#regops.e() >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.e()])
    }
    // srl h
    this.#opcodes[0xcb][0x3c] = () => {
      const carry = (this.#regops.h() & 0x01) ? this.#FREG_C : 0
      this.#regops.h(((this.#regops.h() >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.h()])
    }
    // srl l
    this.#opcodes[0xcb][0x3d] = () => {
      const carry = (this.#regops.l() & 0x01) ? this.#FREG_C : 0
      this.#regops.l(((this.#regops.l() >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.l()])
    }
    // srl (hl)
    this.#opcodes[0xcb][0x3e] = () => {
      const carry = (this.#ram[this.#regops.hl()] & 0x01) ? this.#FREG_C : 0
      this.#ram[this.#regops.hl()] = ((this.#ram[this.#regops.hl()] >> 1) | 0x80) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[this.#regops.hl()]])
    }
    // srl a
    this.#opcodes[0xcb][0x3f] = () => {
      const carry = (this.#regops.a() & 0x01) ? this.#FREG_C : 0
      this.#regops.a(((this.#regops.a() >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#regops.a()])
    }
    // bit 0,b
    this.#opcodes[0xcb][0x40] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.b() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.b() & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 0,c
    this.#opcodes[0xcb][0x41] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.c() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.c() & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 0,d
    this.#opcodes[0xcb][0x42] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.d() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.d() & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 0,e
    this.#opcodes[0xcb][0x43] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.e() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.e() & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 0,h
    this.#opcodes[0xcb][0x44] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.h() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.h() & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 0,l
    this.#opcodes[0xcb][0x45] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.l() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.l() & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 0,(hl)
    this.#opcodes[0xcb][0x46] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[this.#regops.hl()] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[this.#regops.hl()] & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 0,a
    this.#opcodes[0xcb][0x47] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.a() & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,b
    this.#opcodes[0xcb][0x48] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.b() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.b() & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,c
    this.#opcodes[0xcb][0x49] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.c() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.c() & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,d
    this.#opcodes[0xcb][0x4a] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.d() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.d() & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,e
    this.#opcodes[0xcb][0x4b] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.e() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.e() & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,h
    this.#opcodes[0xcb][0x4c] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.h() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.h() & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,l
    this.#opcodes[0xcb][0x4d] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.l() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.l() & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,(hl)
    this.#opcodes[0xcb][0x4e] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[this.#regops.hl()] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[this.#regops.hl()] & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,a
    this.#opcodes[0xcb][0x4f] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.a() & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,b
    this.#opcodes[0xcb][0x50] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.b() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.b() & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,c
    this.#opcodes[0xcb][0x51] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.c() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.c() & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,d
    this.#opcodes[0xcb][0x52] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.d() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.d() & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,e
    this.#opcodes[0xcb][0x53] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.e() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.e() & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,h
    this.#opcodes[0xcb][0x54] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.h() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.h() & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,l
    this.#opcodes[0xcb][0x55] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.l() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.l() & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,(hl)
    this.#opcodes[0xcb][0x56] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[this.#regops.hl()] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[this.#regops.hl()] & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,a
    this.#opcodes[0xcb][0x57] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.a() & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,b
    this.#opcodes[0xcb][0x58] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.b() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.b() & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,c
    this.#opcodes[0xcb][0x59] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.c() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.c() & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,d
    this.#opcodes[0xcb][0x5a] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.d() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.d() & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,e
    this.#opcodes[0xcb][0x5b] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.e() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.e() & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,h
    this.#opcodes[0xcb][0x5c] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.h() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.h() & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,l
    this.#opcodes[0xcb][0x5d] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.l() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.l() & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,(hl)
    this.#opcodes[0xcb][0x5e] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[this.#regops.hl()] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[this.#regops.hl()] & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,a
    this.#opcodes[0xcb][0x5f] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.a() & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,b
    this.#opcodes[0xcb][0x60] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.b() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.b() & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,c
    this.#opcodes[0xcb][0x61] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.c() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.c() & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,d
    this.#opcodes[0xcb][0x62] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.d() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.d() & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,e
    this.#opcodes[0xcb][0x63] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.e() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.e() & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,h
    this.#opcodes[0xcb][0x64] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.h() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.h() & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,l
    this.#opcodes[0xcb][0x65] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.l() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.l() & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,(hl)
    this.#opcodes[0xcb][0x66] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[this.#regops.hl()] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[this.#regops.hl()] & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,a
    this.#opcodes[0xcb][0x67] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.a() & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,b
    this.#opcodes[0xcb][0x68] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.b() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.b() & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,c
    this.#opcodes[0xcb][0x69] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.c() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.c() & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,d
    this.#opcodes[0xcb][0x6a] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.d() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.d() & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,e
    this.#opcodes[0xcb][0x6b] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.e() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.e() & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,h
    this.#opcodes[0xcb][0x6c] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.h() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.h() & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,l
    this.#opcodes[0xcb][0x6d] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.l() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.l() & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,(hl)
    this.#opcodes[0xcb][0x6e] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[this.#regops.hl()] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[this.#regops.hl()] & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,a
    this.#opcodes[0xcb][0x6f] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.a() & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,b
    this.#opcodes[0xcb][0x70] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.b() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.b() & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,c
    this.#opcodes[0xcb][0x71] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.c() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.c() & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,d
    this.#opcodes[0xcb][0x72] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.d() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.d() & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,e
    this.#opcodes[0xcb][0x73] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.e() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.e() & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,h
    this.#opcodes[0xcb][0x74] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.h() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.h() & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,l
    this.#opcodes[0xcb][0x75] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.l() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.l() & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,(hl)
    this.#opcodes[0xcb][0x76] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[this.#regops.hl()] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[this.#regops.hl()] & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,a
    this.#opcodes[0xcb][0x77] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.a() & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,b
    this.#opcodes[0xcb][0x78] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.b() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.b() & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,c
    this.#opcodes[0xcb][0x79] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.c() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.c() & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,d
    this.#opcodes[0xcb][0x7a] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.d() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.d() & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,e
    this.#opcodes[0xcb][0x7b] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.e() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.e() & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,h
    this.#opcodes[0xcb][0x7c] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.h() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.h() & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,l
    this.#opcodes[0xcb][0x7d] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.l() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.l() & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,(hl)
    this.#opcodes[0xcb][0x7e] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[this.#regops.hl()] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[this.#regops.hl()] & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,a
    this.#opcodes[0xcb][0x7f] = () => {
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#regops.a() & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#regops.a() & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // res 0,b
    this.#opcodes[0xcb][0x80] = () => this.#regops.b(this.#regops.b() & ~(1 << 0))
    // res 0,c
    this.#opcodes[0xcb][0x81] = () => this.#regops.c(this.#regops.c() & ~(1 << 0))
    // res 0,d
    this.#opcodes[0xcb][0x82] = () => this.#regops.d(this.#regops.d() & ~(1 << 0))
    // res 0,e
    this.#opcodes[0xcb][0x83] = () => this.#regops.e(this.#regops.e() & ~(1 << 0))
    // res 0,h
    this.#opcodes[0xcb][0x84] = () => this.#regops.h(this.#regops.h() & ~(1 << 0))
    // res 0,l
    this.#opcodes[0xcb][0x85] = () => this.#regops.l(this.#regops.l() & ~(1 << 0))
    // res 0,(hl)
    this.#opcodes[0xcb][0x86] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & ~(1 << 0)
    }
    // res 0,a
    this.#opcodes[0xcb][0x87] = () => this.#regops.a(this.#regops.a() & ~(1 << 0))
    // res 1,b
    this.#opcodes[0xcb][0x88] = () => this.#regops.b(this.#regops.b() & ~(1 << 1))
    // res 1,c
    this.#opcodes[0xcb][0x89] = () => this.#regops.c(this.#regops.c() & ~(1 << 1))
    // res 1,d
    this.#opcodes[0xcb][0x8a] = () => this.#regops.d(this.#regops.d() & ~(1 << 1))
    // res 1,e
    this.#opcodes[0xcb][0x8b] = () => this.#regops.e(this.#regops.e() & ~(1 << 1))
    // res 1,h
    this.#opcodes[0xcb][0x8c] = () => this.#regops.h(this.#regops.h() & ~(1 << 1))
    // res 1,l
    this.#opcodes[0xcb][0x8d] = () => this.#regops.l(this.#regops.l() & ~(1 << 1))
    // res 1,(hl)
    this.#opcodes[0xcb][0x8e] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & ~(1 << 1)
    }
    // res 1,a
    this.#opcodes[0xcb][0x8f] = () => this.#regops.a(this.#regops.a() & ~(1 << 1))
    // res 2,b
    this.#opcodes[0xcb][0x90] = () => this.#regops.b(this.#regops.b() & ~(1 << 2))
    // res 2,c
    this.#opcodes[0xcb][0x91] = () => this.#regops.c(this.#regops.c() & ~(1 << 2))
    // res 2,d
    this.#opcodes[0xcb][0x92] = () => this.#regops.d(this.#regops.d() & ~(1 << 2))
    // res 2,e
    this.#opcodes[0xcb][0x93] = () => this.#regops.e(this.#regops.e() & ~(1 << 2))
    // res 2,h
    this.#opcodes[0xcb][0x94] = () => this.#regops.h(this.#regops.h() & ~(1 << 2))
    // res 2,l
    this.#opcodes[0xcb][0x95] = () => this.#regops.l(this.#regops.l() & ~(1 << 2))
    // res 2,(hl)
    this.#opcodes[0xcb][0x96] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & ~(1 << 2)
    }
    // res 2,a
    this.#opcodes[0xcb][0x97] = () => this.#regops.a(this.#regops.a() & ~(1 << 2))
    // res 3,b
    this.#opcodes[0xcb][0x98] = () => this.#regops.b(this.#regops.b() & ~(1 << 3))
    // res 3,c
    this.#opcodes[0xcb][0x99] = () => this.#regops.c(this.#regops.c() & ~(1 << 3))
    // res 3,d
    this.#opcodes[0xcb][0x9a] = () => this.#regops.d(this.#regops.d() & ~(1 << 3))
    // res 3,e
    this.#opcodes[0xcb][0x9b] = () => this.#regops.e(this.#regops.e() & ~(1 << 3))
    // res 3,h
    this.#opcodes[0xcb][0x9c] = () => this.#regops.h(this.#regops.h() & ~(1 << 3))
    // res 3,l
    this.#opcodes[0xcb][0x9d] = () => this.#regops.l(this.#regops.l() & ~(1 << 3))
    // res 3,(hl)
    this.#opcodes[0xcb][0x9e] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & ~(1 << 3)
    }
    // res 3,a
    this.#opcodes[0xcb][0x9f] = () => this.#regops.a(this.#regops.a() & ~(1 << 3))
    // res 4,b
    this.#opcodes[0xcb][0xa0] = () => this.#regops.b(this.#regops.b() & ~(1 << 4))
    // res 4,c
    this.#opcodes[0xcb][0xa1] = () => this.#regops.c(this.#regops.c() & ~(1 << 4))
    // res 4,d
    this.#opcodes[0xcb][0xa2] = () => this.#regops.d(this.#regops.d() & ~(1 << 4))
    // res 4,e
    this.#opcodes[0xcb][0xa3] = () => this.#regops.e(this.#regops.e() & ~(1 << 4))
    // res 4,h
    this.#opcodes[0xcb][0xa4] = () => this.#regops.h(this.#regops.h() & ~(1 << 4))
    // res 4,l
    this.#opcodes[0xcb][0xa5] = () => this.#regops.l(this.#regops.l() & ~(1 << 4))
    // res 4,(hl)
    this.#opcodes[0xcb][0xa6] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & ~(1 << 4)
    }
    // res 4,a
    this.#opcodes[0xcb][0xa7] = () => this.#regops.a(this.#regops.a() & ~(1 << 4))
    // res 5,b
    this.#opcodes[0xcb][0xa8] = () => this.#regops.b(this.#regops.b() & ~(1 << 5))
    // res 5,c
    this.#opcodes[0xcb][0xa9] = () => this.#regops.c(this.#regops.c() & ~(1 << 5))
    // res 5,d
    this.#opcodes[0xcb][0xaa] = () => this.#regops.d(this.#regops.d() & ~(1 << 5))
    // res 5,e
    this.#opcodes[0xcb][0xab] = () => this.#regops.e(this.#regops.e() & ~(1 << 5))
    // res 5,h
    this.#opcodes[0xcb][0xac] = () => this.#regops.h(this.#regops.h() & ~(1 << 5))
    // res 5,l
    this.#opcodes[0xcb][0xad] = () => this.#regops.l(this.#regops.l() & ~(1 << 5))
    // res 5,(hl)
    this.#opcodes[0xcb][0xae] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & ~(1 << 5)
    }
    // res 5,a
    this.#opcodes[0xcb][0xaf] = () => this.#regops.a(this.#regops.a() & ~(1 << 5))
    // res 6,b
    this.#opcodes[0xcb][0xb0] = () => this.#regops.b(this.#regops.b() & ~(1 << 6))
    // res 6,c
    this.#opcodes[0xcb][0xb1] = () => this.#regops.c(this.#regops.c() & ~(1 << 6))
    // res 6,d
    this.#opcodes[0xcb][0xb2] = () => this.#regops.d(this.#regops.d() & ~(1 << 6))
    // res 6,e
    this.#opcodes[0xcb][0xb3] = () => this.#regops.e(this.#regops.e() & ~(1 << 6))
    // res 6,h
    this.#opcodes[0xcb][0xb4] = () => this.#regops.h(this.#regops.h() & ~(1 << 6))
    // res 6,l
    this.#opcodes[0xcb][0xb5] = () => this.#regops.l(this.#regops.l() & ~(1 << 6))
    // res 6,(hl)
    this.#opcodes[0xcb][0xb6] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & ~(1 << 6)
    }
    // res 6,a
    this.#opcodes[0xcb][0xb7] = () => this.#regops.a(this.#regops.a() & ~(1 << 6))
    // res 7,b
    this.#opcodes[0xcb][0xb8] = () => this.#regops.b(this.#regops.b() & ~(1 << 7))
    // res 7,c
    this.#opcodes[0xcb][0xb9] = () => this.#regops.c(this.#regops.c() & ~(1 << 7))
    // res 7,d
    this.#opcodes[0xcb][0xba] = () => this.#regops.d(this.#regops.d() & ~(1 << 7))
    // res 7,e
    this.#opcodes[0xcb][0xbb] = () => this.#regops.e(this.#regops.e() & ~(1 << 7))
    // res 7,h
    this.#opcodes[0xcb][0xbc] = () => this.#regops.h(this.#regops.h() & ~(1 << 7))
    // res 7,l
    this.#opcodes[0xcb][0xbd] = () => this.#regops.l(this.#regops.l() & ~(1 << 7))
    // res 7,(hl)
    this.#opcodes[0xcb][0xbe] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & ~(1 << 7)
    }
    // res 7,a
    this.#opcodes[0xcb][0xbf] = () => this.#regops.a(this.#regops.a() & ~(1 << 7))
    // set 0,b
    this.#opcodes[0xcb][0xc0] = () => this.#regops.b(this.#regops.b() & (1 << 0))
    // set 0,c
    this.#opcodes[0xcb][0xc1] = () => this.#regops.c(this.#regops.c() & (1 << 0))
    // set 0,d
    this.#opcodes[0xcb][0xc2] = () => this.#regops.d(this.#regops.d() & (1 << 0))
    // set 0,e
    this.#opcodes[0xcb][0xc3] = () => this.#regops.e(this.#regops.e() & (1 << 0))
    // set 0,h
    this.#opcodes[0xcb][0xc4] = () => this.#regops.h(this.#regops.h() & (1 << 0))
    // set 0,l
    this.#opcodes[0xcb][0xc5] = () => this.#regops.l(this.#regops.l() & (1 << 0))
    // set 0,(hl)
    this.#opcodes[0xcb][0xc6] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & (1 << 0)
    }
    // set 0,a
    this.#opcodes[0xcb][0xc7] = () => this.#regops.a(this.#regops.a() & (1 << 0))
    // set 1,b
    this.#opcodes[0xcb][0xc8] = () => this.#regops.b(this.#regops.b() & (1 << 1))
    // set 1,c
    this.#opcodes[0xcb][0xc9] = () => this.#regops.c(this.#regops.c() & (1 << 1))
    // set 1,d
    this.#opcodes[0xcb][0xca] = () => this.#regops.d(this.#regops.d() & (1 << 1))
    // set 1,e
    this.#opcodes[0xcb][0xcb] = () => this.#regops.e(this.#regops.e() & (1 << 1))
    // set 1,h
    this.#opcodes[0xcb][0xcc] = () => this.#regops.h(this.#regops.h() & (1 << 1))
    // set 1,l
    this.#opcodes[0xcb][0xcd] = () => this.#regops.l(this.#regops.l() & (1 << 1))
    // set 1,(hl)
    this.#opcodes[0xcb][0xce] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & (1 << 1)
    }
    // set 1,a
    this.#opcodes[0xcb][0xcf] = () => this.#regops.a(this.#regops.a() & (1 << 1))
    // set 2,b
    this.#opcodes[0xcb][0xd0] = () => this.#regops.b(this.#regops.b() & (1 << 2))
    // set 2,c
    this.#opcodes[0xcb][0xd1] = () => this.#regops.c(this.#regops.c() & (1 << 2))
    // set 2,d
    this.#opcodes[0xcb][0xd2] = () => this.#regops.d(this.#regops.d() & (1 << 2))
    // set 2,e
    this.#opcodes[0xcb][0xd3] = () => this.#regops.e(this.#regops.e() & (1 << 2))
    // set 2,h
    this.#opcodes[0xcb][0xd4] = () => this.#regops.h(this.#regops.h() & (1 << 2))
    // set 2,l
    this.#opcodes[0xcb][0xd5] = () => this.#regops.l(this.#regops.l() & (1 << 2))
    // set 2,(hl)
    this.#opcodes[0xcb][0xd6] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & (1 << 2)
    }
    // set 2,a
    this.#opcodes[0xcb][0xd7] = () => this.#regops.a(this.#regops.a() & (1 << 2))
    // set 3,b
    this.#opcodes[0xcb][0xd8] = () => this.#regops.b(this.#regops.b() & (1 << 3))
    // set 3,c
    this.#opcodes[0xcb][0xd9] = () => this.#regops.c(this.#regops.c() & (1 << 3))
    // set 3,d
    this.#opcodes[0xcb][0xda] = () => this.#regops.d(this.#regops.d() & (1 << 3))
    // set 3,e
    this.#opcodes[0xcb][0xdb] = () => this.#regops.e(this.#regops.e() & (1 << 3))
    // set 3,h
    this.#opcodes[0xcb][0xdc] = () => this.#regops.h(this.#regops.h() & (1 << 3))
    // set 3,l
    this.#opcodes[0xcb][0xdd] = () => this.#regops.l(this.#regops.l() & (1 << 3))
    // set 3,(hl)
    this.#opcodes[0xcb][0xde] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & (1 << 3)
    }
    // set 3,a
    this.#opcodes[0xcb][0xdf] = () => this.#regops.a(this.#regops.a() & (1 << 3))
    // set 4,b
    this.#opcodes[0xcb][0xe0] = () => this.#regops.b(this.#regops.b() & (1 << 4))
    // set 4,c
    this.#opcodes[0xcb][0xe1] = () => this.#regops.c(this.#regops.c() & (1 << 4))
    // set 4,d
    this.#opcodes[0xcb][0xe2] = () => this.#regops.d(this.#regops.d() & (1 << 4))
    // set 4,e
    this.#opcodes[0xcb][0xe3] = () => this.#regops.e(this.#regops.e() & (1 << 4))
    // set 4,h
    this.#opcodes[0xcb][0xe4] = () => this.#regops.h(this.#regops.h() & (1 << 4))
    // set 4,l
    this.#opcodes[0xcb][0xe5] = () => this.#regops.l(this.#regops.l() & (1 << 4))
    // set 4,(hl)
    this.#opcodes[0xcb][0xe6] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & (1 << 4)
    }
    // set 4,a
    this.#opcodes[0xcb][0xe7] = () => this.#regops.a(this.#regops.a() & (1 << 4))
    // set 5,b
    this.#opcodes[0xcb][0xe8] = () => this.#regops.b(this.#regops.b() & (1 << 5))
    // set 5,c
    this.#opcodes[0xcb][0xe9] = () => this.#regops.c(this.#regops.c() & (1 << 5))
    // set 5,d
    this.#opcodes[0xcb][0xea] = () => this.#regops.d(this.#regops.d() & (1 << 5))
    // set 5,e
    this.#opcodes[0xcb][0xeb] = () => this.#regops.e(this.#regops.e() & (1 << 5))
    // set 5,h
    this.#opcodes[0xcb][0xec] = () => this.#regops.h(this.#regops.h() & (1 << 5))
    // set 5,l
    this.#opcodes[0xcb][0xed] = () => this.#regops.l(this.#regops.l() & (1 << 5))
    // set 5,(hl)
    this.#opcodes[0xcb][0xee] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & (1 << 5)
    }
    // set 5,a
    this.#opcodes[0xcb][0xef] = () => this.#regops.a(this.#regops.a() & (1 << 5))
    // set 6,b
    this.#opcodes[0xcb][0xf0] = () => this.#regops.b(this.#regops.b() & (1 << 6))
    // set 6,c
    this.#opcodes[0xcb][0xf1] = () => this.#regops.c(this.#regops.c() & (1 << 6))
    // set 6,d
    this.#opcodes[0xcb][0xf2] = () => this.#regops.d(this.#regops.d() & (1 << 6))
    // set 6,e
    this.#opcodes[0xcb][0xf3] = () => this.#regops.e(this.#regops.e() & (1 << 6))
    // set 6,h
    this.#opcodes[0xcb][0xf4] = () => this.#regops.h(this.#regops.h() & (1 << 6))
    // set 6,l
    this.#opcodes[0xcb][0xf5] = () => this.#regops.l(this.#regops.l() & (1 << 6))
    // set 6,(hl)
    this.#opcodes[0xcb][0xf6] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & (1 << 6)
    }
    // set 6,a
    this.#opcodes[0xcb][0xf7] = () => this.#regops.a(this.#regops.a() & (1 << 6))
    // set 7,b
    this.#opcodes[0xcb][0xf8] = () => this.#regops.b(this.#regops.b() & (1 << 7))
    // set 7,c
    this.#opcodes[0xcb][0xf9] = () => this.#regops.c(this.#regops.c() & (1 << 7))
    // set 7,d
    this.#opcodes[0xcb][0xfa] = () => this.#regops.d(this.#regops.d() & (1 << 7))
    // set 7,e
    this.#opcodes[0xcb][0xfb] = () => this.#regops.e(this.#regops.e() & (1 << 7))
    // set 7,h
    this.#opcodes[0xcb][0xfc] = () => this.#regops.h(this.#regops.h() & (1 << 7))
    // set 7,l
    this.#opcodes[0xcb][0xfd] = () => this.#regops.l(this.#regops.l() & (1 << 7))
    // set 7,(hl)
    this.#opcodes[0xcb][0xfe] = () => {
      this.#ram[this.#regops.hl()] = this.#ram[this.#regops.hl()] & (1 << 7)
    }
    // set 7,a
    this.#opcodes[0xcb][0xff] = () => this.#regops.a(this.#regops.a() & (1 << 7))
    // add ix,bc
    this.#opcodes[0xdd][0x09] = () => {
      this.#regops.ix(this.#add16(this.#regops.ix(), this.#regops.bc()))
    }
    // add ix,de
    this.#opcodes[0xdd][0x19] = () => {
      this.#regops.ix(this.#add16(this.#regops.ix(), this.#regops.de()))
    }
    // ld ix,nnnn
    this.#opcodes[0xdd][0x21] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.ix(this.#word(hi, lo))
    }
    // ld (nnnn),ix
    this.#opcodes[0xdd][0x22] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#ram[this.#word(hi, lo)] = this.#regops.x()
      this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.i()
    }
    // inc ix
    this.#opcodes[0xdd][0x23] = () => { this.#registers.ix = this.#addWord(this.#registers.ix, 1) }
    // inc ixh
    this.#opcodes[0xdd][0x24] = () => {
      this.#regops.ixh(this.#addByte(this.#regops.ixh(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.ixh() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.ixh()]
      )
    }
    // dec ixh
    this.#opcodes[0xdd][0x25] = () => {
      const old = this.#regops.ixh()
      this.#regops.ixh(this.#subByte(this.#regops.ixh(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.ixh() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.ixh()]
      )
    }
    // ld ixh,nn
    this.#opcodes[0xdd][0x26] = () => { this.#regops.ixh(this.#getPC()) }
    // add ix,ix
    this.#opcodes[0xdd][0x29] = () => {
      this.#regops.ix(this.#add16(this.#regops.ix(), this.#regops.ix()))
    }
    // ld ix,(nnnn)
    this.#opcodes[0xdd][0x2a] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.ixl(this.#ram[this.#word(hi, lo)])
      this.#regops.ixh(this.#ram[this.#addWord(this.#word(hi, lo), 1)])
    }
    // dec ix
    this.#opcodes[0xdd][0x2b] = () => { this.#registers.ix = this.#subWord(this.#registers.ix, 1) }
    // inc ixl
    this.#opcodes[0xdd][0x2c] = () => {
      this.#regops.ixl(this.#addByte(this.#regops.ixl(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.ixl() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.ixl()]
      )
    }
    // dec ixl
    this.#opcodes[0xdd][0x2d] = () => {
      const old = this.#regops.ixl()
      this.#regops.ixl(this.#subByte(this.#regops.ixl(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.ixl() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.ixl()]
      )
    }
    // ld ixl,nn
    this.#opcodes[0xdd][0x2e] = () => { this.#regops.ixl(this.#getPC()) }
    // inc (ix+dd)
    this.#opcodes[0xdd][0x34] = () => {
      const offset = this.#uint8ToInt8(this.#getPC())
      const oldByte = this.#ram[this.#registers.ix + offset]
      const newByte = this.#addByte(oldByte, 1)
      this.#ram[this.#registers.ix + offset] = newByte
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((oldByte & 0x0f) ? 0 : this.#FREG_H)
        | ((newByte == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[newByte]
      )
    }
    // dec (ix+dd)
    this.#opcodes[0xdd][0x35] = () => {
      const offset = this.#uint8ToInt8(this.#getPC())
      const oldByte = this.#ram[this.#registers.ix + offset]
      const newByte = this.#subByte(oldByte, 1)
      this.#ram[this.#registers.ix + offset] = newByte
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((oldByte & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((newByte == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[newByte]
      )
    }
    // ld (ix+dd),nn
    this.#opcodes[0xdd][0x36] = () => {
      this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())] = this.#getPC()
    }
    // add ix,sp
    this.#opcodes[0xdd][0x39] = () => {
      this.#regops.ix(this.#add16(this.#regops.ix(), this.#regops.sp()))
    }
    // ld b,ixh
    this.#opcodes[0xdd][0x44] = () => { this.#regops.b(this.#regops.ixh()) }
    // ld b,ixl
    this.#opcodes[0xdd][0x45] = () => { this.#regops.b(this.#regops.ixl()) }
    // ld b,(ix+dd)
    this.#opcodes[0xdd][0x46] = () => {
      this.#regops.b(this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())])
    }
    // ld c,ixh
    this.#opcodes[0xdd][0x4c] = () => { this.#regops.c(this.#regops.ixh()) }
    // ld c,ixl
    this.#opcodes[0xdd][0x4d] = () => { this.#regops.c(this.#regops.ixl()) }
    // ld c,(ix+dd)
    this.#opcodes[0xdd][0x4e] = () => {
      this.#regops.c(this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())])
    }
    // ld d,ixh
    this.#opcodes[0xdd][0x54] = () => { this.#regops.d(this.#regops.ixh()) }
    // ld d,ixl
    this.#opcodes[0xdd][0x55] = () => { this.#regops.d(this.#regops.ixl()) }
    // ld d,(ix+dd)
    this.#opcodes[0xdd][0x56] = () => {
      this.#regops.d(this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())])
    }
    // ld e,ixh
    this.#opcodes[0xdd][0x5c] = () => { this.#regops.e(this.#regops.ixh()) }
    // ld e,ixl
    this.#opcodes[0xdd][0x5d] = () => { this.#regops.e(this.#regops.ixl()) }
    // ld e,(ix+dd)
    this.#opcodes[0xdd][0x5e] = () => {
      this.#regops.e(this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())])
    }
    // ld ixh,b
    this.#opcodes[0xdd][0x60] = () => { this.#regops.ixh(this.#regops.b()) }
    // ld ixh,c
    this.#opcodes[0xdd][0x61] = () => { this.#regops.ixh(this.#regops.c()) }
    // ld ixh,d
    this.#opcodes[0xdd][0x62] = () => { this.#regops.ixh(this.#regops.d()) }
    // ld ixh,e
    this.#opcodes[0xdd][0x63] = () => { this.#regops.ixh(this.#regops.e()) }
    // ld ixh,ixh
    this.#opcodes[0xdd][0x64] = () => { this.#regops.ixh(this.#regops.ixh()) }
    // ld ixh,ixl
    this.#opcodes[0xdd][0x65] = () => { this.#regops.ixh(this.#regops.ixl()) }
    // ld h,(ix+dd)
    this.#opcodes[0xdd][0x66] = () => {
      this.#regops.h(this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())])
    }
    // ld ixh,a
    this.#opcodes[0xdd][0x67] = () => { this.#regops.ixh(this.#regops.a()) }
    // ld ixl,b
    this.#opcodes[0xdd][0x68] = () => { this.#regops.ixl(this.#regops.b()) }
    // ld ixl,c
    this.#opcodes[0xdd][0x69] = () => { this.#regops.ixl(this.#regops.c()) }
    // ld ixl,d
    this.#opcodes[0xdd][0x6a] = () => { this.#regops.ixl(this.#regops.d()) }
    // ld ixl,e
    this.#opcodes[0xdd][0x6b] = () => { this.#regops.ixl(this.#regops.e()) }
    // ld ixl,ixh
    this.#opcodes[0xdd][0x6c] = () => { this.#regops.ixl(this.#regops.ixh()) }
    // ld ixl,ixl
    this.#opcodes[0xdd][0x6d] = () => { this.#regops.ixl(this.#regops.ixl()) }
    // ld l,(ix+dd)
    this.#opcodes[0xdd][0x6e] = () => {
      this.#regops.l(this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())])
    }
    // ld ixl,a
    this.#opcodes[0xdd][0x6f] = () => { this.#regops.ixl(this.#regops.a()) }
    // ld (ix+dd),b
    this.#opcodes[0xdd][0x70] = () => {
      this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())] = this.#regops.b()
    }
    // ld (ix+dd),c
    this.#opcodes[0xdd][0x71] = () => {
      this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())] = this.#regops.c()
    }
    // ld (ix+dd),d
    this.#opcodes[0xdd][0x72] = () => {
      this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())] = this.#regops.d()
    }
    // ld (ix+dd),e
    this.#opcodes[0xdd][0x73] = () => {
      this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())] = this.#regops.e()
    }
    // ld (ix+dd),h
    this.#opcodes[0xdd][0x74] = () => {
      this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())] = this.#regops.h()
    }
    // ld (ix+dd),l
    this.#opcodes[0xdd][0x75] = () => {
      this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())] = this.#regops.l()
    }
    // ld (ix+dd),a
    this.#opcodes[0xdd][0x77] = () => {
      this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())] = this.#regops.a()
    }
    // ld a,ixh
    this.#opcodes[0xdd][0x7c] = () => { this.#regops.a(this.#regops.ixh()) }
    // ld a,ixl
    this.#opcodes[0xdd][0x7d] = () => { this.#regops.a(this.#regops.ixl()) }
    // ld a,(ix+dd)
    this.#opcodes[0xdd][0x7e] = () => {
      this.#regops.a(this.#ram[this.#registers.ix + this.#uint8ToInt8(this.#getPC())])
    }
    // add a,ixh
    this.#opcodes[0xdd][0x84] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.ixh()))
    }
    // add a,ixl
    this.#opcodes[0xdd][0x85] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.ixl()))
    }
    // add a,(ix+dd)
    this.#opcodes[0xdd][0x86] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())]))
    }
    // adc a,ixh
    this.#opcodes[0xdd][0x8c] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.ixh()))
    }
    // adc a,ixl
    this.#opcodes[0xdd][0x8d] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.ixl()))
    }
    // adc a,(ix+dd)
    this.#opcodes[0xdd][0x8e] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())]))
    }
    // sub a,ixh
    this.#opcodes[0xdd][0x94] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.ixh()))
    }
    // sub a,ixl
    this.#opcodes[0xdd][0x95] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.ixl()))
    }
    // sub a,(ix+dd)
    this.#opcodes[0xdd][0x96] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())]))
    }
    // sbc a,ixh
    this.#opcodes[0xdd][0x9c] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.ixh()))
    }
    // sbc a,ixl
    this.#opcodes[0xdd][0x9d] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.ixl()))
    }
    // sbc a,(ix+dd)
    this.#opcodes[0xdd][0x9e] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())]))
    }
    // and a,ixh
    this.#opcodes[0xdd][0xa4] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.ixh())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,ixl
    this.#opcodes[0xdd][0xa5] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.ixl())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,(ix+dd)
    this.#opcodes[0xdd][0xa6] = () => {
      this.#regops.a(this.#regops.a() & this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // xor a,ixh
    this.#opcodes[0xdd][0xac] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.ixh())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,ixl
    this.#opcodes[0xdd][0xad] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.ixl())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,(ix+dd)
    this.#opcodes[0xdd][0xae] = () => {
      this.#regops.a(this.#regops.a() ^ this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,ixh
    this.#opcodes[0xdd][0xb4] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.ixh())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,ixl
    this.#opcodes[0xdd][0xb5] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.ixl())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,(ix+dd)
    this.#opcodes[0xdd][0xb6] = () => {
      this.#regops.a(this.#regops.a() | this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // cp a,ixh
    this.#opcodes[0xdd][0xbc] = () => this.#cp8(this.#regops.a(), this.#regops.ixh())
    // cp a,ixl
    this.#opcodes[0xdd][0xbd] = () => this.#cp8(this.#regops.a(), this.#regops.ixl())
    // cp a,(ix+dd)
    this.#opcodes[0xdd][0xbe] = () => this.#cp8(this.#regops.a(), this.#ram[this.#regops.ix() + this.#uint8ToInt8(this.#getPC())])
    // shift ddfdcb (subtable of operations)
    this.#opcodes[0xdd][0xcb] = []
    // pop ix
    this.#opcodes[0xdd][0xe1] = () => { this.#regops.ix(this.#popWord()) }
    // ex (sp),ix
    this.#opcodes[0xdd][0xe3] = () => {
      const temp = this.#registers.ix
      const [lo, hi] = [this.#ram[this.#registers.sp], this.#ram[this.#addWord(this.#registers.sp, 1)]]
      this.#registers.ix = this.#word(hi, lo)
      this.#ram[this.#registers.sp] = this.#lo(temp)
      this.#ram[this.#addWord(this.#registers.sp, 1)] = this.#hi(temp)
    }
    // push ix
    this.#opcodes[0xdd][0xe5] = () => { this.#pushWord(this.#registers.ix) }
    // jp ix
    this.#opcodes[0xdd][0xe9] = () => { this.#registers.pc = this.#registers.ix }
    // ld sp,ix
    this.#opcodes[0xdd][0xf9] = () => { this.#regops.sp(this.#regops.ix()) }
    // in b,(c)
    this.#opcodes[0xed][0x40] = () => {
      this.#regops.b(this.#callIoHandler(this.#regops.c(), 'r'))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.b()])
    }
    // out (c),b
    this.#opcodes[0xed][0x41] = () => {
      this.#callIoHandler(this.#regops.c(), 'w', this.#regops.b())
    }
    // sbc hl,bc
    this.#opcodes[0xed][0x42] = () => {
      this.#regops.hl(this.#regops.hl - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.hl(this.#subWord(this.#sub16(this.#regops.hl(), this.#regops.bc())), (this.#regops.f() & this.#FREG_C ? 1 : 0))
    }
    // ld (nnnn),bc
    this.#opcodes[0xed][0x43] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#ram[this.#word(hi, lo)] = this.#regops.c()
      this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.b()
    }
    // neg
    this.#opcodes[0xed][0x7c] = () => this.#regops.a(this.#sub8(0, this.#regops.a()))
    // retn
    this.#opcodes[0xed][0x7d] = () => { this.#regops.pc(this.#popWord()) }
    // im 0
    this.#opcodes[0xed][0x6e] = () => { this.#registers.im = 0 }
    // ld i,a
    this.#opcodes[0xed][0x47] = () => { this.#regops.i(this.#regops.a()) }
    // in c,(c)
    this.#opcodes[0xed][0x48] = () => {
      this.#regops.c(this.#callIoHandler(this.#regops.c(), 'r'))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.c()])
    }
    // out (c),c
    this.#opcodes[0xed][0x49] = () => {
      this.#callIoHandler(this.#regops.c(), 'w', this.#regops.c())
    }
    // adc hl,bc
    this.#opcodes[0xed][0x4a] = () => {
      this.#regops.hl(this.this.#regops.hl + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.hl(this.#add16(this.#regops.hl(), this.#regops.bc()))
    }
    // ld bc,(nnnn)
    this.#opcodes[0xed][0x4b] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.c(this.#ram[this.#word(hi, lo)])
      this.#regops.b(this.#ram[this.#addWord(this.#word(hi, lo), 1)])
    }
    // ld r,a
    this.#opcodes[0xed][0x4f] = () => { this.#regops.r(this.#regops.a()) }
    // in d,(c)
    this.#opcodes[0xed][0x50] = () => {
      this.#regops.d(this.#callIoHandler(this.#regops.c(), 'r'))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.d()])
    }
    // out (c),d
    this.#opcodes[0xed][0x51] = () => {
      this.#callIoHandler(this.#regops.c(), 'w', this.#regops.d())
    }
    // sbc hl,de
    this.#opcodes[0xed][0x52] = () => {
      this.#regops.hl(this.#regops.hl - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.hl(this.#subWord(this.#sub16(this.#regops.hl(), this.#regops.de())), (this.#regops.f() & this.#FREG_C ? 1 : 0))
    }
    // ld (nnnn),de
    this.#opcodes[0xed][0x53] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#ram[this.#word(hi, lo)] = this.#regops.e()
      this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.d()
    }
    // im 1
    this.#opcodes[0xed][0x76] = () => { this.#registers.im = 1 }
    // ld a,i
    this.#opcodes[0xed][0x57] = () => { this.#regops.a(this.#regops.i()) }
    // in e,(c)
    this.#opcodes[0xed][0x58] = () => {
      this.#regops.e(this.#callIoHandler(this.#regops.c(), 'r'))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.e()])
    }
    // out (c),e
    this.#opcodes[0xed][0x59] = () => {
      this.#callIoHandler(this.#regops.c(), 'w', this.#regops.e())
    }
    // adc hl,de
    this.#opcodes[0xed][0x5a] = () => {
      this.#regops.hl(this.this.#regops.hl + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.hl(this.#add16(this.#regops.hl(), this.#regops.de()))
    }
    // ld de,(nnnn)
    this.#opcodes[0xed][0x5b] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.e(this.#ram[this.#word(hi, lo)])
      this.#regops.d(this.#ram[this.#addWord(this.#word(hi, lo), 1)])
    }
    // im 2
    this.#opcodes[0xed][0x7e] = () => { this.#registers.im = 2 }
    // ld a,r
    this.#opcodes[0xed][0x5f] = () => { this.#regops.a(this.#regops.r()) }
    // in h,(c)
    this.#opcodes[0xed][0x60] = () => {
      this.#regops.h(this.#callIoHandler(this.#regops.c(), 'r'))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.h()])
    }
    // out (c),h
    this.#opcodes[0xed][0x61] = () => {
      this.#callIoHandler(this.#regops.c(), 'w', this.#regops.h())
    }
    // sbc hl,hl
    this.#opcodes[0xed][0x62] = () => {
      this.#regops.hl(this.#regops.hl - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.hl(this.#subWord(this.#sub16(this.#regops.hl(), this.#regops.hl())), (this.#regops.f() & this.#FREG_C ? 1 : 0))
    }
    // ld (nnnn),hl
    this.#opcodes[0xed][0x63] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#ram[this.#word(hi, lo)] = this.#regops.l()
      this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.h()
    }
    // rrd
    this.#opcodes[0xed][0x67] = () => {
      const hlData = this.#ram[this.#registers.hl]
      this.#ram[this.#registers.hl] = ((this.#regops.a() << 4) | (hlData >> 4)) & 0xff;
      this.#regops.a((this.#regops.a() & 0xf0) | (hlData & 0x0f))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.a()])
    }
    // in l,(c)
    this.#opcodes[0xed][0x68] = () => {
      this.#regops.l(this.#callIoHandler(this.#regops.c(), 'r'))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.l()])
    }
    // out (c),l
    this.#opcodes[0xed][0x69] = () => {
      this.#callIoHandler(this.#regops.c(), 'w', this.#regops.l())
    }
    // adc hl,hl
    this.#opcodes[0xed][0x6a] = () => {
      this.#regops.hl(this.this.#regops.hl + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.hl(this.#add16(this.#regops.hl(), this.#regops.hl()))
    }
    // ld hl,(nnnn)
    this.#opcodes[0xed][0x6b] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.l(this.#ram[this.#word(hi, lo)])
      this.#regops.h(this.#ram[this.#addWord(this.#word(hi, lo), 1)])
    }
    // rld
    this.#opcodes[0xed][0x6f] = () => {
      const hlData = this.#ram[this.#registers.hl]
      this.#ram[this.#registers.hl] = ((hlData << 4) | (this.#regops.a() & 0x0f)) & 0xff;
      this.#regops.a((this.#regops.a() & 0xf0) | (hlData >> 0x0f))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.a()])
    }
    // in f,(c)
    this.#opcodes[0xed][0x70] = () => {
      this.#regops.f(this.#callIoHandler(this.#regops.c(), 'r'))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.c()])}
    // out (c),0
    this.#opcodes[0xed][0x71] = () => {
      this.#callIoHandler(this.#regops.c(), 'w', 0)
    }
    // sbc hl,sp
    this.#opcodes[0xed][0x72] = () => {
      this.#regops.hl(this.#regops.hl - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.hl(this.#subWord(this.#sub16(this.#regops.hl(), this.#regops.sp())), (this.#regops.f() & this.#FREG_C ? 1 : 0))
    }
    // ld (nnnn),sp
    this.#opcodes[0xed][0x73] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#ram[this.#word(hi, lo)] = this.#regops.p()
      this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.s()
    }
    // in a,(c)
    this.#opcodes[0xed][0x78] = () => {
      this.#regops.a(this.#callIoHandler(this.#regops.c(), 'r'))
      this.#regops.f((this.#regops.f() & this.#FREG_C) | this.#flagTable.sz53p[this.#regops.a()])
    }
    // out (c),a
    this.#opcodes[0xed][0x79] = () => {
      this.#callIoHandler(this.#regops.c(), 'w', this.#regops.a())
    }
    // adc hl,sp
    this.#opcodes[0xed][0x7a] = () => {
      this.#regops.hl(this.this.#regops.hl + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.hl(this.#add16(this.#regops.hl(), this.#regops.sp()))
    }
    // ld sp,(nnnn)
    this.#opcodes[0xed][0x7b] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.p(this.#ram[this.#word(hi, lo)])
      this.#regops.s(this.#ram[this.#addWord(this.#word(hi, lo), 1)])
    }
    // im 0
    this.#opcodes[0xed][0x46] = () => { this.#registers.im = 0 }
    // im 0
    this.#opcodes[0xed][0x66] = () => { this.#registers.im = 0 }
    // im 1
    this.#opcodes[0xed][0x56] = () => { this.#registers.im = 1 }
    // im 2
    this.#opcodes[0xed][0x5e] = () => { this.#registers.im = 2 }
    // im 2
    this.#opcodes[0xed][0x7e] = () => { this.#registers.im = 2 }
    // add iy,bc
    this.#opcodes[0xfd][0x09] = () => {
      this.#regops.iy(this.#add16(this.#regops.iy(), this.#regops.bc()))
    }
    // add iy,de
    this.#opcodes[0xfd][0x19] = () => {
      this.#regops.iy(this.#add16(this.#regops.iy(), this.#regops.de()))
    }
    // ld iy,nnnn
    this.#opcodes[0xfd][0x21] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.iy(this.#word(hi, lo))
    }
    // ld (nnnn),iy
    this.#opcodes[0xfd][0x22] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#ram[this.#word(hi, lo)] = this.#regops.y()
      this.#ram[this.#addWord(this.#word(hi, lo), 1)] = this.#regops.i()
    }
    // inc iy
    this.#opcodes[0xfd][0x23] = () => { this.#registers.iy = this.#addWord(this.#registers.iy, 1) }
    // inc iyh
    this.#opcodes[0xfd][0x24] = () => {
      this.#regops.iyh(this.#addByte(this.#regops.iyh(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.iyh() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.iyh()]
      )
    }
    // dec iyh
    this.#opcodes[0xfd][0x25] = () => {
      const old = this.#regops.iyh()
      this.#regops.iyh(this.#subByte(this.#regops.iyh(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.iyh() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.iyh()]
      )
    }
    // ld iyh,nn
    this.#opcodes[0xfd][0x26] = () => { this.#regops.iyh(this.#getPC()) }
    // add iy,iy
    this.#opcodes[0xfd][0x29] = () => {
      this.#regops.iy(this.#add16(this.#regops.iy(), this.#regops.iy()))
    }
    // ld iy,(nnnn)
    this.#opcodes[0xfd][0x2a] = () => {
      const [lo, hi] = [this.#getPC(), this.#getPC()]
      this.#regops.iyl(this.#ram[this.#word(hi, lo)])
      this.#regops.iyh(this.#ram[this.#addWord(this.#word(hi, lo), 1)])
    }
    // dec iy
    this.#opcodes[0xfd][0x2b] = () => { this.#registers.iy = this.#subWord(this.#registers.iy, 1) }
    // inc iyl
    this.#opcodes[0xfd][0x2c] = () => {
      this.#regops.iyl(this.#addByte(this.#regops.iyl(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((this.#regops.iyl() & 0x0f) ? 0 : this.#FREG_H)
        | ((this.#regops.f() == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.iyl()]
      )
    }
    // dec iyl
    this.#opcodes[0xfd][0x2d] = () => {
      const old = this.#regops.iyl()
      this.#regops.iyl(this.#subByte(this.#regops.iyl(), 1))
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((old & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((this.#regops.iyl() == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[this.#regops.iyl()]
      )
    }
    // ld iyl,nn
    this.#opcodes[0xfd][0x2e] = () => { this.#regops.iyl(this.#getPC()) }
    // inc (iy+dd)
    this.#opcodes[0xfd][0x34] = () => {
      const offset = this.#uint8ToInt8(this.#getPC())
      const oldByte = this.#ram[this.#registers.iy + offset]
      const newByte = this.#addByte(oldByte, 1)
      this.#ram[this.#registers.iy + offset] = newByte
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((oldByte & 0x0f) ? 0 : this.#FREG_H)
        | ((newByte == 0x80) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[newByte]
      )
    }
    // dec (iy+dd)
    this.#opcodes[0xfd][0x35] = () => {
      const offset = this.#uint8ToInt8(this.#getPC())
      const oldByte = this.#ram[this.#registers.iy + offset]
      const newByte = this.#subByte(oldByte, 1)
      this.#ram[this.#registers.iy + offset] = newByte
      this.#regops.f(
          this.#regops.f()
        | this.#FREG_C
        | ((oldByte & 0x0f) ? 0 : this.#FREG_H)
        | this.#FREG_N
        | ((newByte == 0x7f) ? this.#FREG_V : 0)
        | this.#flagTable.sz53[newByte]
      )
    }
    // ld (iy+dd),nn
    this.#opcodes[0xfd][0x36] = () => {
      this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())] = this.#getPC()
    }
    // add iy,sp
    this.#opcodes[0xfd][0x39] = () => {
      this.#regops.iy(this.#add16(this.#regops.iy(), this.#regops.sp()))
    }
    // ld b,iyh
    this.#opcodes[0xfd][0x44] = () => { this.#regops.b(this.#regops.iyh()) }
    // ld b,iyl
    this.#opcodes[0xfd][0x45] = () => { this.#regops.b(this.#regops.iyl()) }
    // ld b,(iy+dd)
    this.#opcodes[0xfd][0x46] = () => {
      this.#regops.b(this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())])
    }
    // ld c,iyh
    this.#opcodes[0xfd][0x4c] = () => { this.#regops.c(this.#regops.iyh()) }
    // ld c,iyl
    this.#opcodes[0xfd][0x4d] = () => { this.#regops.c(this.#regops.iyl()) }
    // ld c,(iy+dd)
    this.#opcodes[0xfd][0x4e] = () => {
      this.#regops.c(this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())])
    }
    // ld d,iyh
    this.#opcodes[0xfd][0x54] = () => { this.#regops.d(this.#regops.iyh()) }
    // ld d,iyl
    this.#opcodes[0xfd][0x55] = () => { this.#regops.d(this.#regops.iyl()) }
    // ld d,(iy+dd)
    this.#opcodes[0xfd][0x56] = () => {
      this.#regops.d(this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())])
    }
    // ld e,iyh
    this.#opcodes[0xfd][0x5c] = () => { this.#regops.e(this.#regops.iyh()) }
    // ld e,iyl
    this.#opcodes[0xfd][0x5d] = () => { this.#regops.e(this.#regops.iyl()) }
    // ld e,(iy+dd)
    this.#opcodes[0xfd][0x5e] = () => {
      this.#regops.e(this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())])
    }
    // ld iyh,b
    this.#opcodes[0xfd][0x60] = () => { this.#regops.iyh(this.#regops.b()) }
    // ld iyh,c
    this.#opcodes[0xfd][0x61] = () => { this.#regops.iyh(this.#regops.c()) }
    // ld iyh,d
    this.#opcodes[0xfd][0x62] = () => { this.#regops.iyh(this.#regops.d()) }
    // ld iyh,e
    this.#opcodes[0xfd][0x63] = () => { this.#regops.iyh(this.#regops.e()) }
    // ld iyh,iyh
    this.#opcodes[0xfd][0x64] = () => { this.#regops.iyh(this.#regops.iyh()) }
    // ld iyh,iyl
    this.#opcodes[0xfd][0x65] = () => { this.#regops.iyh(this.#regops.iyl()) }
    // ld h,(iy+dd)
    this.#opcodes[0xfd][0x66] = () => {
      this.#regops.h(this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())])
    }
    // ld iyh,a
    this.#opcodes[0xfd][0x67] = () => { this.#regops.iyh(this.#regops.a()) }
    // ld iyl,b
    this.#opcodes[0xfd][0x68] = () => { this.#regops.iyl(this.#regops.b()) }
    // ld iyl,c
    this.#opcodes[0xfd][0x69] = () => { this.#regops.iyl(this.#regops.c()) }
    // ld iyl,d
    this.#opcodes[0xfd][0x6a] = () => { this.#regops.iyl(this.#regops.d()) }
    // ld iyl,e
    this.#opcodes[0xfd][0x6b] = () => { this.#regops.iyl(this.#regops.e()) }
    // ld iyl,iyh
    this.#opcodes[0xfd][0x6c] = () => { this.#regops.iyl(this.#regops.iyh()) }
    // ld iyl,iyl
    this.#opcodes[0xfd][0x6d] = () => { this.#regops.iyl(this.#regops.iyl()) }
    // ld l,(iy+dd)
    this.#opcodes[0xfd][0x6e] = () => {
      this.#regops.l(this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())])
    }
    // ld iyl,a
    this.#opcodes[0xfd][0x6f] = () => { this.#regops.iyl(this.#regops.a()) }
    // ld (iy+dd),b
    this.#opcodes[0xfd][0x70] = () => {
      this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())] = this.#regops.b()
    }
    // ld (iy+dd),c
    this.#opcodes[0xfd][0x71] = () => {
      this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())] = this.#regops.c()
    }
    // ld (iy+dd),d
    this.#opcodes[0xfd][0x72] = () => {
      this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())] = this.#regops.d()
    }
    // ld (iy+dd),e
    this.#opcodes[0xfd][0x73] = () => {
      this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())] = this.#regops.e()
    }
    // ld (iy+dd),h
    this.#opcodes[0xfd][0x74] = () => {
      this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())] = this.#regops.h()
    }
    // ld (iy+dd),l
    this.#opcodes[0xfd][0x75] = () => {
      this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())] = this.#regops.l()
    }
    // ld (iy+dd),a
    this.#opcodes[0xfd][0x77] = () => {
      this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())] = this.#regops.a()
    }
    // ld a,iyh
    this.#opcodes[0xfd][0x7c] = () => { this.#regops.a(this.#regops.iyh()) }
    // ld a,iyl
    this.#opcodes[0xfd][0x7d] = () => { this.#regops.a(this.#regops.iyl()) }
    // ld a,(iy+dd)
    this.#opcodes[0xfd][0x7e] = () => {
      this.#regops.a(this.#ram[this.#registers.iy + this.#uint8ToInt8(this.#getPC())])
    }
    // add a,iyh
    this.#opcodes[0xfd][0x84] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.iyh()))
    }
    // add a,iyl
    this.#opcodes[0xfd][0x85] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.iyl()))
    }
    // add a,(iy+dd)
    this.#opcodes[0xfd][0x86] = () => {
      this.#regops.a(this.#add8(this.#regops.a(), this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())]))
    }
    // adc a,iyh
    this.#opcodes[0xfd][0x8c] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.iyh()))
    }
    // adc a,iyl
    this.#opcodes[0xfd][0x8d] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#regops.iyl()))
    }
    // adc a,(iy+dd)
    this.#opcodes[0xfd][0x8e] = () => {
      this.#regops.a(this.this.#regops.a + (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#add8(this.#regops.a(), this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())]))
    }
    // sub a,iyh
    this.#opcodes[0xfd][0x94] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.iyh()))
    }
    // sub a,iyl
    this.#opcodes[0xfd][0x95] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.iyl()))
    }
    // sub a,(iy+dd)
    this.#opcodes[0xfd][0x96] = () => {
      this.#regops.a(this.#sub8(this.#regops.a(), this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())]))
    }
    // sbc a,iyh
    this.#opcodes[0xfd][0x9c] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.iyh()))
    }
    // sbc a,iyl
    this.#opcodes[0xfd][0x9d] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#regops.iyl()))
    }
    // sbc a,(iy+dd)
    this.#opcodes[0xfd][0x9e] = () => {
      this.#regops.a(this.#regops.a - (this.#regops.f() & this.#FREG_C ? 1 : 0))
      this.#regops.a(this.#sub8(this.#regops.a(), this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())]))
    }
    // and a,iyh
    this.#opcodes[0xfd][0xa4] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.iyh())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,iyl
    this.#opcodes[0xfd][0xa5] = () => {
      this.#regops.a(this.#regops.a() & this.#regops.iyl())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // and a,(iy+dd)
    this.#opcodes[0xfd][0xa6] = () => {
      this.#regops.a(this.#regops.a() & this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()] | this.#FREG_H)
    }
    // xor a,iyh
    this.#opcodes[0xfd][0xac] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.iyh())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,iyl
    this.#opcodes[0xfd][0xad] = () => {
      this.#regops.a(this.#regops.a() ^ this.#regops.iyl())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // xor a,(iy+dd)
    this.#opcodes[0xfd][0xae] = () => {
      this.#regops.a(this.#regops.a() ^ this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,iyh
    this.#opcodes[0xfd][0xb4] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.iyh())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,iyl
    this.#opcodes[0xfd][0xb5] = () => {
      this.#regops.a(this.#regops.a() | this.#regops.iyl())
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // or a,(iy+dd)
    this.#opcodes[0xfd][0xb6] = () => {
      this.#regops.a(this.#regops.a() | this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())])
      this.#regops.f(this.#flagTable.sz53p[this.#regops.a()])
    }
    // cp a,iyh
    this.#opcodes[0xfd][0xbc] = () => this.#cp8(this.#regops.a(), this.#regops.iyh())
    // cp a,iyl
    this.#opcodes[0xfd][0xbd] = () => this.#cp8(this.#regops.a(), this.#regops.iyl())
    // cp a,(iy+dd)
    this.#opcodes[0xfd][0xbe] = () => this.#cp8(this.#regops.a(), this.#ram[this.#regops.iy() + this.#uint8ToInt8(this.#getPC())])
    // shift ddfdcb (subtable of operations)
    this.#opcodes[0xfd][0xcb] = []
    // pop iy
    this.#opcodes[0xfd][0xe1] = () => { this.#regops.iy(this.#popWord()) }
    // ex (sp),iy
    this.#opcodes[0xfd][0xe3] = () => {
      const temp = this.#registers.iy
      const [lo, hi] = [this.#ram[this.#registers.sp], this.#ram[this.#addWord(this.#registers.sp, 1)]]
      this.#registers.iy = this.#word(hi, lo)
      this.#ram[this.#registers.sp] = this.#lo(temp)
      this.#ram[this.#addWord(this.#registers.sp, 1)] = this.#hi(temp)
    }
    // push iy
    this.#opcodes[0xfd][0xe5] = () => { this.#pushWord(this.#registers.iy) }
    // jp iy
    this.#opcodes[0xfd][0xe9] = () => { this.#registers.pc = this.#registers.iy }
    // ld sp,iy
    this.#opcodes[0xfd][0xf9] = () => { this.#regops.sp(this.#regops.iy()) }
    // ld b,rlc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x00] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld c,rlc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x01] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld d,rlc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x02] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld e,rlc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x03] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld h,rlc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x04] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld l,rlc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x05] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // rlc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x06] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld a,rlc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x07] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld b,rrc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x08] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld c,rrc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x09] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld d,rrc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x0a] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld e,rrc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x0b] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld h,rrc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x0c] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld l,rrc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x0d] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // rrc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x0e] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld a,rrc (ix+dd)
    this.#opcodes[0xdd][0xcb][0x0f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld b,rl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x10] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,rl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x11] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,rl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x12] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,rl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x13] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,rl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x14] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,rl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x15] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // rl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x16] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,rl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x17] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,rr (ix+dd)
    this.#opcodes[0xdd][0xcb][0x18] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,rr (ix+dd)
    this.#opcodes[0xdd][0xcb][0x19] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,rr (ix+dd)
    this.#opcodes[0xdd][0xcb][0x1a] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,rr (ix+dd)
    this.#opcodes[0xdd][0xcb][0x1b] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,rr (ix+dd)
    this.#opcodes[0xdd][0xcb][0x1c] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,rr (ix+dd)
    this.#opcodes[0xdd][0xcb][0x1d] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // rr (ix+dd)
    this.#opcodes[0xdd][0xcb][0x1e] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,rr (ix+dd)
    this.#opcodes[0xdd][0xcb][0x1f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,sla (ix+dd)
    this.#opcodes[0xdd][0xcb][0x20] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,sla (ix+dd)
    this.#opcodes[0xdd][0xcb][0x21] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,sla (ix+dd)
    this.#opcodes[0xdd][0xcb][0x22] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,sla (ix+dd)
    this.#opcodes[0xdd][0xcb][0x23] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,sla (ix+dd)
    this.#opcodes[0xdd][0xcb][0x24] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,sla (ix+dd)
    this.#opcodes[0xdd][0xcb][0x25] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // sla (ix+dd)
    this.#opcodes[0xdd][0xcb][0x26] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] << 1)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,sla (ix+dd)
    this.#opcodes[0xdd][0xcb][0x27] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,sra (ix+dd)
    this.#opcodes[0xdd][0xcb][0x28] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,sra (ix+dd)
    this.#opcodes[0xdd][0xcb][0x29] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,sra (ix+dd)
    this.#opcodes[0xdd][0xcb][0x2a] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,sra (ix+dd)
    this.#opcodes[0xdd][0xcb][0x2b] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,sra (ix+dd)
    this.#opcodes[0xdd][0xcb][0x2c] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,sra (ix+dd)
    this.#opcodes[0xdd][0xcb][0x2d] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // sra (ix+dd)
    this.#opcodes[0xdd][0xcb][0x2e] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,sra (ix+dd)
    this.#opcodes[0xdd][0xcb][0x2f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,sll (ix+dd)
    this.#opcodes[0xdd][0xcb][0x30] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,sll (ix+dd)
    this.#opcodes[0xdd][0xcb][0x31] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,sll (ix+dd)
    this.#opcodes[0xdd][0xcb][0x32] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,sll (ix+dd)
    this.#opcodes[0xdd][0xcb][0x33] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,sll (ix+dd)
    this.#opcodes[0xdd][0xcb][0x34] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,sll (ix+dd)
    this.#opcodes[0xdd][0xcb][0x35] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // sll (ix+dd)
    this.#opcodes[0xdd][0xcb][0x36] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,sll (ix+dd)
    this.#opcodes[0xdd][0xcb][0x37] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.ix()] & 0x80) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,srl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x38] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,srl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x39] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,srl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x3a] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,srl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x3b] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,srl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x3c] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,srl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x3d] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // srl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x3e] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,srl (ix+dd)
    this.#opcodes[0xdd][0xcb][0x3f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // bit 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x47] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x4f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x57] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x5f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x67] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x6f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x77] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x7f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // ld b,res 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x80] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld c,res 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x81] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld d,res 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x82] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld e,res 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x83] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld h,res 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x84] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld l,res 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x85] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // res 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x86] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 0)
    }
    // ld a,res 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x87] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld b,res 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x88] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld c,res 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x89] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld d,res 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x8a] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld e,res 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x8b] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld h,res 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x8c] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld l,res 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x8d] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // res 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x8e] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 1)
    }
    // ld a,res 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x8f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld b,res 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x90] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld c,res 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x91] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld d,res 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x92] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld e,res 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x93] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld h,res 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x94] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld l,res 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x95] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // res 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x96] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 2)
    }
    // ld a,res 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x97] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld b,res 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x98] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld c,res 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x99] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld d,res 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x9a] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld e,res 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x9b] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld h,res 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x9c] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld l,res 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x9d] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // res 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x9e] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 3)
    }
    // ld a,res 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0x9f] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld b,res 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa0] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld c,res 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa1] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld d,res 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa2] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld e,res 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa3] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld h,res 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa4] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld l,res 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa5] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // res 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa6] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 4)
    }
    // ld a,res 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa7] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld b,res 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa8] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld c,res 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xa9] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld d,res 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xaa] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld e,res 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xab] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld h,res 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xac] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld l,res 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xad] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // res 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xae] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 5)
    }
    // ld a,res 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xaf] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld b,res 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb0] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld c,res 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb1] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld d,res 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb2] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld e,res 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb3] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld h,res 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb4] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld l,res 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb5] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // res 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb6] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 6)
    }
    // ld a,res 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb7] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld b,res 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb8] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld c,res 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xb9] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld d,res 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xba] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld e,res 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xbb] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld h,res 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xbc] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld l,res 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xbd] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // res 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xbe] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 7)
    }
    // ld a,res 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xbf] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld b,set 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc0] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld c,set 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc1] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld d,set 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc2] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld e,set 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc3] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld h,set 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc4] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld l,set 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc5] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // set 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc6] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 0)
    }
    // ld a,set 0,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc7] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld b,set 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc8] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld c,set 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xc9] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld d,set 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xca] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld e,set 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xcb] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld h,set 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xcc] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld l,set 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xcd] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // set 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xce] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 1)
    }
    // ld a,set 1,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xcf] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld b,set 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd0] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld c,set 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd1] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld d,set 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd2] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld e,set 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd3] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld h,set 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd4] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld l,set 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd5] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // set 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd6] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 2)
    }
    // ld a,set 2,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd7] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld b,set 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd8] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld c,set 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xd9] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld d,set 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xda] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld e,set 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xdb] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld h,set 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xdc] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld l,set 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xdd] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // set 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xde] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 3)
    }
    // ld a,set 3,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xdf] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld b,set 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe0] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld c,set 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe1] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld d,set 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe2] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld e,set 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe3] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld h,set 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe4] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld l,set 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe5] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // set 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe6] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 4)
    }
    // ld a,set 4,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe7] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld b,set 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe8] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld c,set 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xe9] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld d,set 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xea] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld e,set 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xeb] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld h,set 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xec] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld l,set 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xed] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // set 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xee] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 5)
    }
    // ld a,set 5,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xef] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld b,set 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf0] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld c,set 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf1] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld d,set 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf2] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld e,set 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf3] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld h,set 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf4] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld l,set 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf5] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // set 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf6] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 6)
    }
    // ld a,set 6,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf7] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld b,set 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf8] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld c,set 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xf9] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld d,set 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xfa] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld e,set 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xfb] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld h,set 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xfc] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld l,set 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xfd] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // set 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xfe] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 7)
    }
    // ld a,set 7,(ix+dd)
    this.#opcodes[0xdd][0xcb][0xff] = (dd) => {
      const location = this.#regops.ix() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld b,rlc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x00] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld c,rlc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x01] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld d,rlc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x02] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld e,rlc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x03] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld h,rlc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x04] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld l,rlc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x05] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // rlc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x06] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld a,rlc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x07] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 1) | (this.#ram[location] >> 7)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x01) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld b,rrc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x08] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld c,rrc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x09] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld d,rrc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x0a] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld e,rrc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x0b] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld h,rrc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x0c] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld l,rrc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x0d] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // rrc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x0e] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld a,rrc (iy+dd)
    this.#opcodes[0xfd][0xcb][0x0f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 7) | (this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(
          ((this.#ram[location] & 0x80) ? this.#FREG_C : 0)
        | this.#flagTable.sz53p[this.#ram[location]]
      )
    }
    // ld b,rl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x10] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,rl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x11] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,rl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x12] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,rl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x13] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,rl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x14] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,rl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x15] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // rl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x16] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,rl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x17] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x80) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 1) | (carry ? 0x01: 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,rr (iy+dd)
    this.#opcodes[0xfd][0xcb][0x18] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,rr (iy+dd)
    this.#opcodes[0xfd][0xcb][0x19] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,rr (iy+dd)
    this.#opcodes[0xfd][0xcb][0x1a] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,rr (iy+dd)
    this.#opcodes[0xfd][0xcb][0x1b] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,rr (iy+dd)
    this.#opcodes[0xfd][0xcb][0x1c] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,rr (iy+dd)
    this.#opcodes[0xfd][0xcb][0x1d] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // rr (iy+dd)
    this.#opcodes[0xfd][0xcb][0x1e] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,rr (iy+dd)
    this.#opcodes[0xfd][0xcb][0x1f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] >> 1) | (carry ? 0x80 : 0x00)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,sla (iy+dd)
    this.#opcodes[0xfd][0xcb][0x20] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,sla (iy+dd)
    this.#opcodes[0xfd][0xcb][0x21] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,sla (iy+dd)
    this.#opcodes[0xfd][0xcb][0x22] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,sla (iy+dd)
    this.#opcodes[0xfd][0xcb][0x23] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,sla (iy+dd)
    this.#opcodes[0xfd][0xcb][0x24] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,sla (iy+dd)
    this.#opcodes[0xfd][0xcb][0x25] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // sla (iy+dd)
    this.#opcodes[0xfd][0xcb][0x26] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] << 1)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,sla (iy+dd)
    this.#opcodes[0xfd][0xcb][0x27] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,sra (iy+dd)
    this.#opcodes[0xfd][0xcb][0x28] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,sra (iy+dd)
    this.#opcodes[0xfd][0xcb][0x29] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,sra (iy+dd)
    this.#opcodes[0xfd][0xcb][0x2a] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,sra (iy+dd)
    this.#opcodes[0xfd][0xcb][0x2b] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,sra (iy+dd)
    this.#opcodes[0xfd][0xcb][0x2c] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,sra (iy+dd)
    this.#opcodes[0xfd][0xcb][0x2d] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // sra (iy+dd)
    this.#opcodes[0xfd][0xcb][0x2e] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,sra (iy+dd)
    this.#opcodes[0xfd][0xcb][0x2f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] >> 1)) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,sll (iy+dd)
    this.#opcodes[0xfd][0xcb][0x30] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,sll (iy+dd)
    this.#opcodes[0xfd][0xcb][0x31] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,sll (iy+dd)
    this.#opcodes[0xfd][0xcb][0x32] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,sll (iy+dd)
    this.#opcodes[0xfd][0xcb][0x33] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,sll (iy+dd)
    this.#opcodes[0xfd][0xcb][0x34] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,sll (iy+dd)
    this.#opcodes[0xfd][0xcb][0x35] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // sll (iy+dd)
    this.#opcodes[0xfd][0xcb][0x36] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,sll (iy+dd)
    this.#opcodes[0xfd][0xcb][0x37] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[this.#regops.iy()] & 0x80) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] << 1) | 0x01) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld b,srl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x38] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.b(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld c,srl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x39] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.c(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld d,srl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x3a] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.d(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld e,srl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x3b] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.e(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld h,srl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x3c] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.h(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld l,srl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x3d] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.l(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // srl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x3e] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // ld a,srl (iy+dd)
    this.#opcodes[0xfd][0xcb][0x3f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      const carry = (this.#ram[location] & 0x01) ? this.#FREG_C : 0
      this.#regops.a(this.#ram[location] = ((this.#ram[location] >> 1) | 0x80) & 0xff)
      this.#regops.f(carry | this.#flagTable.sz53p[this.#ram[location]])
    }
    // bit 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x47] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 0)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x4f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 1)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x57] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 2)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x5f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 3)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x67] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 4)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x6f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 5)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x77] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 6)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // bit 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x7f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.f(
          (this.#regops.f() & this.#FREG_C)
        | this.#FREG_H
        | (this.#ram[location] & (this.#FREG_F3 | this.#FREG_F5))
        | (((this.#ram[location] & (1 << 7)) === 0) ? (this.#FREG_P | this.#FREG_Z) : 0)
      )
    }
    // ld b,res 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x80] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld c,res 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x81] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld d,res 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x82] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld e,res 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x83] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld h,res 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x84] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld l,res 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x85] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // res 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x86] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 0)
    }
    // ld a,res 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x87] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 0))
    }
    // ld b,res 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x88] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld c,res 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x89] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld d,res 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x8a] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld e,res 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x8b] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld h,res 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x8c] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld l,res 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x8d] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // res 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x8e] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 1)
    }
    // ld a,res 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x8f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 1))
    }
    // ld b,res 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x90] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld c,res 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x91] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld d,res 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x92] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld e,res 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x93] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld h,res 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x94] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld l,res 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x95] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // res 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x96] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 2)
    }
    // ld a,res 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x97] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 2))
    }
    // ld b,res 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x98] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld c,res 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x99] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld d,res 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x9a] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld e,res 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x9b] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld h,res 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x9c] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld l,res 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x9d] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // res 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x9e] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 3)
    }
    // ld a,res 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0x9f] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 3))
    }
    // ld b,res 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa0] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld c,res 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa1] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld d,res 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa2] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld e,res 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa3] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld h,res 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa4] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld l,res 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa5] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // res 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa6] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 4)
    }
    // ld a,res 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa7] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 4))
    }
    // ld b,res 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa8] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld c,res 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xa9] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld d,res 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xaa] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld e,res 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xab] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld h,res 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xac] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld l,res 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xad] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // res 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xae] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 5)
    }
    // ld a,res 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xaf] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 5))
    }
    // ld b,res 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb0] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld c,res 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb1] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld d,res 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb2] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld e,res 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb3] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld h,res 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb4] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld l,res 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb5] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // res 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb6] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 6)
    }
    // ld a,res 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb7] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 6))
    }
    // ld b,res 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb8] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld c,res 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xb9] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld d,res 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xba] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld e,res 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xbb] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld h,res 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xbc] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld l,res 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xbd] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // res 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xbe] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & ~(1 << 7)
    }
    // ld a,res 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xbf] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & ~(1 << 7))
    }
    // ld b,set 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc0] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld c,set 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc1] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld d,set 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc2] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld e,set 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc3] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld h,set 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc4] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld l,set 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc5] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // set 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc6] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 0)
    }
    // ld a,set 0,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc7] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 0))
    }
    // ld b,set 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc8] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld c,set 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xc9] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld d,set 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xca] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld e,set 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xcb] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld h,set 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xcc] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld l,set 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xcd] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // set 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xce] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 1)
    }
    // ld a,set 1,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xcf] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 1))
    }
    // ld b,set 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd0] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld c,set 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd1] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld d,set 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd2] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld e,set 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd3] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld h,set 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd4] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld l,set 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd5] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // set 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd6] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 2)
    }
    // ld a,set 2,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd7] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 2))
    }
    // ld b,set 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd8] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld c,set 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xd9] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld d,set 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xda] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld e,set 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xdb] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld h,set 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xdc] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld l,set 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xdd] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // set 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xde] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 3)
    }
    // ld a,set 3,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xdf] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 3))
    }
    // ld b,set 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe0] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld c,set 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe1] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld d,set 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe2] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld e,set 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe3] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld h,set 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe4] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld l,set 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe5] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // set 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe6] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 4)
    }
    // ld a,set 4,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe7] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 4))
    }
    // ld b,set 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe8] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld c,set 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xe9] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld d,set 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xea] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld e,set 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xeb] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld h,set 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xec] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld l,set 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xed] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // set 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xee] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 5)
    }
    // ld a,set 5,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xef] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 5))
    }
    // ld b,set 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf0] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld c,set 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf1] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld d,set 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf2] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld e,set 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf3] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld h,set 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf4] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld l,set 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf5] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // set 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf6] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 6)
    }
    // ld a,set 6,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf7] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 6))
    }
    // ld b,set 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf8] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.b(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld c,set 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xf9] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.c(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld d,set 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xfa] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.d(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld e,set 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xfb] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.e(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld h,set 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xfc] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.h(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // ld l,set 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xfd] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.l(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // set 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xfe] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#ram[location] = this.#ram[location] & (1 << 7)
    }
    // ld a,set 7,(iy+dd)
    this.#opcodes[0xfd][0xcb][0xff] = (dd) => {
      const location = this.#regops.iy() + this.#uint8ToInt8(dd)
      this.#regops.a(this.#ram[location] = this.#ram[location] & (1 << 7))
    }
    // END: this block is AUTOMATICALLY GENERATED SEE /z80_tables/*
  }

  // our prepared instruction
  #preparedInstruction = {}

  /**
   * Constructor
   *
   * @param Uint8Array ram    64KB of memory for the CPU
   */
  constructor(ram = null)
  {
    // initialise memory to zero
    for (let i = 0; i < Math.pow(2, 16); i++) {
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
   * Get the state of interrupts
   *
   * @return boolean
   */
  getInterruptState()
  {
    return this.#interrupts
  }

  /**
   * Convert an opcode instruction table chain to a hex string
   *
   * @param array   callchain   The callchain to convert into a hex string
   * @return string
   */
  callChainToHex(callchain = [])
  {
    return callchain.reduce((p, c, i) => p = p + c.toString(16).toUpperCase(), '0x')
  }

  /**
   * Fetch an instruction
   *
   * @return void
   */
  fetch()
  {
    let inFetch = true
    this.#preparedInstruction = {
      instruction: [],
      dd: null,
      opcodeScope: this.#opcodes
    }

    while (inFetch) {
      // ddcb/fdcb subtable workaround - z80 ddcb/fdcb instructions follow the format 0x[dd/fd] 0xcb <parameter> <opcode>.
      // so if we're at this level, pull the parameter and put into this.#pI.dd and fetch the next value for instruction.
      // ALL OTHER +dd instructions (in IX/IY indirect levels 0xdd/fd) are handled by the simulated opcode and don't need this!
      if ((this.#preparedInstruction.instruction.length === 2) &&
          [0xdd, 0xfd].includes(this.#preparedInstruction.instruction[0]) &&
          (this.#preparedInstruction.instruction[1] === 0xcb))
        this.#preparedInstruction.dd = this.#getPC()

      const opcode = this.#getPC()
      this.#preparedInstruction.instruction.push(opcode)

      // check for invalid instruction
      if (typeof this.#preparedInstruction.opcodeScope[opcode] === 'undefined') {
        throw `CPU FAULT: invalid instruction opcode ${this.callChainToHex(this.#preparedInstruction.instruction)}`
      }

      if (typeof this.#preparedInstruction.opcodeScope[opcode] === 'object') {
        // switch to a subtable
        this.#preparedInstruction.opcodeScope = this.#preparedInstruction.opcodeScope[opcode]
        continue
      }

      if (typeof this.#preparedInstruction.opcodeScope[opcode] === 'function') {
        this.#preparedInstruction.opcodeScope = this.#preparedInstruction.opcodeScope[opcode]
        inFetch = false
        continue // this will break out of the fetch loop
      }

      throw `vCPU FAULT: error in opcode table, examine callchain ${this.callChainToHex(this.#preparedInstruction.instruction)}`
    }
  }

  /**
   * Execute an instruction which has been fetched with this.fetch()
   *
   * @return void
   */
  execute()
  {
    if ((this.#preparedInstruction === {})
        || (this.#preparedInstruction.instruction === [])
        || (typeof this.#preparedInstruction.opcodeScope !== 'function'))
      throw `vCPU FAULT: execute() called without fetch() or major fault`

    this.#preparedInstruction.opcodeScope(this.#preparedInstruction.dd)
  }

  /**
   * Setup an I/O handler by inserting it into the ioHandler array; an input/output on that port will
   * call the supplied callback.
   *
   * @param number      port    I/O port (0-255) to attach callback to
   * @param ioFunction  handler Function to call during I/O operation; will pass 'r'/'w' as arg1, uint8 data as arg2
   * @return void
   */
  addIoHandler(port, ioFunction)
  {
    this.#ioHandlers[port] = ioFunction
  }

  /**
   * CPU opcode helper to call the I/O handler
   *
   * @param number      port  I/O port number
   * @param string      rw    Read/write (r or w)
   * @param number|void data  Data byte to send/get (may be undefined for reads)
   * @return number|void
   */
  #callIoHandler = (port, rw, data) => {
    if (typeof this.#ioHandlers[port] === 'undefined')
      return

    return this.#ioHandlers[port](rw, data)
  }
}

export default ProcessorZ80
