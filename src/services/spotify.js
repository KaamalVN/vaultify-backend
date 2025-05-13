const axios = require('axios')
const config = require('../config')

async function getSpotifyToken() {
  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', 
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(config.spotify.clientId + ':' + config.spotify.clientSecret).toString('base64')
        }
      }
    )
    return response.data.access_token
  } catch (error) {
    console.error("Error getting Spotify token:", error.message)
    return null
  }
}

async function searchSpotify(query) {
  try {
    const token = await getSpotifyToken()
    if (!token) {
      console.error("Failed to get Spotify token")
      return null
    }

    const response = await axios.get(`${config.spotify.apiUrl}/search`, {
      params: {
        q: query,
        type: "track",
        limit: 5
      },
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })
    
    return response.data
  } catch (error) {
    console.error("Spotify search error:", error.message)
    if (error.response) {
      console.error("Error response:", error.response.data)
    }
    return null
  }
}

module.exports = {
  getSpotifyToken,
  searchSpotify
} 