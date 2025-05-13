const express = require('express')
const cors = require('cors')
const audioRoutes = require('./routes/audio')

const app = express()

// Enable CORS for all origins
app.use(cors())
app.use(express.json())

// Routes
app.use('/api', audioRoutes)

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Vaultify backend is running on Vercel!')
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something broke!' })
})

module.exports = app 