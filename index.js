const express = require("express")
const cors = require("cors")
const multer = require("multer")
const fs = require("fs")
const path = require("path")
const axios = require("axios")
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3")
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner")
const extract = require("extract-zip")
const AdmZip = require("adm-zip")
const { createReadStream } = require("fs")
const { pipeline } = require("stream/promises")
const os = require("os")
const crypto = require("crypto")
const mm = require("music-metadata")
require('dotenv').config()

// Add middleware to remove problematic headers
const removeChecksumHeader = (next) => async (args) => {
  if (args.request && args.request.headers) {
    delete args.request.headers['x-amz-checksum-mode']
    delete args.request.headers['x-amz-checksum-algorithm']
  }
  return next(args)
}

const app = express()
const upload = multer({ dest: os.tmpdir() })

// Enable CORS for all origins
app.use(cors())
app.use(express.json())

// Initialize the S3 client for Backblaze B2
const client = new S3Client({
  region: process.env.B2_REGION,
  endpoint: process.env.B2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.B2_ACCESS_KEY_ID,
    secretAccessKey: process.env.B2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
  disableHostPrefix: true,
  disableChecksum: true,
})

const BUCKET_NAME = process.env.B2_BUCKET_NAME
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"]
const ARCHIVE_EXTENSIONS = [".zip", ".rar", ".7z"]

// API configurations
const SPOTIFY_API_URL = "https://api.spotify.com/v1"
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET

// Helper function to get Spotify access token
async function getSpotifyToken() {
  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', 
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
        }
      }
    )
    return response.data.access_token
  } catch (error) {
    console.error("Error getting Spotify token:", error.message)
    return null
  }
}

// Helper function to search Spotify
async function searchSpotify(query) {
  try {
    const token = await getSpotifyToken()
    if (!token) {
      console.error("Failed to get Spotify token")
      return null
    }

    const response = await axios.get(`${SPOTIFY_API_URL}/search`, {
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

app.get('/', (req, res) => {
  res.send('Vaultify backend is running on Vercel!');
});

// Endpoint to get signed URLs for all files in the bucket
app.get("/audio-urls", async (req, res) => {
  try {
    // List all files in the bucket
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
    })

    const listData = await client.send(listCommand)
    const files = listData.Contents || []

    // Get all metadata
    let allMetadata = {}
    try {
      const getCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: "metadata/all.json",
      })
      const response = await client.send(getCommand)
      const metadataString = await streamToString(response.Body)
      allMetadata = JSON.parse(metadataString)
      console.log("Initial data fetch - Total songs:", Object.keys(allMetadata.songs || {}).length)
      console.log("Initial data fetch - Total playlists:", Object.keys(allMetadata.playlists || {}).length)
    } catch (error) {
      // If file doesn't exist, start with empty object
      allMetadata = { songs: {}, playlists: {} }
      console.log("Initial data fetch - No existing metadata, starting fresh")
    }

    // Generate signed URLs for each file
    const signedUrls = await Promise.all(
      files.map(async (file) => {
        // Skip metadata files
        if (file.Key.startsWith("metadata/")) {
          return null
        }

        const getObjectCommand = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: file.Key,
        })

        const signedUrl = await getSignedUrl(client, getObjectCommand, { expiresIn: 3600 }) // Expires in 1 hour

        // Get metadata from the all.json file
        const metadata = allMetadata.songs[file.Key] || {}

        return {
          fileName: file.Key,
          signedUrl: signedUrl,
          ...metadata,
        }
      }),
    )

    // Filter out null values (metadata files) and return the signed URLs
    res.json(signedUrls.filter(Boolean))
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to generate signed URLs" })
  }
})

// Helper function to convert stream to string
const streamToString = (stream) => {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on("data", (chunk) => chunks.push(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
  })
}

