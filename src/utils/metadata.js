const mm = require("music-metadata")
const config = require('../config')

async function fetchEnhancedMetadata(fileName, filePath) {
  try {
    // First try to get metadata from the file itself
    const parsedMetadata = await mm.parseFile(filePath)
    let metadata = {
      title: parsedMetadata.common.title || "",
      artist: parsedMetadata.common.artist || "",
      album: parsedMetadata.common.album || "",
      genre: parsedMetadata.common.genre ? parsedMetadata.common.genre[0] : "",
      coverUrl: "",
    }

    // If we don't have good metadata, try to extract from filename
    if (!metadata.title || !metadata.artist) {
      const baseName = fileName.split(".").slice(0, -1).join(".")
      
      // Tamil song patterns
      const patterns = [
        /^(.*?)\s*-\s*(.*?)\s*\((.*?)\)$/i,  // Artist - Title (Movie)
        /^(.*?)\s*\((.*?)\)\s*-\s*(.*?)$/i,  // Title (Movie) - Artist
        /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i,  // Movie - Title - Artist
        /^(.*?)\s*-\s*(.*?)\s*\((.*?)\)$/i,  // Title - Artist (Movie)
        /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i,  // Movie - Artist - Title
        /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i   // Artist - Movie - Title
      ]

      for (const pattern of patterns) {
        const match = baseName.match(pattern)
        if (match) {
          metadata.artist = match[1].trim()
          metadata.title = match[2].trim()
          metadata.album = match[3].trim()
          break
        }
      }
    }

    return metadata
  } catch (error) {
    console.error("Error fetching metadata:", error)
    return {
      title: "",
      artist: "",
      album: "",
      genre: "",
      coverUrl: ""
    }
  }
}

function cleanSearchTerm(term) {
  return term
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim()
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function calculateConfidence(result, existingMetadata, filenameMetadata, initialMetadata) {
  let confidence = 0
  const weights = {
    title: 0.4,
    artist: 0.4,
    album: 0.2
  }

  // Compare with Spotify result
  if (result) {
    if (result.name.toLowerCase() === existingMetadata.title.toLowerCase()) confidence += weights.title
    if (result.artists.some(a => a.name.toLowerCase() === existingMetadata.artist.toLowerCase())) confidence += weights.artist
    if (result.album && result.album.name.toLowerCase() === existingMetadata.album.toLowerCase()) confidence += weights.album
  }

  // Compare with filename metadata
  if (filenameMetadata.title && filenameMetadata.title.toLowerCase() === existingMetadata.title.toLowerCase()) confidence += weights.title
  if (filenameMetadata.artist && filenameMetadata.artist.toLowerCase() === existingMetadata.artist.toLowerCase()) confidence += weights.artist
  if (filenameMetadata.album && filenameMetadata.album.toLowerCase() === existingMetadata.album.toLowerCase()) confidence += weights.album

  // Compare with initial metadata
  if (initialMetadata.title && initialMetadata.title.toLowerCase() === existingMetadata.title.toLowerCase()) confidence += weights.title
  if (initialMetadata.artist && initialMetadata.artist.toLowerCase() === existingMetadata.artist.toLowerCase()) confidence += weights.artist
  if (initialMetadata.album && initialMetadata.album.toLowerCase() === existingMetadata.album.toLowerCase()) confidence += weights.album

  return confidence
}

module.exports = {
  fetchEnhancedMetadata,
  cleanSearchTerm,
  decodeHtmlEntities,
  calculateConfidence
} 