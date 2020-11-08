/**
 * setup connection to mongodb.
 * please update line 10 if your connection details vary.
 * **DO NOT LEAVE AN UNAUTHENTICATED MONGODB PUBLICLY ACCESSIBLE**
 *
 * rob andrews <rob@aphlor.org>
 */

import mongoose from 'mongoose'

// setup mongoose with our dsn
const dsn = (typeof(process.env.MONGODB_URI) !== 'undefined')
  ? process.env.MONGODB_URI
  : 'mongodb://localhost/zedide'

mongoose.connect(dsn, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})

// these three sections setup mongoose with message to log on connect/disconnect/error events
mongoose.connection.on('connected', () => {
  console.log(`connected to mongodb server [${dsn}]`)
})

mongoose.connection.on('error', (error) => {
  console.error(`connection to mongodb server [${dsn}] failed: ${error}`)
})

mongoose.connection.on('disconnected', () => {
  console.log(`disconnected from mongodb server [${dsn}]`)
})

// when node receives a SIGINT, cleanly disconnect from mongodb
process.on('SIGINT', () => {
  mongoose.connection.close(() => {
    console.log(`process termination; disconnected from mongodb server [${dsn}]`)
    process.exit(0)
  })
})

// load models
import './models/users.js'
import './models/loginSessions.js'