// Enhanced metadata fetching function
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
      // Pattern 1: Artist - Title (Movie)
      const tamilPattern1 = /^(.*?)\s*-\s*(.*?)\s*\((.*?)\)$/i
      // Pattern 2: Title (Movie) - Artist
      const tamilPattern2 = /^(.*?)\s*\((.*?)\)\s*-\s*(.*?)$/i
      // Pattern 3: Movie - Title - Artist
      const tamilPattern3 = /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i
      // Pattern 4: Title - Artist (Movie)
      const tamilPattern4 = /^(.*?)\s*-\s*(.*?)\s*\((.*?)\)$/i
      // Pattern 5: Movie - Artist - Title
      const tamilPattern5 = /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i
      // Pattern 6: Artist - Movie - Title
      const tamilPattern6 = /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i

      const match1 = baseName.match(tamilPattern1)
      const match2 = baseName.match(tamilPattern2)
      const match3 = baseName.match(tamilPattern3)
      const match4 = baseName.match(tamilPattern4)
      const match5 = baseName.match(tamilPattern5)
      const match6 = baseName.match(tamilPattern6)

      if (match1) {
        metadata.artist = match1[1].trim()
        metadata.title = match1[2].trim()
        metadata.album = match1[3].trim()
      } else if (match2) {
        metadata.title = match2[1].trim()
        metadata.album = match2[2].trim()
        metadata.artist = match2[3].trim()
      } else if (match3) {
        if (match3[1].length > match3[2].length) {
          metadata.album = match3[1].trim()
          metadata.title = match3[2].trim()
          metadata.artist = match3[3].trim()
        } else {
          metadata.title = match3[1].trim()
          metadata.artist = match3[2].trim()
          metadata.album = match3[3].trim()
        }
      } else if (match4) {
        metadata.title = match4[1].trim()
        metadata.artist = match4[2].trim()
        metadata.album = match4[3].trim()
      } else if (match5) {
        metadata.album = match5[1].trim()
        metadata.artist = match5[2].trim()
        metadata.title = match5[3].trim()
      } else if (match6) {
        metadata.artist = match6[1].trim()
        metadata.album = match6[2].trim()
        metadata.title = match6[3].trim()
      } else {
        // Try to detect if it's a Tamil song by common words
        const tamilKeywords = ['tamil', 'tamizh', 'tamil song', 'tamizh song', 'tamil movie', 'tamizh movie']
        const isTamilSong = tamilKeywords.some(keyword => baseName.toLowerCase().includes(keyword))
        
        if (isTamilSong) {
          // For Tamil songs without clear pattern, try to extract movie name from parentheses
          const movieMatch = baseName.match(/\((.*?)\)/)
          if (movieMatch) {
            metadata.album = movieMatch[1].trim()
            metadata.title = baseName.replace(/\(.*?\)/, '').trim()
            metadata.artist = "Unknown Artist"
          } else {
            metadata.title = baseName
            metadata.artist = "Unknown Artist"
            metadata.album = "Unknown Album"
          }
        } else {
          // Fallback to original filename parsing
          const dashSplit = baseName.split(" - ")
          if (dashSplit.length > 1) {
            metadata.artist = dashSplit[0].trim()
            metadata.title = dashSplit.slice(1).join(" - ").trim()
          } else {
            metadata.title = baseName
          }
        }
      }
    }

    // Clean up common suffixes and Tamil-specific suffixes
    metadata.title = cleanTitle(metadata.title)
    metadata.artist = cleanTitle(metadata.artist)
    metadata.album = cleanTitle(metadata.album)

    // If we have title and artist, try to get more info from JioSaavn and Spotify
    if (metadata.title && metadata.artist) {
      // Search JioSaavn
      const jioSaavnResults = await searchJioSaavn(`${metadata.title} ${metadata.artist}`)
      
      if (jioSaavnResults?.data?.results?.[0]) {
        const song = jioSaavnResults.data.results[0]
        metadata.title = song.name || metadata.title
        metadata.artist = song.primaryArtists || metadata.artist
        metadata.album = song.album?.name || metadata.album
        metadata.genre = song.genre || metadata.genre
        
        // Get cover art
        if (song.image?.[2]?.link) {
          metadata.coverUrl = await getJioSaavnCoverArt(song.image[2].link)
        }
      } else {
        // Try Spotify
        const spotifyResults = await searchSpotify(`${metadata.title} ${metadata.artist}`)
        
        if (spotifyResults?.tracks?.items?.[0]) {
          const track = spotifyResults.tracks.items[0]
          metadata.title = track.name || metadata.title
          metadata.artist = track.artists.map(a => a.name).join(", ") || metadata.artist
          metadata.album = track.album?.name || metadata.album
          metadata.genre = track.album?.genres?.[0] || metadata.genre
          
          // Get cover art
          if (track.album?.images?.[0]?.url) {
            metadata.coverUrl = track.album.images[0].url
          }
        }
      }
    }

    // If we still don't have a cover image, generate one
    if (!metadata.coverUrl) {
      const searchQuery = [
        metadata.artist,
        metadata.title,
        metadata.album,
        "tamil movie",
        "album cover",
        "music"
      ]
        .filter(Boolean)
        .join(",")
      metadata.coverUrl = `https://source.unsplash.com/300x300/?${encodeURIComponent(searchQuery)}`
    }

    return metadata
  } catch (error) {
    console.error("Metadata fetch error:", error)
    return {
      title: fileName.split(".").slice(0, -1).join("."),
      artist: "Unknown Artist",
      album: "Unknown Album",
      genre: "Unknown Genre",
      coverUrl: "",
    }
  }
}

