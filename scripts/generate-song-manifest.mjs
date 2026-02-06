import { promises as fs } from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const songsDir = path.join(projectRoot, 'public', 'songs')
const manifestPath = path.join(songsDir, 'manifest.json')

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.mp4',
  '.aac',
  '.wav',
  '.ogg',
  '.flac',
])

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function isAudioFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return AUDIO_EXTENSIONS.has(ext)
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const results = []

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await walk(fullPath)))
      continue
    }

    results.push(fullPath)
  }

  return results
}

async function generateManifest() {
  await fs.mkdir(songsDir, { recursive: true })

  const allFiles = await walk(songsDir)
  const audioFiles = allFiles.filter((filePath) => {
    if (filePath === manifestPath) return false
    return isAudioFile(filePath)
  })

  const tracks = audioFiles
    .map((filePath) => {
      const relativeToSongs = toPosix(path.relative(songsDir, filePath))
      const filename = path.basename(filePath)
      const folderRelative = path.dirname(relativeToSongs)
      const folder =
        folderRelative && folderRelative !== '.'
          ? `Embedded/${folderRelative}`
          : 'Embedded'
      const albumName =
        folderRelative && folderRelative !== '.'
          ? path.basename(folderRelative)
          : 'Embedded'

      return {
        path: `songs/${relativeToSongs}`,
        filename,
        folder,
        albumName,
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))

  const manifest = {
    generatedAt: new Date().toISOString(),
    count: tracks.length,
    tracks,
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`Song manifest generated with ${tracks.length} track(s).`)
}

generateManifest().catch((error) => {
  console.error('Failed to generate song manifest.')
  console.error(error)
  process.exitCode = 1
})
