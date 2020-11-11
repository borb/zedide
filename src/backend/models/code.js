/**
 * schema for code collection.
 *
 * rob andrews <rob@aphlor.org>
 */

import mongoose from 'mongoose'

const codeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  code: {
    type: String,
    required: true
  },
  userOwner: {
    type: String,
    required: true
  },
  created: {
    type: Date,
    default: Date.now,
    required: true
  },
  updated: {
    type: Date,
    default: Date.now
  }
}, {collection: 'code'})

mongoose.model('code', codeSchema)