// Upload file endpoint
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" })
    }

    const file = req.file
    const fileExtension = path.extname(file.originalname).toLowerCase()

    // Check if it's an audio file or an archive
    if (AUDIO_EXTENSIONS.includes(fileExtension)) {
      // Get enhanced metadata
      const metadata = await fetchEnhancedMetadata(file.originalname, file.path)

      // Upload audio file directly
      const uploadResult = await uploadFileToB2(file.path, file.originalname)

      // Store metadata
        await storeMetadata(file.originalname, metadata)

      res.json({
        ...uploadResult,
        ...metadata,
      })
    } else if (ARCHIVE_EXTENSIONS.includes(fileExtension)) {
      // Extract and upload audio files from archive
      const extractDir = path.join(os.tmpdir(), crypto.randomBytes(16).toString("hex"))
      fs.mkdirSync(extractDir, { recursive: true })

      if (fileExtension === ".zip") {
        await extract(file.path, { dir: extractDir })
      } else {
        // For other archive types, use adm-zip
        const zip = new AdmZip(file.path)
        zip.extractAllTo(extractDir, true)
      }

      // Find all audio files in the extracted directory
      const audioFiles = findAudioFiles(extractDir)

      // Upload each audio file
      const uploadResults = []
      for (const audioFile of audioFiles) {
        const fileName = path.basename(audioFile)

        // Try to extract metadata from the audio file
        let metadata = {}
        try {
          const parsedMetadata = await mm.parseFile(audioFile)
          metadata = {
            title: parsedMetadata.common.title || fileName.split(".").slice(0, -1).join("."),
            artist: parsedMetadata.common.artist || "Unknown Artist",
            album: parsedMetadata.common.album || "Unknown Album",
            genre: parsedMetadata.common.genre ? parsedMetadata.common.genre[0] : "Unknown Genre",
            coverUrl: "",
          }
        } catch (err) {
          console.error("Error parsing metadata:", err)
        }

        const uploadResult = await uploadFileToB2(audioFile, fileName)

        // Store metadata if available
        if (Object.keys(metadata).length > 0) {
          await storeMetadata(fileName, metadata)
        }

        uploadResults.push({
          ...uploadResult,
          ...metadata,
        })
      }

      // Clean up
      fs.rmSync(extractDir, { recursive: true, force: true })

      res.json({ message: "Archive processed successfully", files: uploadResults })
    } else {
      res.status(400).json({ error: "Unsupported file type" })
    }
  } catch (error) {
    console.error("Upload error:", error)
    res.status(500).json({ error: "Upload failed" })
  } finally {
    // Clean up the temporary file
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error("Failed to delete temp file:", err)
      })
    }
  }
})

