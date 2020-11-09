/**
 * maps url paths to controllers
 *
 * rob andrews <rob@aphlor.org>
 */

import express from 'express'

import authapicontroller from './controllers/authapicontroller.js'
import samplefileapicontroller from './controllers/samplefileapicontroller.js'

const router = express.Router()

// api routes
const apiRouter = express.Router()
apiRouter
  .get('/samples', samplefileapicontroller.index)
  .post('/samples/read', samplefileapicontroller.read)
  .post('/auth/signup', authapicontroller.signup, authapicontroller.login)
  .post('/auth/login', authapicontroller.login)
  .get('/auth/user', authapicontroller.isAuthenticated, authapicontroller.getAuthorisedUser)
  .get('/auth/logout', authapicontroller.isAuthenticated, authapicontroller.logout)

router.use('/api/v1', apiRouter)

export default router
