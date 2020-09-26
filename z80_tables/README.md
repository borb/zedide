# Z80 opcode tables

This directory contains Z80 opcode tables as written by Philip Kendall for the Fuse emulator. Fuse quite cleverly generates C code from the textual tables using a perl interpreter; whilst I have not adapted the perl to suite the javascript simulator, the principle still functions similarly.

The tables have been somewhat modified (removal of slt trap, empty opcodes removed) for the purpose of ProcessorZ80.

Fuse is a fantastic ZX Spectrum emulator and is licensed under the GNU General Public License (GPL) version 2. Importantly, these tables retain the same GPLv2 license.

Fuse can be found at:

> http://fuse-emulator.sourceforge.net/

My most heartfelt thanks to Philip Kendall for his hard work (and all of the fun I've had playing Manic Miner to completion now I can save state).

## `translate_z80_tables.js`

This is a tool to convert the Fuse emulator opcode tables into usable Javascript. The help output reads:

```
translate_z80_tables.js: convert Z80 opcode tables from Philip Kendall's FUSE to JavaScript.

Usage:
  translate_z80_tables.js <input> <output> [<subtable index> <REGISTER name>]

  Arguments:
    -h  --help    This help information

  Parameters:
    <input>           The opcode file to read
    <output>          The JavaScript file to write
    <subtable index>  Byte prefix for shifted opcodes - can be more than one byte, e.g. ED, DDCB
    <REGISTER name>   Substitute occurences of REGISTER for this value - e.g. IX, IY

  Author:
    rob andrews <rob@aphlor.org>
```

Example of usage:

```shell
$ ./translate_z80_tables.js opcodes_base.dat opcodes_base.js
$ ./translate_z80_tables.js opcodes_ed.dat opcodes_ed.js ed
$ ./translate_z80_tables.js opcodes_ddfdcb.dat opcodes_ddcb.js ddcb ix
```

The supplied opcode tables omit the $ED table instruction opcode $FB (slttrap, normally an invalid instruction on a Z80), however if the opcode exists then the translator will safely omit the instruction and produce an ignorable warning.
