/**
 * schema for loginSessions collection.
 * loginSessions are created after a 'users' document has logged in.
 *
 * rob andrews <rob@aphlor.org>
 */

import mongoose from 'mongoose'

const loginSessionsSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  email: {
    type: String,
    required: true
  },
  loginTime: {
    type: Date,
    default: Date.now
  },
  lastActivityTime: {
    type: Date,
    default: Date.now
  }
}, {collection: 'loginSessions'})

mongoose.model('loginSessions', loginSessionsSchema)
