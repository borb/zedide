/**
 * api for the sample programs.
 *
 * rob andrews <rob@aphlor.org>
 */

'use strict'

import fs from 'fs'
import util from 'util'

const pReadFile = util.promisify(fs.readFile)

const sampleIndex = (req, res) => {
  fs.opendir('./examples', async (error, dir) => {
    if (error) {
      return res.status(500).json({success: false, error: 'Internal error'})
    }

    let entries = []
    for await (const dirent of dir) {
      if (dirent.isFile() && dirent.name.match(/\.json$/)) {
        // found a file called ".json" in the directory; read it, then the accompanying .z80 file
        const data = await pReadFile(`${dir.path}/${dirent.name}`)
        const fileMetadata = JSON.parse(data)
        const fileName = dirent.name.replace(/\.json$/, '.z80')
        entries.push({
          file: fileName,
          meta: fileMetadata
        })
      }
    }

    res.json({success: true, data: entries})
  })
}

const readSample = (req, res) => {
  if (typeof req.body.file === 'undefined' || req.body.file.match(/(\.\.|\/|\\)/)) {
    // attempt to break out of examples directory; reject
    return res.status(400).json({success: false, error: 'Naughty'})
  }

  fs.access(`./examples/${req.body.file}`, fs.constants.R_OK, async (error) => {
    if (error) {
      return res.status(404).json({success: false, error: 'Sample code not found'})
    }

    const data = await pReadFile(`./examples/${req.body.file}`)
    res.json({success: true, data: data.toString(), file: req.body.file})
  })
}

export default {
  'index': sampleIndex,
  'read': readSample
}