// Upload from URL endpoint
app.post("/upload-from-url", async (req, res) => {
  try {
    const { url } = req.body

    if (!url) {
      return res.status(400).json({ error: "No URL provided" })
    }

    // Get file name from URL
    const fileName = path.basename(url)
    const fileExtension = path.extname(fileName).toLowerCase()

    // Create temp file path
    const tempFilePath = path.join(os.tmpdir(), fileName)

    // Download the file
    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
    })

    await pipeline(response.data, fs.createWriteStream(tempFilePath))

    // Check if it's an audio file or an archive
    if (AUDIO_EXTENSIONS.includes(fileExtension)) {
      // Get enhanced metadata
      const metadata = await fetchEnhancedMetadata(fileName, tempFilePath)

      // Upload audio file directly
      const uploadResult = await uploadFileToB2(tempFilePath, fileName)

      // Store metadata
        await storeMetadata(fileName, metadata)

      res.json({
        ...uploadResult,
        ...metadata,
      })
    } else if (ARCHIVE_EXTENSIONS.includes(fileExtension)) {
      // Extract and upload audio files from archive
      const extractDir = path.join(os.tmpdir(), crypto.randomBytes(16).toString("hex"))
      fs.mkdirSync(extractDir, { recursive: true })

      if (fileExtension === ".zip") {
        await extract(tempFilePath, { dir: extractDir })
      } else {
        // For other archive types, use adm-zip
        const zip = new AdmZip(tempFilePath)
        zip.extractAllTo(extractDir, true)
      }

      // Find all audio files in the extracted directory
      const audioFiles = findAudioFiles(extractDir)

      // Upload each audio file
      const uploadResults = []
      for (const audioFile of audioFiles) {
        const audioFileName = path.basename(audioFile)

        // Try to extract metadata from the audio file
        let metadata = {}
        try {
          const parsedMetadata = await mm.parseFile(audioFile)
          metadata = {
            title: parsedMetadata.common.title || audioFileName.split(".").slice(0, -1).join("."),
            artist: parsedMetadata.common.artist || "Unknown Artist",
            album: parsedMetadata.common.album || "Unknown Album",
            genre: parsedMetadata.common.genre ? parsedMetadata.common.genre[0] : "Unknown Genre",
            coverUrl: "",
          }
        } catch (err) {
          console.error("Error parsing metadata:", err)
        }

        const uploadResult = await uploadFileToB2(audioFile, audioFileName)

        // Store metadata if available
        if (Object.keys(metadata).length > 0) {
          await storeMetadata(audioFileName, metadata)
        }

        uploadResults.push({
          ...uploadResult,
          ...metadata,
        })
      }

      // Clean up
      fs.rmSync(extractDir, { recursive: true, force: true })

      res.json({ message: "Archive processed successfully", files: uploadResults })
    } else {
      res.status(400).json({ error: "Unsupported file type" })
    }
  } catch (error) {
    console.error("Upload from URL error:", error)
    res.status(500).json({ error: "Upload from URL failed" })
  }
})

// Update metadata endpoint
app.post("/update-metadata", async (req, res) => {
  try {
    const songData = req.body

    if (!songData || !songData.fileName) {
      return res.status(400).json({ error: "Invalid song data" })
    }

    // Store metadata
    await storeMetadata(songData.fileName, {
      title: songData.title,
      artist: songData.artist,
      album: songData.album,
      genre: songData.genre,
      coverUrl: songData.coverUrl,
    })

    res.json({ message: "Metadata updated successfully" })
  } catch (error) {
    console.error("Metadata update error:", error)
    res.status(500).json({ error: "Failed to update metadata" })
  }
})

