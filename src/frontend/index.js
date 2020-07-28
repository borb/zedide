import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/z80/z80'
import 'codemirror/addon/hint/show-hint'
import 'codemirror/addon/hint/show-hint.css'
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
