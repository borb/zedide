/**
 * maps url paths to controllers
 *
 * rob andrews <rob@aphlor.org>
 */

import express from 'express'

import indexpagecontroller from './controllers/indexpagecontroller.js'
import samplefileapicontroller from './controllers/samplefileapicontroller.js'

const router = express.Router()

// index page
router.get('/', indexpagecontroller)

// api routes
const apiRouter = express.Router()
apiRouter
  .get('/samples', samplefileapicontroller.index)
  .post('/samples/read', samplefileapicontroller.read)

router.use('/api/v1', apiRouter)

export default router
