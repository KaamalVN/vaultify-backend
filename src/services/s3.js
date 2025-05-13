const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3")
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner")
const config = require('../config')

// Add middleware to remove problematic headers
const removeChecksumHeader = (next) => async (args) => {
  if (args.request && args.request.headers) {
    delete args.request.headers['x-amz-checksum-mode']
    delete args.request.headers['x-amz-checksum-algorithm']
  }
  return next(args)
}

// Initialize the S3 client for Backblaze B2
const client = new S3Client({
  region: config.s3.region,
  endpoint: config.s3.endpoint,
  credentials: config.s3.credentials,
  forcePathStyle: true,
  disableHostPrefix: true,
  disableChecksum: true,
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

async function listFiles() {
  const listCommand = new ListObjectsV2Command({
    Bucket: config.s3.bucketName,
  })
  return await client.send(listCommand)
}

async function getSignedUrlForFile(key) {
  const getObjectCommand = new GetObjectCommand({
    Bucket: config.s3.bucketName,
    Key: key,
  })
  return await getSignedUrl(client, getObjectCommand, { expiresIn: 3600 })
}

async function uploadFile(filePath, fileName, contentType) {
  const putCommand = new PutObjectCommand({
    Bucket: config.s3.bucketName,
    Key: fileName,
    Body: filePath,
    ContentType: contentType
  })
  return await client.send(putCommand)
}

async function deleteFile(key) {
  const deleteCommand = new DeleteObjectCommand({
    Bucket: config.s3.bucketName,
    Key: key,
  })
  return await client.send(deleteCommand)
}

async function getMetadata() {
  try {
    const getCommand = new GetObjectCommand({
      Bucket: config.s3.bucketName,
      Key: "metadata/all.json",
    })
    const response = await client.send(getCommand)
    const metadataString = await streamToString(response.Body)
    return JSON.parse(metadataString)
  } catch (error) {
    return { songs: {}, playlists: {} }
  }
}

module.exports = {
  client,
  streamToString,
  listFiles,
  getSignedUrlForFile,
  uploadFile,
  deleteFile,
  getMetadata
} 