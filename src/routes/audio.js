const express = require('express')
const router = express.Router()
const multer = require('multer')
const os = require('os')
const path = require('path')
const fs = require('fs')
const extract = require('extract-zip')
const AdmZip = require('adm-zip')
const { createReadStream } = require('fs')
const { pipeline } = require('stream/promises')
const crypto = require('crypto')

const s3Service = require('../services/s3')
const spotifyService = require('../services/spotify')
const metadataUtils = require('../utils/metadata')
const config = require('../config')

const upload = multer({ dest: os.tmpdir() })

// Get all audio files with signed URLs
router.get("/audio-urls", async (req, res) => {
  try {
    const listData = await s3Service.listFiles()
    const files = listData.Contents || []
    const allMetadata = await s3Service.getMetadata()

    const signedUrls = await Promise.all(
      files.map(async (file) => {
        if (file.Key.startsWith("metadata/")) {
          return null
        }

        const signedUrl = await s3Service.getSignedUrlForFile(file.Key)
        const metadata = allMetadata.songs[file.Key] || {}

        return {
          fileName: file.Key,
          signedUrl: signedUrl,
          ...metadata,
        }
      })
    )

    res.json(signedUrls.filter(Boolean))
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to generate signed URLs" })
  }
})

// Upload audio file
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" })
    }

    const file = req.file
    const fileName = file.originalname
    const filePath = file.path

    // Get metadata
    const metadata = await metadataUtils.fetchEnhancedMetadata(fileName, filePath)
    
    // Upload to B2
    const contentType = getContentType(fileName)
    await s3Service.uploadFile(createReadStream(filePath), fileName, contentType)

    // Clean up temp file
    fs.unlinkSync(filePath)

    res.json({ message: "File uploaded successfully", metadata })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to upload file" })
  }
})

// Delete audio file
router.delete("/:fileName", async (req, res) => {
  try {
    const fileName = req.params.fileName
    await s3Service.deleteFile(fileName)
    res.json({ message: "File deleted successfully" })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: "Failed to delete file" })
  }
})

function getContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase()
  const contentTypes = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.7z': 'application/x-7z-compressed'
  }
  return contentTypes[ext] || 'application/octet-stream'
}

module.exports = router 