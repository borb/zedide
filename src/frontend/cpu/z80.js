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
  // cpu registers
  #registers = {
    // program counter
    pc: 0x0000,
    // stack pointer
    sp: 0x0000,
    // accumulator
    a: 0x00,
    a2: 0x00,
    // flags
    f: 0x00,
    f2: 0x00,
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
  #opcodes = {}

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
   * This seems like an unusal way of doing things, but:
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
    // nop
    this.#opcodes[0x00] = () => {}
    // ld bc, **
    this.#opcodes[0x01] = () => {
      this.#registers.bc = this.#byteSwap(this.#getUint16FromPC())
    }
    // ld (bc), a
    this.#opcodes[0x02] = () => {
      // @todo does bc need byteswapping before this?
      this.#ram[this.#registers.bc] = this.#getUpperByte(this.#registers.af)
    }
    // inc bc
    this.#opcodes[0x03] = () => {
      this.#registers.bc++
      if (this.#registers.bc == 0xffff)
        this.#registers.bc = 0x0000
    }
    // inc b
    this.#opcodes[0x04] = () => {
      let b = this.#getUpperByte(this.#registers.bc) + 1
      if (b == 0x100)
        b = 0
      this.#registers.bc = (b << 8) | this.#getLowerByte(this.#registers.bc)
    }
    // dec b
    this.#opcodes[0x05] = () => {
      let b = this.#getUpperByte(this.#registers.bc) - 1
      if (b == -1)
        b = 0xff
      this.#registers.bc = (b << 8) | this.#getLowerByte(this.#registers.bc)
    }
    // ld b, *
    this.#opcodes[0x06] = () => {
      this.#registers.bc = (this.#getUint8FromPC() << 8) | this.#getLowerByte(this.#registers.bc)
    }
    // rlca
    this.#opcodes[0x07] = () => {
      let a = this.#getUpperByte(this.#registers.af)
      let f = this.#getLowerByte(this.#registers.af)
      f &= ~(1 << this.#FLAG_C)
      if (a & (1 << 7))
        f |= 1 << this.#FLAG_C
      a = (a << 1) & 0xff
      this.#registers.af = (a << 8) | f
    }
    // ex af, af'
    this.#opcodes[0x08] = () => {
      let temp = this.#registers.af2
      this.#registers.af2 = this.#registers.af
      this.#registers.af = temp
    }
    // add hl, bc
    this.#opcodes[0x09] = () => {
      this.#registers.hl += this.#registers.bc
      if (this.#registers.hl > 0xffff)
        this.#registers.hl -= 0x10000
    }
  }

  /**
   * Get a byte from PC
   *
   * @return number
   */
  #getUint8FromPC = () => {
    return this.#ram[this.#registers.pc++]
  }

  /**
   * Get two bytes from PC, adhering to little endianness
   *
   * @return number
   */
  #getUint16FromPC = () => {
    return this.#ram[this.#registers.pc++] + (16 * this.#ram[this.#registers.pc++])
  }

  /**
   * Perform a byteswap (0xaabb becomes 0xbbaa)
   *
   * @param number  value Value to be byteswapped
   * @return number
   */
  #byteSwap = (value) => {
    return ((value & 0x00ff) << 8) |  // mask off MSB and move LSB left 8 bits
           ((value & 0xff00) >> 8)    // then mask off LSB and move MSB right 8 bits
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
