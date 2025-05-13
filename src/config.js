require('dotenv').config()

const config = {
  spotify: {
    apiUrl: "https://api.spotify.com/v1",
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET
  },
  s3: {
    region: process.env.B2_REGION,
    endpoint: process.env.B2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.B2_ACCESS_KEY_ID,
      secretAccessKey: process.env.B2_SECRET_ACCESS_KEY,
    },
    bucketName: process.env.B2_BUCKET_NAME
  },
  audio: {
    extensions: [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac"],
    archiveExtensions: [".zip", ".rar", ".7z"]
  }
}

module.exports = config 