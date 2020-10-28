#!/usr/bin/env node
'use strict'

import fs from 'fs'

/**
 * inject a file into another file between two markers
 */
const [destination, injectFile, startmark, endmark] = [process.argv[2], process.argv[3], process.argv[4], process.argv[5]]

// read destination
let input
try {
  input = fs.readFileSync(destination).toString()
} catch (e) {
  console.error(`Failed to read destination file: ${e}`)
  process.exit(1)
}

// read injection
let injection
try {
  injection = fs.readFileSync(injectFile).toString()
} catch (e) {
  console.error(`Failed to read injection file: ${e}`)
  process.exit(1)
}

// perform substitution
let [start, end] = [input.indexOf(startmark), input.indexOf(endmark)]
let final = `${input.substring(0, start)}${startmark}\n${injection}${endmark}${input.substring(end + endmark.length)}`

// write file out
try {
  fs.writeFileSync(destination, final)
} catch (e) {
  console.error(`Failed to write desination file: ${e}`)
  process.exit(1)
}
