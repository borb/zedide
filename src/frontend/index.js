'use strict'

/**
 * angular core application for zedide's frontend interface.
 *
 * rob andrews <rob@aphlor.org>
 */

import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/z80/z80.js'
import 'codemirror/addon/hint/show-hint.js'
import 'codemirror/addon/hint/show-hint.css'
import ASM from 'asm80/asm.js'
import Monolith from 'asm80/monolith.js'
import hextools from 'asm80/hextools.js'
import angular from 'angular'
import 'angular-sanitize'
import MemoryMap from 'nrf-intel-hex'

import './hint/codemirror-z80.js'
import ProcessorZ80 from './cpu/z80.js'

let application

// setup the angular application
document.addEventListener('DOMContentLoaded', () => {
  // bootstrap angularjs
  angular.element(() => {
    angular.bootstrap(document, ['zedide'])
  })

  application = angular.module('zedide', ['ngSanitize'])

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
    $scope.cpuOutput = ''
    $scope.running = false
    $scope.timer = false
    $scope.dirty = true
    $scope.pcToLineMap = []
    $scope.lastLine = null

    $scope.cpu = undefined

    $scope.codeMirror = CodeMirror.fromTextArea(
      document.getElementById('code-editor'),
      {
        lineNumbers: true,
        styleActiveLine: true,
        styleActiveSelected: true,
        extraKeys: {
          'Ctrl-Space': 'autocomplete'
        },
        mode: 'z80'
      }
    )
    $scope.codeMirror.on('change', () => {
      $scope.dirty = true
    })

    $scope.regs = {
      pc: '--',
      sp: '--',
      a: '--',
      af: '--',
      a2: '--',
      af2: '--',
      bc: '--',
      bc2: '--',
      de: '--',
      de2: '--',
      hl: '--',
      hl2: '--',
      ix: '--',
      iy: '--',
      i: '--',
      r: '--',
      im: '--',
      flags: '--'
    }

    $scope.updateRegisters = (regs) => {
      // pull the left 8 bits of af into a
      regs.a = (regs.af >> 8) & 0xff
      regs.a2 = (regs.af2 >> 8) & 0xff

      // format everything as hex
      Object.keys(regs).forEach((key) => {
        $scope.regs[key] = regs[key].toString(16)
      })

      // format the flags as bits
      let flags = (regs.af & 0x00ff).toString(2)
      flags = ('0'.repeat(8 - flags.length)) + flags
      $scope.regs.flags = flags
    }

    /**
     * assemble the source code, returning a Uint8Array memory block.
     * if an error occurs, return false a fill the messges buffer with a message.
     *
     * @param string  source  The source code to assemble
     * @return Uint8Array|false
     */
    $scope.doCompile = (source) => {
      let [error, build, symbols] = ASM.compile(source, Monolith.Z80)
      $scope.pcToLineMap = $scope.translateParserDataIntoLineMap(build[0])
      if (error === null)
        return $scope.createContiguousMemoryBlock(ASM.hex(build[0]))

      // an error during compilation
      $scope.outputMessages += `Build failed\n${error.msg} (at line ${error.s.numline}, '${error.s.line}')\n`
      console.log(error)
      return false
    }

    /**
     * take asm80's build parser data and create an array matching addresses to line numbers.
     *
     * @param array parserData  asm80's build data from ASM.compile(data)[1][0]
     * @return array
     */
    $scope.translateParserDataIntoLineMap = (parserData) => {
      let lineMap = []
      parserData.forEach((parsedItem) => {
        if (parsedItem.bytes === 0)
          return

        lineMap[parsedItem.addr] = parsedItem.numline
      })
      return lineMap
    }

    /**
     * create a contiguous memory block, 64KB in size, for the cpu to run.
     * accepts an intel hex format file as input.
     *
     * @param string  intelHex  Intel hex format assembled code
     * @return Uint8Array
     */
    $scope.createContiguousMemoryBlock = (intelHex) => {
      const compiledBinary = MemoryMap.fromHex(intelHex)
      return compiledBinary.slicePad(0, Math.pow(2, 16), 0)
    }

    /**
     * run the code by setting the running value so that the timer will renew
     * after opcode execution.
     *
     * @return undefined
     */
    $scope.run = () => {
      if ($scope.dirty)
        $scope.outputMessages += `WARNING: Buffer has changed since last assembly - consider stopping and reassembling\n`
      $scope.running = true
      $scope.step()
    }

    /**
     * stop execution; clear the timer and set the running flag to false
     *
     * @return undefined
     */
    $scope.stop = () => {
      $scope.running = false
      clearTimeout($scope.timer)
      $scope.timer = false
    }

    /**
     * an i/o handler for ProcessorZ80 - add some data to the <pre> buffer
     *
     * @param string  mode  'r' or 'w' for read or write, respectively
     * @param string  data  Data to put in the buffer
     * @return undefined
     */
    $scope.cpuPreArea = (mode, data) => {
      if (mode === 'r')
        return 0x00

      $scope.cpuOutput += String.fromCharCode(data)
    }

    /**
     * assemble the source code from the editor and bootstrap the simulated cpu
     *
     * @return undefined
     */
    $scope.assemble = () => {
      let code = $scope.codeMirror.getValue()
      let binary = $scope.doCompile(code)
      if (binary !== false) {
        // setup the cpu with the built program
        $scope.cpu = new ProcessorZ80(binary)
        $scope.updateRegisters($scope.cpu.getRegisters())
        $scope.cpu.addIoHandler(10, $scope.cpuPreArea)

        $scope.outputMessages = 'Build succeeded\n'
        $scope.cpuOutput = ''
        $scope.dirty = false
      }
    }

    /**
     * single step an instruction from memory; runs the fetch-execute cycle
     *
     * @return undefined
     */
    $scope.step = () => {
      const update = () => {
        if ($scope.regs.pc === '--') {
          $scope.outputMessages += 'Cannot step through program until it has been built: Please click "Assemble"\n'
          return
        }

        // highlight the current line in the code from the program counter
        if ($scope.lastLine !== null)
          $scope.codeMirror.removeLineClass($scope.lastLine - 1, 'background', 'line-pc')

        $scope.lastLine = $scope.pcToLineMap[$scope.cpu.getRegisters().pc] ?? null // because self-modifying code can happen
        if ($scope.lastLine !== null) {
          $scope.codeMirror.scrollIntoView({line: $scope.lastLine}, 40)
          $scope.codeMirror.addLineClass($scope.lastLine - 1, 'background', 'line-pc')
        }

        try {
          $scope.cpu.fetch()
          $scope.cpu.execute()
        } catch (e) {
          $scope.outputMessages += `${e}\n`
          $scope.running = false
        }

        const regs = $scope.cpu.getRegisters()
        $scope.updateRegisters(regs)

        if ($scope.running)
          $scope.timer = setTimeout($scope.step, 400)
      }

      // handle ui-interactive updates
      if (!$scope.$$phase)
        return $scope.$apply(update)
      update()
    }
  }])
})
