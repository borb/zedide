/**
 * api for the loading/saving of code.
 *
 * rob andrews <rob@aphlor.org>
 */

'use strict'

import mongoose from 'mongoose'

const index = (req, res) => {
  // get a list of the files we can load (don't pull code, it's a waste to get that yet)
  const codeModel = mongoose.model('code')
  codeModel
    .find({userOwner: res.locals.user.user})
    .select('-code')
    .exec((error, results) => {
      if (error) {
        // there was an error; pass that back
        return res.status(500).json({success: false})
      }

      // success or empty file list: pass back to the caller
      return res.json({
        success: true,
        fileList: results.map((file) => file.name)
      })
    })
}

const getFile = (req, res) => {
  // get a file from the database
  const codeModel = mongoose.model('code')
  codeModel.findOne(
    {
      name: req.body.fileName,
      userOwner: res.locals.user.user
    },
    (error, result) => {
      if (error)
        return res.status(500).json({success: false})

      return res.json({success: true, code: result.code})
    }
  )
}

const saveFile = (req, res) => {
  const codeModel = mongoose.model('code')

  const save = async () => {
    let existing = await codeModel
      .findOne({userOwner: res.locals.user.user, name: req.body.fileName})
      .exec()

    if (existing) {
      // file already exists: update it
      existing.code = req.body.code
      existing.updated = Date.now()

      try {
        await existing.save()
      } catch (e) {
        return res.status(500).json({success: false})
      }

      return res.json({success: true})
    }

    // save a new file
    let newFile = new (mongoose.model('code'))()
    newFile.name = req.body.fileName
    newFile.code = req.body.code
    newFile.userOwner = res.locals.user.user

    try {
      await newFile.save()
    } catch (e) {
      return res.status(500).json({success: false})
    }

    return res.json({success: true})
  }

  save()
}

export default {
  'index': index,
  'getFile': getFile,
  'saveFile': saveFile
}