// Update playlist/album metadata endpoint
app.post("/update-playlist-metadata", async (req, res) => {
  try {
    const { id, name, coverUrl } = req.body

    if (!id) {
      return res.status(400).json({ error: "Invalid playlist/album data" })
    }

    // Store playlist/album metadata
    await storeMetadata(`playlists/${id}.json`, {
      id,
      name,
      coverUrl,
    })

    res.json({ message: "Playlist/Album metadata updated successfully" })
  } catch (error) {
    console.error("Playlist/Album metadata update error:", error)
    res.status(500).json({ error: "Failed to update playlist/album metadata" })
  }
})

// Get playlist metadata endpoint
app.get("/playlist-metadata/:id", async (req, res) => {
  try {
    const { id } = req.params

    if (!id) {
      return res.status(400).json({ error: "Invalid playlist ID" })
    }

    // Get playlist metadata from B2
    try {
      const metadataCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `metadata/playlists/${id}.json`,
      })

      const metadataResponse = await client.send(metadataCommand)
      const metadataStream = metadataResponse.Body
      const metadataString = await streamToString(metadataStream)
      const metadata = JSON.parse(metadataString)

      res.json(metadata)
    } catch (error) {
      // If metadata doesn't exist, return null
      res.json(null)
    }
  } catch (error) {
    console.error("Playlist metadata fetch error:", error)
    res.status(500).json({ error: "Failed to fetch playlist metadata" })
  }
})

// Upload playlist cover image endpoint
app.post("/upload-playlist-cover", upload.single("cover"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" })
    }

    const file = req.file
    const { playlistId } = req.body

    if (!playlistId) {
      return res.status(400).json({ error: "No playlist ID provided" })
    }

    // Upload cover image to B2
    const uploadResult = await uploadFileToB2(file.path, `covers/${playlistId}${path.extname(file.originalname)}`)

    // Update playlist metadata with the new cover URL
    await storeMetadata(`playlists/${playlistId}.json`, {
      id: playlistId,
      coverUrl: uploadResult.signedUrl,
    })

    res.json(uploadResult)
  } catch (error) {
    console.error("Playlist cover upload error:", error)
    res.status(500).json({ error: "Failed to upload playlist cover" })
  } finally {
    // Clean up the temporary file
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error("Failed to delete temp file:", err)
      })
    }
  }
})

// Helper function to store metadata in B2
async function storeMetadata(fileName, metadata) {
  try {
    // First, get the existing metadata file
    let allMetadata = { songs: {}, playlists: {} }
    try {
      const getCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: "metadata/all.json",
      })
      const response = await client.send(getCommand)
      const metadataString = await streamToString(response.Body)
      allMetadata = JSON.parse(metadataString)
    } catch (error) {
      // If file doesn't exist, start with empty object
    }

    // Update the metadata
    if (fileName.startsWith("playlists/")) {
      // For playlists, store in playlists object
      allMetadata.playlists = allMetadata.playlists || {}
      const playlistId = fileName.replace("playlists/", "").replace(".json", "")
      
      // If this is an update, preserve existing metadata
      if (allMetadata.playlists[playlistId]) {
        allMetadata.playlists[playlistId] = {
          ...allMetadata.playlists[playlistId],
          ...metadata
        }
      } else {
        allMetadata.playlists[playlistId] = metadata
      }
    } else {
      // For songs, store in songs object
      allMetadata.songs = allMetadata.songs || {}
      allMetadata.songs[fileName] = metadata
    }

    // Save the updated metadata
    const putCommand = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: "metadata/all.json",
      Body: JSON.stringify(allMetadata, null, 2), // Pretty print JSON
      ContentType: "application/json",
    })

    await client.send(putCommand)

    // Clean up individual metadata files if they exist
    try {
      const metadataKey = fileName.startsWith("playlists/") 
        ? `metadata/${fileName}`
        : `metadata/songs/${fileName}.json`

      const deleteCommand = new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: metadataKey,
      })

      await client.send(deleteCommand)
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
  } catch (error) {
    console.error("Error storing metadata:", error)
    throw error
  }
}

