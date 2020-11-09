# zedide

**Note: this project is not accepting any contributions as it constitutes a piece of academic work.**

## Introduction

`zedide` is an in-development Integrated Development Environment (IDE) for writing Z80 assembler. It combines an editor, assembler, simulator and debugger in a single user interface, with server-side and browser-side storage for projects.

It is intended as an easy-to-use tool to introduce developers to assembly language without having to install large IDEs just to use a small part of them for assembly language. It also provides an alternative to more lightweight commandline tooling by being both instantly accessible and lightweight.

## Why Z80?

The Zilog Z80 CPU is a clone of the Intel 8080, which Intel encapsulated as a subset of the 8086 instruction set. The Z80 has notable improvements over the 8080, but the intention is that the smaller subset of instructions is better suited to learning rather than a larger CPU architecture such as x86 or amd64: in essence, it is intended as a foothold in the assembly language arena before moving onto more complex architectures.

## Gratitude

`zedide` is based upon several opensource projects and uses a lot of libraries and owes immense gratitude to all of them.

Foremost, the opcode tables were borrowed from Philip Kendall's [FUSE emulator](http://fuse-emulator.sourceforge.net/) (a fantastic ZX Spectrum emulator); the perl-based z80.c generator helped explain some of the more arcane behaviours of flag handling, as well as the sign/zero/parity/even flag tables and a good number of the opcodes which I was unfamiliar with.

JavaScript * CSS libraries:
  * [babel](https://babeljs.io)
  * [angularjs](https://angular.io/)
  * [asm80](https://github.com/maly/asm80-node)
  * [codemirror](https://codemirror.net)
  * [express](https://expressjs.com/)
  * [ejs](https://ejs.co)
  * [webpack](https://webpack.js.org/)
  * [bootstrap](https://getbootstrap.com/) (which in turn uses [jquery](https://jquery.com/) and [popper.js](https://popper.js.org/https://popper.js.org/))
  * [bootstrap-dark](https://github.com/ForEvolve/bootstrap-dark)
  * [mongoose](https://github.com/mongodb/node-mongodb-native)

Were also used, and though they are not directly mentioned, their dependencies without which they would not work. And not forgetting the amazing [node.js](https://nodejs.org/) and [MongoDB](https://www.mongodb.com/). My most heartfelt thanks for everyone's hard work.

## License

Please read [the license](LICENSE.md) for more details: `zedide` is licensed under the Creative Commons CC-BY-SA 4.0 license.

## Author

rob andrews &lt;[rob@aphlor.org](mailto:rob@aphlor.org)&gt;
