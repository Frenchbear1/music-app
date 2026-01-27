import type { IAudioMetadata } from 'music-metadata-browser'
import type { TrackRecord } from '../types'

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.mp4',
  '.aac',
  '.wav',
  '.ogg',
  '.flac',
])

function getExtension(name: string) {
  const dotIndex = name.lastIndexOf('.')
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : ''
}

export function isAudioFile(file: File) {
  if (file.type.startsWith('audio/')) return true
  return AUDIO_EXTENSIONS.has(getExtension(file.name))
}

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `track-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getFolderFromFile(file: File) {
  const relativePath = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath

  if (!relativePath) return 'Imported'

  const parts = relativePath.split('/')
  parts.pop()
  return parts.length > 0 ? parts.join('/') : 'Imported'
}

function getAlbumFromFolder(folder: string) {
  if (!folder || folder === 'Imported') return 'Unknown Album'
  const parts = folder.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? 'Unknown Album'
}

async function readMetadata(file: File): Promise<IAudioMetadata | null> {
  try {
    const { parseBlob } = await import('music-metadata-browser')
    return await parseBlob(file)
  } catch {
    return null
  }
}

function bytesToBase64(data: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000

  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

function pictureToDataUrl(metadata: IAudioMetadata | null) {
  const picture = metadata?.common.picture?.[0]
  if (!picture?.data?.length) return undefined

  const base64String = bytesToBase64(picture.data)
  const mime = picture.format || 'image/jpeg'
  return `data:${mime};base64,${base64String}`
}

export function getAudioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio')
    const objectUrl = URL.createObjectURL(blob)

    const cleanup = () => {
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(objectUrl)
    }

    audio.preload = 'metadata'
    audio.src = objectUrl

    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0
      cleanup()
      resolve(duration)
    }

    audio.onerror = () => {
      cleanup()
      resolve(0)
    }
  })
}

function fallbackTitleFromFilename(filename: string) {
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename
}

function pickDuration(metadata: IAudioMetadata | null) {
  const duration = metadata?.format.duration
  return duration && Number.isFinite(duration) ? duration : 0
}

export type BuildTrackOptions = {
  id?: string
  folder?: string
  filename?: string
  album?: string
  addedAt?: number
  favorite?: boolean
  source?: TrackRecord['source']
  sourceKey?: string
}

export async function buildTrackFromFile(
  file: File,
  options?: BuildTrackOptions,
): Promise<TrackRecord> {
  const metadata = await readMetadata(file)
  const folder = options?.folder ?? getFolderFromFile(file)
  const filename = options?.filename ?? file.name

  const parsedDuration = pickDuration(metadata)
  const duration = parsedDuration > 0 ? parsedDuration : await getAudioDuration(file)

  const title =
    metadata?.common.title?.trim() ||
    fallbackTitleFromFilename(filename).trim() ||
    'Unknown Title'

  const artist = metadata?.common.artist?.trim() || 'Unknown Artist'
  const album =
    options?.album?.trim() ||
    metadata?.common.album?.trim() ||
    getAlbumFromFolder(folder)
  const artUrl = pictureToDataUrl(metadata)

  return {
    id: options?.id ?? makeId(),
    title,
    artist,
    album,
    duration,
    addedAt: options?.addedAt ?? Date.now(),
    favorite: options?.favorite ?? false,
    folder,
    filename,
    artUrl,
    source: options?.source ?? 'imported',
    sourceKey: options?.sourceKey,
    blob: file,
  }
}

export async function importAudioFiles(
  files: File[],
  onProgress?: (completed: number, total: number) => void,
): Promise<TrackRecord[]> {
  const audioFiles = files.filter(isAudioFile)
  const results: TrackRecord[] = []

  let completed = 0
  const total = audioFiles.length

  for (const file of audioFiles) {
    const track = await buildTrackFromFile(file)
    results.push(track)
    completed += 1
    onProgress?.(completed, total)
  }

  return results
}