// Helper function to upload a file to B2
async function uploadFileToB2(filePath, fileName) {
  const fileContent = fs.readFileSync(filePath)

  const putCommand = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: fileContent,
    ContentType: getContentType(fileName),
  })

  await client.send(putCommand)

  // Generate a signed URL for the uploaded file
  const getObjectCommand = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
  })

  const signedUrl = await getSignedUrl(client, getObjectCommand, { expiresIn: 3600 })

  return {
    fileName,
    signedUrl,
  }
}

// Helper function to recursively find audio files in a directory
function findAudioFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir)

  files.forEach((file) => {
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)

    if (stat.isDirectory()) {
      findAudioFiles(filePath, fileList)
    } else {
      const ext = path.extname(file).toLowerCase()
      if (AUDIO_EXTENSIONS.includes(ext)) {
        fileList.push(filePath)
      }
    }
  })

  return fileList
}

// Helper function to get content type based on file extension
function getContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase()

  const contentTypes = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
  }

  return contentTypes[ext] || "application/octet-stream"
}

// Get all metadata endpoint
app.get("/all-metadata", async (req, res) => {
  try {
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: "metadata/all.json",
    })

    const response = await client.send(getCommand)
    const metadataString = await streamToString(response.Body)
    const metadata = JSON.parse(metadataString)

    res.json(metadata)
  } catch (error) {
    // If file doesn't exist, return empty metadata
    res.json({ songs: {}, playlists: {} })
  }
})

// Helper function to clean search terms
function cleanSearchTerm(term) {
  if (!term) return "";
  return term
    .replace(/\[.*?\]/g, "") // Remove anything in square brackets
    .replace(/\(.*?\)/g, "") // Remove anything in parentheses
    .replace(/[^\w\s]/g, " ") // Replace special characters with space
    .replace(/\s+/g, " ") // Replace multiple spaces with single space
    .trim();
}

// Helper function to decode HTML entities
function decodeHtmlEntities(text) {
  if (!text) return "";
  return text
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");
}

