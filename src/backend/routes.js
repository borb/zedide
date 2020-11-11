/**
 * maps url paths to controllers
 *
 * rob andrews <rob@aphlor.org>
 */

import express from 'express'

import authapicontroller from './controllers/authapicontroller.js'
import samplefileapicontroller from './controllers/samplefileapicontroller.js'
import codeapicontroller from './controllers/codeapicontroller.js'

const router = express.Router()

// api routes
const apiRouter = express.Router()
apiRouter
  // sample files
  .get('/samples', samplefileapicontroller.index)
  .post('/samples/read', samplefileapicontroller.read)
  // authorisation & authentication
  .post('/auth/signup', authapicontroller.signup, authapicontroller.login)
  .post('/auth/login', authapicontroller.login)
  .get('/auth/user', authapicontroller.isAuthenticated, authapicontroller.getAuthorisedUser)
  .get('/auth/logout', authapicontroller.isAuthenticated, authapicontroller.logout)
  // loading/saving code
  .get('/code', authapicontroller.isAuthenticated, codeapicontroller.index)
  .post('/code/load', authapicontroller.isAuthenticated, codeapicontroller.getFile)
  .post('/code/save', authapicontroller.isAuthenticated, codeapicontroller.saveFile)

router.use('/api/v1', apiRouter)

export default router
