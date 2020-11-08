/**
 * schema for users collection.
 *
 * rob andrews <rob@aphlor.org>
 */

import mongoose from 'mongoose'

const usersSchema = new mongoose.Schema({
  email: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  password: {
    type: String,
    required: true
  },
  enabled: {
    type: Boolean,
    required: true
  },
  dateCreated: {
    type: Date,
    default: Date.now
  }
})

mongoose.model('users', usersSchema)
