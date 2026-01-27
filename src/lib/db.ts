import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { TrackRecord, TrackSummary } from '../types'

interface MusicAppDB extends DBSchema {
  tracks: {
    key: string
    value: TrackRecord
    indexes: {
      byAddedAt: number
      byArtist: string
      byAlbum: string
      byFolder: string
      byTitle: string
    }
  }
}

let dbPromise: Promise<IDBPDatabase<MusicAppDB>> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<MusicAppDB>('music-app-db', 1, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        const store = db.objectStoreNames.contains('tracks')
          ? transaction.objectStore('tracks')
          : db.createObjectStore('tracks', { keyPath: 'id' })

        type TrackIndexName = keyof MusicAppDB['tracks']['indexes']

        const ensureIndex = (name: TrackIndexName, keyPath: string) => {
          if (!store.indexNames.contains(name)) {
            store.createIndex(name, keyPath)
          }
        }

        ensureIndex('byAddedAt', 'addedAt')
        ensureIndex('byArtist', 'artist')
        ensureIndex('byAlbum', 'album')
        ensureIndex('byFolder', 'folder')
        ensureIndex('byTitle', 'title')
      },
    })
  }
  return dbPromise
}

function toSummary(track: TrackRecord): TrackSummary {
  const { blob: _blob, ...summary } = track
  return summary
}

export async function getAllTrackSummaries(): Promise<TrackSummary[]> {
  const db = await getDb()
  const all = await db.getAll('tracks')
  return all.map(toSummary)
}

export async function getTrackBlob(id: string): Promise<Blob | null> {
  const db = await getDb()
  const track = await db.get('tracks', id)
  return track?.blob ?? null
}

export async function upsertTracks(tracks: TrackRecord[]): Promise<void> {
  if (tracks.length === 0) return
  const db = await getDb()
  const tx = db.transaction('tracks', 'readwrite')
  for (const track of tracks) {
    await tx.store.put(track)
  }
  await tx.done
}

export async function updateTrack(
  id: string,
  updater: (track: TrackRecord) => TrackRecord,
): Promise<TrackSummary | null> {
  const db = await getDb()
  const tx = db.transaction('tracks', 'readwrite')
  const existing = await tx.store.get(id)
  if (!existing) {
    await tx.done
    return null
  }
  const updated = updater(existing)
  await tx.store.put(updated)
  await tx.done
  return toSummary(updated)
}

export async function deleteAllTracks(): Promise<void> {
  const db = await getDb()
  await db.clear('tracks')
}
