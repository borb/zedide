import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/z80/z80'
import 'codemirror/addon/hint/show-hint'
import 'codemirror/addon/hint/show-hint.css'
import ASM from 'asm80/asm'
import Monolith from 'asm80/monolith'
import hextools from 'asm80/hextools'
import angular from 'angular'
import 'angular-sanitize'

import './hint/codemirror-z80'
import ProcessorZ80 from './cpu/z80'

let application

// setup the angular application
document.addEventListener('DOMContentLoaded', () => {
  // bootstrap angularjs
  angular.element(() => {
    angular.bootstrap(document, ['webZ80Ide'])
  })

  application = angular.module('webZ80Ide', ['ngSanitize'])

  // register a filter that allows us to retain newlines when outputting text
  application.filter('nl2br', ['$sanitize', ($sanitize) => {
    return (input) => {
      return $sanitize(
        input
          .replace(/>/g, '&gt;')
          .replace(/</g, '&lt;')
          .replace(/\n/g, '<br/>')
      )
    }
  }])

  application.controller('ideController', ['$scope', '$http', ($scope, $http) => {
    $scope.outputMessages = 'Welcome!\n'

    $scope.cpu = undefined

    $scope.codeMirror = CodeMirror.fromTextArea(
      document.getElementById('code-editor'),
      {
        lineNumbers: true,
        extraKeys: {
          "Ctrl-Space": "autocomplete"
        },
        mode: 'z80'
      }
    )

    $scope.regs = {
      pc: 'na',
      sp: 'na',
      a: 'na',
      af: 'na',
      a2: 'na',
      af2: 'na',
      bc: 'na',
      bc2: 'na',
      de: 'na',
      de2: 'na',
      hl: 'na',
      hl2: 'na',
      ix: 'na',
      iy: 'na',
      i: 'na',
      r: 'na',
      im: 'na',
      flags: 'na'
    }

    $scope.updateRegisters = (regs) => {
      Object.keys(regs).forEach((key) => {
        $scope.regs[key] = regs[key].toString(16)
      })
      // pull the left 8 bits of af into a and format
      $scope.regs.a = ($scope.regs.af >> 8) & 0xff
      $scope.regs.a2 = ($scope.regs.af2 >> 8) & 0xff
      // format the flags as bits
      let flags = ($scope.regs.f & 0x00ff).toString(2)
      flags = ('0'.repeat(8 - flags.length)) + flags
      $scope.regs.flags = flags
    }

    $scope.doCompile = (source) => {
      let [error, build, symbols] = ASM.compile(source, Monolith.Z80)
      if (error === null) {
        let hex = ASM.hex(build[0])
        return hextools.hex2bin(hex, 0, Math.pow(2, 16) - 1)
      }
      // an error during compilation
      $scope.outputMessages += `Build failed\n${error.msg} (at line ${error.s.numline}, '${error.s.line}')`
      console.log(error)
      return false
    }

    $scope.assemble = () => {
      let binary = $scope.doCompile($scope.codeMirror.getValue())
      if (binary !== false) {
        // setup the cpu with the built program
        $scope.cpu = new ProcessorZ80(binary)
        $scope.updateRegisters($scope.cpu.getRegisters())

        $scope.outputMessages = 'Build succeeded\n'
      }
    }

    $scope.step = () => {
      if ($scope.regs.pc === 'na') {
        $scope.outputMessages += 'Cannot step through program until it has been built: Please click "Assemble"\n'
        return
      }

      try {
        $scope.cpu.fetch()
        $scope.cpu.execute()
      } catch (e) {
        $scope.outputMessages += e
      }
      $scope.updateRegisters($scope.cpu.getRegisters())
    }
  }])
})
