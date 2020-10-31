/**
 * maps url paths to controllers
 *
 * rob andrews <rob@aphlor.org>
 */

import express from 'express'

import indexpagecontroller from './controllers/indexpagecontroller.js'

const router = express.Router()

// index page
router.get('/', indexpagecontroller)

export default router
