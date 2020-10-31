/**
 * maps url paths to controllers
 */

import express from 'express'

import indexpagecontroller from './controllers/indexpagecontroller.js'

const router = express.Router()

// index page
router.get('/', indexpagecontroller)

export default router
