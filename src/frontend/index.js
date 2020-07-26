import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/z80/z80'

const codeMirror = CodeMirror.fromTextArea(
  document.getElementById('code-editor'),
  {
    lineNumbers: true,
    mode: 'z80'
  }
)
