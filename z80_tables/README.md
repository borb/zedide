# Z80 opcode tables

This directory contains Z80 opcode tables as written by Philip Kendall for the Fuse emulator. Fuse quite cleverly generates C code from the textual tables using a perl interpreter; whilst I have not adapted the perl to suite the javascript simulator, the principle still functions similarly.

The tables have been somewhat modified (removal of slt trap, empty opcodes removed) for the purpose of ProcessorZ80.

Fuse is a fantastic ZX Spectrum emulator and is licensed under the GNU General Public License (GPL) version 2. Importantly, these tables retain the same GPLv2 license.

Fuse can be found at:

    http://fuse-emulator.sourceforge.net/

My most heartfelt thanks to Philip Kendall for his hard work (and all of the fun I've had playing Manic Miner to completion now I can save state).
