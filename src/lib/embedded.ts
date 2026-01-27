import type { TrackRecord } from '../types'
import { getTrackRecord, upsertTracks } from './db'
import { buildTrackFromFile } from './metadata'

type EmbeddedManifestEntry = {
  path: string
  filename: string
  folder: string
  albumName?: string
}

type EmbeddedManifest = {
  tracks?: EmbeddedManifestEntry[]
}

type SyncProgress = {
  completed: number
  total: number
}

type SyncResult = {
  total: number
  imported: number
  skipped: number
}

const MANIFEST_PATH = '/songs/manifest.json'

function normalizeFolder(folder: string | undefined) {
  if (!folder || folder.trim().length === 0) return 'Embedded'
  return folder
}

function albumFromFolder(folder: string | undefined) {
  if (!folder) return 'Embedded'
  const parts = folder.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? 'Embedded'
}

function makeEmbeddedId(path: string) {
  return `embedded:${path}`
}

async function fetchManifest(): Promise<EmbeddedManifestEntry[]> {
  try {
    const response = await fetch(MANIFEST_PATH, { cache: 'no-store' })
    if (!response.ok) return []
    const manifest = (await response.json()) as EmbeddedManifest
    const tracks = manifest.tracks ?? []
    return tracks.filter((entry) => entry.path && entry.filename)
  } catch {
    return []
  }
}

async function fetchSongBlob(path: string): Promise<Blob | null> {
  try {
    const response = await fetch(path)
    if (!response.ok) return null
    return await response.blob()
  } catch {
    return null
  }
}

export async function syncEmbeddedSongs(
  onProgress?: (progress: SyncProgress) => void,
): Promise<SyncResult> {
  const manifestEntries = await fetchManifest()
  const total = manifestEntries.length

  if (total === 0) {
    onProgress?.({ completed: 0, total: 0 })
    return { total: 0, imported: 0, skipped: 0 }
  }

  const newTracks: TrackRecord[] = []
  let completed = 0
  let skipped = 0

  for (const entry of manifestEntries) {
    const id = makeEmbeddedId(entry.path)
    const existing = await getTrackRecord(id)

    if (existing) {
      skipped += 1
      completed += 1
      onProgress?.({ completed, total })
      continue
    }

    const blob = await fetchSongBlob(entry.path)
    if (!blob) {
      completed += 1
      onProgress?.({ completed, total })
      continue
    }

    const mimeType = blob.type || 'audio/mpeg'
    const file = new File([blob], entry.filename, { type: mimeType })

    const track = await buildTrackFromFile(file, {
      id,
      folder: normalizeFolder(entry.folder),
      filename: entry.filename,
      album: entry.albumName ?? albumFromFolder(entry.folder),
      addedAt: Date.now(),
      favorite: false,
      source: 'embedded',
      sourceKey: entry.path,
    })

    newTracks.push(track)

    completed += 1
    onProgress?.({ completed, total })
  }

  await upsertTracks(newTracks)

  return {
    total,
    imported: newTracks.length,
    skipped,
  }
}
