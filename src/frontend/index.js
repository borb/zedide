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
  let [error, build, symbols] = ASM.compile(source, Monolith.Z80)
  if (error === null) {
    let hex = ASM.hex(build[0])
    return hextools.hex2bin(hex, 0, Math.pow(2, 16) - 1)
  }
  // an error during compilation
  console.log(error)
  document.getElementById('output-messages').innerHTML = `
    <p>Build failed.</p>
    <pre>${error.msg} (at line ${error.s.numline}, '${error.s.line}')</pre>
  `
  return false
}

// push this into the document object so we can access it outside of scope
document.codeMirror = codeMirror
document.doCompile = doCompile
document.assemble = () => {
  let output = document.doCompile(document.codeMirror.getValue())
  if (output !== false) {
    document.getElementById('output-messages').innerHTML = '<p>Build succeeded.</p>'
  }
}
