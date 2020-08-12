class ProcessorZ80
{
  // cpu registers
  #registers = {
    pc: 0x0000,
    sp: 0x0000,
    af: 0x0000,
    af2: 0x0000,
    bc: 0x0000,
    bc2: 0x0000,
    de: 0x0000,
    de2: 0x0000,
    hl: 0x0000,
    hl2: 0x0000,
    ix: 0x0000,
    iy: 0x0000,
    i: 0x00,
    r: 0x00
  }

  // F register bitmasks
  #FLAG_C = 0  // carry
  #FLAG_N = 1  // subtract (1 if last opcode was subtract)
  #FLAG_PV = 2 // parity/overflow; P1 if even number of bits, V if 2-comp doesn't fit in register
  #FLAG_F3 = 3 // undocumented, copy of PV
  #FLAG_H = 4  // half carry (if nibble overflows)
  #FLAG_F5 = 5 // undocumented, copy of H
  #FLAG_Z = 6  // zero; 1 if last comparison was zero
  #FLAG_S = 7  // sign; 1 if 2-comp is negative (copy of msb)

  // memory area (64KB)
  #ram = new Uint8Array(Math.pow(2, 16))

  // opcode instruction table
  #opcodes = {}

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
      if (a & (1 << 7))
        f = f | (1 << this.#FLAG_C)
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
   * Get the upper byte of a number (MSB)
   *
   * @param number  value Value to fetch 8 MSBs from
   * @return number
   */
  #getUpperByte = (value) => {
    return (value & 0xff00) >> 8
  }

  /**
   * Get the lower byte of a number (MSB)
   *
   * @param number  value Value to fetch 8 LSBs from
   * @return number
   */
  #getLowerByte = (value) => {
    return (value & 0x00ff) // no shift needed, it's the lsb already
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
