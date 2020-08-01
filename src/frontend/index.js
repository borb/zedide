import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/z80/z80'
import 'codemirror/addon/hint/show-hint'
import 'codemirror/addon/hint/show-hint.css'
import ASM from 'asm80/asm'
import Monolith from 'asm80/monolith'
import hextools from 'asm80/hextools'

import './hint/codemirror-z80'

const codeMirror = CodeMirror.fromTextArea(
  document.getElementById('code-editor'),
  {
    lineNumbers: true,
    extraKeys: {
      "Ctrl-Space": "autocomplete"
    },
    mode: 'z80'
  }
)

const doCompile = (source) => {
  let vxx = ASM.compile(source, Monolith.Z80)
  console.log(vxx)
  let hex = ASM.hex(vxx[0])
  return hextools.hex2bin(hex, 0, Math.pow(2, 16) - 1)
}

// push this into the document object so we can access it outside of scope
document.codeMirror = codeMirror
document.doCompile = doCompile
