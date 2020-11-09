/**
 * api for authentication
 *
 * rob andrews <rob@aphlor.org>
 */

'use strict'

import mongoose from 'mongoose'
import bcrypt from 'bcrypt'
import { v4 as uuidv4 } from 'uuid'

const signup = (req, res, next) => {
  // body validation
  if (typeof req.body.user === 'undefined' || req.body.user == '' ||
      typeof req.body.password === 'undefined' || req.body.password == ''
  ) {
    res.status(400).json({success: false})
    return
  }

  const users = mongoose.model('users')

  users.findOne({user: req.body.user}, (error, user) => {
    if (error || user) {
      // user already exists or an error occurred
      res.status(400).json({success: false})
      return
    }

    let newUser = new (mongoose.model('users'))()
    newUser.user = req.body.user
    newUser.password = bcrypt.hashSync(req.body.password, 10)
    newUser.enabled = true
    newUser.save((error) => {
      if (error) {
        console.error(`error whilst creating user '${req.body.user}'`)
        res.status(500).json({success: false})
        return
      }

      // success; run next aspect in middleware chain
      console.log(`created account for user '${req.body.user}': handing off to next middleware item`)
      next()
    })
  })
}

const login = (req, res) => {
  // log the user in
  const users = mongoose.model('users')

  // get user data
  users.findOne({user: req.body.user}, async (error, user) => {
    if (error || !user) {
      // error or user not found
      console.info(`user '${req.body.user}' tried to login but we couldn't find their user document`)
      res.status(400).json({success: false})
      return
    }

    // check password
    if (!bcrypt.compareSync(req.body.password, user.password)) {
      // password mismatch; fail
      console.info(`user '${req.body.user}' tried to login but their password didn't match the bcrypt hash`)
      res.status(400).json({success: false})
      return
    }

    // create a login session, set the cookie, return successfully
    let session = new (mongoose.model('loginSessions'))()
    session.sessionId = uuidv4()
    session.user = req.body.user
    let result = await session.save()
    res
      .cookie('loginSession', session.sessionId)
      .json({success: true})
  })
}

const isAuthenticated = (req, res, next) => {
  // check to see if the user is logged in

  // we're going to use this in multiple places, never consecutively, so define here
  const failedAuthAction = () => res
    .status(403)
    .clearCookie('loginSession')
    .json({success: false})

  if (!req.cookies.loginSession)
    return failedAuthAction()

  const sessions = mongoose.model('loginSessions')
  sessions.findOne({sessionId: req.cookies.loginSession}, async (error, loginSession) => {
    if (error || !loginSession)
      return failedAuthAction()

    const users = mongoose.model('users')
    let user = await users.findOne({user: loginSession.user, enabled: true})
    if (user.user) {
      res.locals.user = user
      loginSession.lastActivityTime = Date.now()
      await loginSession.save()
      return next()
    }

    return failedAuthAction()
  })
}

const getAuthorisedUser = (req, res) => {
  res.json({
    success: true,
    user: res.locals.user.user
  })
}

export default {
  'signup': signup,
  'login': login,
  'isAuthenticated': isAuthenticated,
  'getAuthorisedUser': getAuthorisedUser
}
