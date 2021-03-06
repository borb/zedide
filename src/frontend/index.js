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
import 'codemirror/theme/dracula.css'
import ASM from '@justnine/asm80/asm.js'
import Monolith from '@justnine/asm80/monolith.js'
import hextools from '@justnine/asm80/hextools.js'
import angular from 'angular'
import 'angular-sanitize'
import MemoryMap from 'nrf-intel-hex'
import 'bootstrap'
import 'bootstrap/dist/css/bootstrap.css'
import '@forevolve/bootstrap-dark/dist/css/bootstrap-dark.css'
import $ from 'jquery'

import './hint/codemirror-z80.js'
import ProcessorZ80 from './cpu/z80.js'
import './style/zedide.css'

let app

// setup the angular application
document.addEventListener('DOMContentLoaded', () => {
  // bootstrap angularjs
  angular.element(() => {
    angular.bootstrap(document, ['zedide'])
  })

  app = angular.module('zedide', ['ngSanitize'])

  /**
   * angular variable filter which displays a hexadecimal number with specific 0-padding.
   *
   * @param string  input   Number to format
   * @param number  padding Expected number of characters
   * @return string
   */
  app.filter('hexify', [() => (input, padding) => {
    if (typeof input === 'undefined')
      return '-'.repeat(padding)

    const num = Number(input).toString(16)
    return '0'.repeat(padding - num.length) + num
  }])

  /**
   * display a series of octets as ascii, hiding non-printable characters.
   * this will output each character wrapped in <tt> tags.
   *
   * @param array charBytes Array of characters to display; typically this should be eight
   * @return string
   */
  app.filter('displayChars', ['$sce', ($sce) => (charBytes) => {
    let output = ''
    charBytes.forEach((charByte) => {
      if (charByte >= 32 && charByte <= 126) {
        output += `<tt class="printable-char">${String.fromCharCode(charByte)}</tt>`
        return
      }
      output += '<tt class="unprintable-char">.</tt>'
    })
    return $sce.trustAsHtml(output)
  }])

  /**
   * upper-case the first letter of a string passed to us
   *
   * @param string  input String to work on
   * @return string
   */
  app.filter('ucfirst', [() => (input) => {
    if (input.length > 1)
      return `${input[0].toUpperCase()}${input.slice(1)}`

    return input.toUpperCase()
  }])

  /**
   * application controller for the index page.
   */
  app.controller('ideController', ['$scope', '$http', ($scope, $http) => {
    // variable defaults
    $scope.outputMessages = 'Welcome!\n'
    $scope.cpuOutput = ''
    $scope.running = false
    $scope.timer = false
    $scope.dirty = true
    $scope.pcToLineMap = []
    $scope.lastLine = null

    $scope.cpu = undefined

    $scope.regs = {
      pc: undefined,
      sp: undefined,
      a: undefined,
      af: undefined,
      a2: undefined,
      af2: undefined,
      bc: undefined,
      bc2: undefined,
      de: undefined,
      de2: undefined,
      hl: undefined,
      hl2: undefined,
      ix: undefined,
      iy: undefined,
      i: undefined,
      r: undefined,
      im: undefined,
      flags: '--------'
    }
    $scope.interrupts = undefined

    // login details
    const emptyLoginModel = {user: '', password: ''}
    $scope.loginModel = angular.copy(emptyLoginModel)

    // authorised user
    $scope.authorisedUser = undefined

    // pertaining to load/save actions
    $scope.pickerMode = ''
    $scope.localFileName = $scope.remoteFileName = $scope.fileName = ''
    $scope.localFiles = []
    $scope.remoteFiles = []
    $scope.panelSide = 'local'

    // setup the in-page editor, and the dirty buffer marker
    const textArea = document.getElementById('code-editor')
    const codeMirror = CodeMirror(
      (e) => textArea.parentNode.replaceChild(e, textArea),
      {
        lineNumbers: true,
        styleActiveLine: true,
        styleActiveSelected: true,
        extraKeys: {
          'Ctrl-Space': 'autocomplete'
        },
        mode: 'z80',
        theme: 'dracula',
        value: textArea.value
      }
    )
    codeMirror.on('change', () => {
      $scope.dirty = true
    })

    // shortcuts to adjust page display; switchToLogout enables logout menu item and username display
    const switchToLogout = () => {
      $('#navbarLoginItem').addClass('menu-off')
      $('#navbarLogoutItem').removeClass('menu-off')
      $('#authuserDisplay').removeClass('menu-off')

      // enable remote save aspects
      $scope.remoteFiles = []
      $('#saveRemoteButton').prop('disabled', false)
      $('#remoteFileList').prop('disabled', false)
    }

    // ...and switchToLogin enables the login/signup menu, turns off logout and username display
    const switchToLogin = () => {
      $('#navbarLoginItem').removeClass('menu-off')
      $('#navbarLogoutItem').addClass('menu-off')
      $('#authuserDisplay').addClass('menu-off')

      // disable remote save aspects
      $('#saveRemoteButton').prop('disabled', true)
      $('#remoteFileList').prop('disabled', true)
    }

    // check if the user is authorised and adjust the login/logout/signup navbar items
    $http.get('/api/v1/auth/user')
      .then(
        (res) => {
          // might be authorised
          if (res.data.success) {
            $scope.authorisedUser = res.data.user
            return switchToLogout()
          }

          // if success was explicitly false or "falsey" then display login aspects
          switchToLogin()
        },
        () => {
          // probably not authorised; server returns non-200 codes; interpret all as "no auth"
          switchToLogin()
        }
      )

    // get the list of sample programs from the server
    $scope.samples = []
    $http.get('/api/v1/samples')
      .then(
        (res) => $scope.samples = res.data.data,
        () => {
          // error
          console.error('failed to read samples from server; check network request for more details')
        }
      )

    /**
     * load a sample from api and insert it into the buffer
     *
     * @return undefined
     */
    $scope.loadSample = (file) => {
      $http.post('/api/v1/samples/read', {file: file})
        .then(
          // success; load into the editor
          (res) => codeMirror.setValue(res.data.data),
          () => {
            // failure
            console.error(`failed to load sample '${file}' from server; check network request for more details`)
          }
        )
    }

    /**
     * Add output to the outputMessages area
     *
     * @param string  message Message to add to buffer
     * @return undefined
     */
    $scope.appendOutput = (message) => {
      $scope.outputMessages += `${message}\n`
      const om = document.getElementById('outputMessages')
      om.scrollTop = om.scrollHeight
    }

    /**
     * update the registers in $scope which are bound to the register display table in
     * the user interface.
     * mostly this reformats in hex and breaks the cpu flags out to binary.
     *
     * @param array regs  Array of registers from ProcessorZ80.getRegisters()
     * @return undefined
     */
    $scope.updateRegisters = (regs) => {
      // pull the left 8 bits of af into a
      $scope.regs.a = (regs.af >> 8) & 0xff
      $scope.regs.a2 = (regs.af2 >> 8) & 0xff

      $scope.regs = Object.assign($scope.regs, regs)

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
      if (error === null) {
        $scope.pcToLineMap = $scope.translateParserDataIntoLineMap(build[0])
        return $scope.createContiguousMemoryBlock(ASM.hex(build[0]))
      }

      // an error during compilation
      $scope.appendOutput(`Build failed\n${error.msg} (at line ${error.s.numline}, '${error.s.line}')`)
      console.error('Assembly failed', error)
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
      $scope.appendOutput(`WARNING: Buffer has changed since last assembly - consider stopping and reassembling`)
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
      let code = codeMirror.getValue()
      let binary = $scope.doCompile(code)
      if (binary !== false) {
        // setup the cpu with the built program
        $scope.cpu = new ProcessorZ80(binary)
        $scope.updateRegisters($scope.cpu.getRegisters())
        $scope.cpu.addIoHandler(10, $scope.cpuPreArea)

        $scope.appendOutput('Build succeeded')
        $scope.cpuOutput = ''
        $scope.dirty = false

        $scope.updateRamDisplay()

        if ($scope.lastLine !== null)
          codeMirror.removeLineClass($scope.lastLine - 1, 'background', 'line-pc')
      }
    }

    /**
     * retrieve cpu ram and format it as an object where each element is a memory base address
     * followed by an array of eight bytes from that location.
     *
     * @return undefined
     */
    $scope.updateRamDisplay = () => {
      const ram = $scope.cpu.getRam()
      $scope.ram = {}
      for (let ramPtr = 0; ramPtr < Math.pow(2, 16); ramPtr++) {
        let block = Math.floor(ramPtr / 8) * 8
        if (typeof $scope.ram[block] === 'undefined')
          $scope.ram[block] = []
        $scope.ram[block].push(ram[ramPtr])
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
          $scope.appendOutput('Cannot step through program until it has been built: Please click "Assemble"')
          return
        }

        // highlight the current line in the code from the program counter
        if ($scope.lastLine !== null)
          codeMirror.removeLineClass($scope.lastLine - 1, 'background', 'line-pc')

        $scope.lastLine = $scope.pcToLineMap[$scope.cpu.getRegisters().pc] ?? null // because self-modifying code can happen
        if ($scope.lastLine !== null) {
          codeMirror.scrollIntoView({line: $scope.lastLine}, 40)
          codeMirror.addLineClass($scope.lastLine - 1, 'background', 'line-pc')
        }

        try {
          $scope.cpu.fetch()
          $scope.cpu.execute()
        } catch (e) {
          $scope.appendOutput(e)
          $scope.running = false
        }

        // update ram display after execution
        $scope.updateRamDisplay()

        $scope.updateRegisters($scope.cpu.getRegisters())
        $scope.interrupts = $scope.cpu.getInterruptState()

        if ($scope.running)
          $scope.timer = setTimeout($scope.step, 400)
      }

      // handle ui-interactive updates
      if (!$scope.$$phase)
        return $scope.$apply(update)
      update()
    }

    /**
     * execute the api call which triggers account generation
     *
     * @return undefined
     */
    $scope.signup = () => {
      if ($scope.loginModel.user == '' || $scope.loginModel.password == '') {
        $('#signupFailureModal').modal('show')
        return
      }

      $http.post('/api/v1/auth/signup', {
        user: $scope.loginModel.user,
        password: $scope.loginModel.password
      }).then(
        (res) => {
          // post worked; api call may not have
          if (res.data.success == false) {
            $('#signupFailureModal').modal('show')
            return
          }

          $scope.authorisedUser = $scope.loginModel.user
          switchToLogout()
        },
        () => $('#signupFailureModal').modal('show')
      )
    }

    /**
     * execute the api call which logs a user into their account
     *
     * @return undefined
     */
    $scope.login = () => {
      if ($scope.loginModel.user == '' || $scope.loginModel.password == '') {
        $('#loginFailureModal').modal('show')
        return
      }

      $http.post('/api/v1/auth/login', {
        user: $scope.loginModel.user,
        password: $scope.loginModel.password
      }).then(
        (res) => {
          // post worked; api call may not have
          if (res.data.success == false) {
            $('#loginFailureModal').modal('show')
            return
          }

          $scope.authorisedUser = $scope.loginModel.user
          switchToLogout()
        },
        () => $('#loginFailureModal').modal('show')
      )
    }

    /**
     * execute the api call which logs a user out of their account
     *
     * @return undefined
     */
    $scope.logout = () => {
      $http.get('/api/v1/auth/logout').then(
        (res) => {
          // logout succeeded
          switchToLogin()
          $scope.authorisedUser = undefined
        },
        () => $('#logoutFailureModal').modal('show')
      )
    }

    /**
     * clear the picked files from the selection modal dialog
     */
    const clearFilePickerSelection = () => {
      $('#remoteFileList > option').prop('selected', false)
      $('#localFileList > option').prop('selected', false)
    }

    /**
     * repopulate the array containing files stored in browser local storage
     */
    const refreshLocalFiles = () => {
      $scope.localFiles = localStorage.getItem('zedideFiles') === null
          ? []
          : JSON.parse(localStorage.getItem('zedideFiles'))

      $scope.localFiles.forEach(
        (e, i) => $scope.localFiles[i] = $scope.localFiles[i].replace(/^zedide-/, '')
      )
    }

    /**
     * repopulate the array containing files stored in server-side storage
     */
    const refreshRemoteFiles = () => {
      // check if we're logged in before trying this
      if (typeof $scope.authorisedUser === 'undefined' || $scope.authorisedUser == '')
        return

      $http.get('/api/v1/code').then(
        (res) => {
          if (res.data.success)
            $scope.remoteFiles = res.data.fileList
        },
        () => {
          // there was an error behind the scenes
          console.error('failed to fetch remote file list; check network panel')
        }
      )
    }

    /**
     * open the modal for saving a file
     *
     * @return undefined
     */
    $scope.save = () => {
      refreshLocalFiles()
      refreshRemoteFiles()

      $('#loadButtons').addClass('file-buttons-hidden')
      $('#saveButtons').removeClass('file-buttons-hidden')
      $('#loadSaveModal').modal('show')
      $scope.pickerMode = 'save'
      clearFilePickerSelection()
    }

    /**
     * open the modal for loading a file
     *
     * @return undefined
     */
    $scope.load = () => {
      refreshLocalFiles()
      refreshRemoteFiles()

      $('#loadButtons').removeClass('file-buttons-hidden')
      $('#saveButtons').addClass('file-buttons-hidden')
      $('#loadSaveModal').modal('show')
      $scope.pickerMode = 'load'
      clearFilePickerSelection()
    }

    /**
     * this function is bound to the action where a user selects a file in the load/save modal
     *
     * @return undefined
     */
    $scope.pickFilename = (panel) => {
      $scope.fileName = panel == 'remote'
        ? $scope.remoteFileName
        : $scope.localFileName
      $scope.panelSide = panel
      clearFilePickerSelection()
    }

    /**
     * save a file to local storage
     *
     * @return undefined
     */
    $scope.saveLocalFile = () => {
      if ($scope.fileName === '') {
        // don't save; filename is empty
        return
      }

      let files = localStorage.getItem('zedideFiles') === null
        ? []
        : JSON.parse(localStorage.getItem('zedideFiles'))

      if (!files.includes(`zedide-${$scope.fileName}`)) {
        files.push(`zedide-${$scope.fileName}`)
        localStorage.setItem('zedideFiles', JSON.stringify(files))
      }

      localStorage.setItem(`zedide-${$scope.fileName}`, codeMirror.getValue())
      $('#loadSaveModal').modal('hide')

      // @todo flash message?
    }

    /**
     * call the api service to save a file to the user's remote storage
     *
     * @return undefined
     */
    $scope.saveRemoteFile = () => {
      if ($scope.fileName === '') {
        // don't save; filename is empty
        return
      }

      $http.post('/api/v1/code/save', {fileName: $scope.fileName, code: codeMirror.getValue()}).then(
        (res) => {
          // save succeeded
          if (res.data.success)
            $('#loadSaveModal').modal('hide')
        },
        () => {
          console.error('api save call failed: check network request for more information')
        }
      )
    }

    /**
     * load a file from local storage or via the server api
     *
     * @return undefined
     */
    $scope.loadFile = () => {
      if ($scope.fileName === '') {
        // filename empty; don't do anything
        return
      }

      switch ($scope.panelSide) {
        case 'local':
          refreshLocalFiles()
          if ($scope.localFiles.includes($scope.fileName)) {
            codeMirror.setValue(localStorage.getItem(`zedide-${$scope.fileName}`))
            $('#loadSaveModal').modal('hide')
            break
          }
          console.info(`weird - tried to load a non-existent local file: 'zedide-${$scope.fileName}'`)
          break

        case 'remote':
          $http.post('/api/v1/code/load', {fileName: $scope.fileName}).then(
            (res) => {
              // we have the file
              if (res.data.success) {
                $('#loadSaveModal').modal('hide')
                return codeMirror.setValue(res.data.code)
              }
              console.error('strange: successful api call response (200) but success flag not set; check network request')
            },
            () => {
              // we have an error
              console.error('failed to load file: check network request')
            }
          )
          break
      }
    }
  }])
})