// Fetch metadata endpoint
app.post("/fetch-metadata", async (req, res) => {
  try {
    const { fileName, existingMetadata } = req.body

    if (!fileName) {
      return res.status(400).json({ error: "No filename provided" })
    }

    // Get the file from B2
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
    })

    // Create a temporary file
    const tempFilePath = path.join(os.tmpdir(), fileName)
    const response = await client.send(getCommand)
    await pipeline(response.Body, fs.createWriteStream(tempFilePath))

    // Get initial metadata from file
    const parsedMetadata = await mm.parseFile(tempFilePath)
    let initialMetadata = {
      title: parsedMetadata.common.title || "",
      artist: parsedMetadata.common.artist || "",
      album: parsedMetadata.common.album || "",
      genre: parsedMetadata.common.genre ? parsedMetadata.common.genre[0] : "",
      coverUrl: "",
    }

    // Extract metadata from filename
    const baseName = fileName.split(".").slice(0, -1).join(".")
    let filenameMetadata = {
      title: "",
      artist: "",
      album: "",
      genre: "",
      coverUrl: "",
    }

    // Try different filename patterns
    const patterns = [
      // Pattern 1: Artist - Title (Movie)
      { regex: /^(.*?)\s*-\s*(.*?)\s*\((.*?)\)$/i, extract: (match) => ({ artist: match[1], title: match[2], album: match[3] }) },
      // Pattern 2: Title (Movie) - Artist
      { regex: /^(.*?)\s*\((.*?)\)\s*-\s*(.*?)$/i, extract: (match) => ({ title: match[1], album: match[2], artist: match[3] }) },
      // Pattern 3: Movie - Title - Artist
      { regex: /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i, extract: (match) => ({ album: match[1], title: match[2], artist: match[3] }) },
      // Pattern 4: Title - Artist (Movie)
      { regex: /^(.*?)\s*-\s*(.*?)\s*\((.*?)\)$/i, extract: (match) => ({ title: match[1], artist: match[2], album: match[3] }) },
      // Pattern 5: Movie - Artist - Title
      { regex: /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i, extract: (match) => ({ album: match[1], artist: match[2], title: match[3] }) },
      // Pattern 6: Artist - Movie - Title
      { regex: /^(.*?)\s*-\s*(.*?)\s*-\s*(.*?)$/i, extract: (match) => ({ artist: match[1], album: match[2], title: match[3] }) },
    ]

    for (const pattern of patterns) {
      const match = baseName.match(pattern.regex)
      if (match) {
        filenameMetadata = { ...filenameMetadata, ...pattern.extract(match) }
        break
      }
    }

    // If no pattern matched, try to extract movie name from parentheses
    if (!filenameMetadata.title && !filenameMetadata.artist) {
      const movieMatch = baseName.match(/\((.*?)\)/)
      if (movieMatch) {
        filenameMetadata.album = movieMatch[1].trim()
        filenameMetadata.title = baseName.replace(/\(.*?\)/, '').trim()
      } else {
        filenameMetadata.title = baseName
      }
    }

    // Clean up metadata
    const cleanTitle = (title) => {
      return title
        .replace(/\[Official\s+Video\]/i, "")
        .replace(/\[Official\s+Audio\]/i, "")
        .replace(/\[Lyric\s+Video\]/i, "")
        .replace(/\(Official\s+Video\)/i, "")
        .replace(/\(Official\s+Audio\)/i, "")
        .replace(/\(Lyric\s+Video\)/i, "")
        .replace(/\[HD\]/i, "")
        .replace(/\(HD\)/i, "")
        .replace(/\[HQ\]/i, "")
        .replace(/\(HQ\)/i, "")
        .replace(/\[Tamil\s+HD\]/i, "")
        .replace(/\[Tamil\s+HQ\]/i, "")
        .replace(/\[Tamil\s+Song\]/i, "")
        .replace(/\[Tamil\s+Movie\]/i, "")
        .replace(/\[Tamil\s+Audio\]/i, "")
        .replace(/\[Tamil\s+Video\]/i, "")
        .replace(/\(Tamil\s+HD\)/i, "")
        .replace(/\(Tamil\s+HQ\)/i, "")
        .replace(/\(Tamil\s+Song\)/i, "")
        .replace(/\(Tamil\s+Movie\)/i, "")
        .replace(/\(Tamil\s+Audio\)/i, "")
        .replace(/\(Tamil\s+Video\)/i, "")
        .replace(/\[1080p\]/i, "")
        .replace(/\[720p\]/i, "")
        .replace(/\(1080p\)/i, "")
        .replace(/\(720p\)/i, "")
        .replace(/\[4K\]/i, "")
        .replace(/\(4K\)/i, "")
        .replace(/MassTamilan\.dev/i, "")
        .replace(/MassTamilan/i, "")
        .trim()
    }

    filenameMetadata.title = cleanTitle(filenameMetadata.title)
    filenameMetadata.artist = cleanTitle(filenameMetadata.artist)
    filenameMetadata.album = cleanTitle(filenameMetadata.album)

    // Clean up initial metadata
    initialMetadata.title = cleanTitle(initialMetadata.title)
    initialMetadata.artist = cleanTitle(initialMetadata.artist)
    initialMetadata.album = cleanTitle(initialMetadata.album)

    // Build search queries
    const searchQueries = []

    // Clean up the title and artist from filename
    const cleanedTitle = cleanTitle(filenameMetadata.title)
    const cleanedArtist = cleanTitle(filenameMetadata.artist)

    // Query 1: Clean title + artist
    if (cleanedTitle && cleanedArtist) {
      searchQueries.push(`${cleanedTitle} ${cleanedArtist}`)
    }

    // Query 2: Just the clean title
    if (cleanedTitle) {
      searchQueries.push(cleanedTitle)
    }

    // Query 3: Title + "tamil song"
    if (cleanedTitle) {
      searchQueries.push(`${cleanedTitle} tamil song`)
    }

    // Query 4: Title + "movie song"
    if (cleanedTitle) {
      searchQueries.push(`${cleanedTitle} movie song`)
    }

    // Query 5: Title + "A.R.Rahman"
    if (cleanedTitle) {
      searchQueries.push(`${cleanedTitle} A.R.Rahman`)
    }

    // Search Spotify
    const matches = []
    for (const query of searchQueries) {
      // Search Spotify
      const spotifyResults = await searchSpotify(query)
      if (spotifyResults?.tracks?.items) {
        for (const track of spotifyResults.tracks.items) {
          const match = {
            title: track.name,
            artist: track.artists.map(a => a.name).join(", "),
            album: track.album?.name || "",
            genre: track.album?.genres?.[0] || "",
            coverUrl: track.album?.images?.[0]?.url || "",
            source: "Spotify",
            confidence: calculateConfidence(track, existingMetadata, filenameMetadata, initialMetadata)
          }

          // Check if this match is already in the list
          const isDuplicate = matches.some(m => 
            m.title === match.title && 
            m.artist === match.artist && 
            m.album === match.album
          )

          if (!isDuplicate) {
            matches.push(match)
          }
        }
      }
    }

    // Add filename-based metadata as a fallback
    if (filenameMetadata.title || filenameMetadata.artist) {
      matches.push({
        ...filenameMetadata,
        source: "Filename",
        confidence: 0.5
      })
    }

    // Add file metadata as a fallback
    if (initialMetadata.title || initialMetadata.artist) {
      matches.push({
        ...initialMetadata,
        source: "File Metadata",
        confidence: 0.7
      })
    }

    // Sort matches by confidence
    matches.sort((a, b) => b.confidence - a.confidence)

    // Clean up the temporary file
    fs.unlink(tempFilePath, (err) => {
      if (err) console.error("Failed to delete temp file:", err)
    })

    res.json({ matches })
  } catch (error) {
    console.error("Metadata fetch error:", error)
    res.status(500).json({ error: "Failed to fetch metadata" })
  }
})

// Helper function to calculate confidence score
function calculateConfidence(result, existingMetadata, filenameMetadata, initialMetadata) {
  let score = 0
  const maxScore = 4 // Maximum possible score

  // Compare title
  if (result.title || result.name) {
    const resultTitle = (result.title || result.name).toLowerCase()
    if (existingMetadata?.title && resultTitle === existingMetadata.title.toLowerCase()) score += 1
    if (filenameMetadata?.title && resultTitle === filenameMetadata.title.toLowerCase()) score += 1
    if (initialMetadata?.title && resultTitle === initialMetadata.title.toLowerCase()) score += 1
  }

  // Compare artist
  const resultArtist = (result.artist || result.primaryArtists || result.artists?.map(a => a.name).join(", ")).toLowerCase()
  if (resultArtist) {
    if (existingMetadata?.artist && resultArtist === existingMetadata.artist.toLowerCase()) score += 1
    if (filenameMetadata?.artist && resultArtist === filenameMetadata.artist.toLowerCase()) score += 1
    if (initialMetadata?.artist && resultArtist === initialMetadata.artist.toLowerCase()) score += 1
  }

  // Compare album
  const resultAlbum = (result.album?.name || result.album).toLowerCase()
  if (resultAlbum) {
    if (existingMetadata?.album && resultAlbum === existingMetadata.album.toLowerCase()) score += 1
    if (filenameMetadata?.album && resultAlbum === filenameMetadata.album.toLowerCase()) score += 1
    if (initialMetadata?.album && resultAlbum === initialMetadata.album.toLowerCase()) score += 1
  }

  return score / maxScore
}

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
  })
}

// For Vercel deployment
module.exports = app
