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
  deleted: {
    key: string
    value: {
      key: string
      deletedAt: number
      title?: string
      artist?: string
      album?: string
      folder?: string
      filename?: string
    }
  }
  favorites: {
    key: string
    value: {
      key: string
      updatedAt: number
    }
  }
}

let dbPromise: Promise<IDBPDatabase<MusicAppDB>> | null = null

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<MusicAppDB>('music-app-db', 3, {
      upgrade(db, oldVersion, _newVersion, transaction) {
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

        if (oldVersion < 2 && !db.objectStoreNames.contains('deleted')) {
          db.createObjectStore('deleted', { keyPath: 'key' })
        }

        if (oldVersion < 3 && !db.objectStoreNames.contains('favorites')) {
          db.createObjectStore('favorites', { keyPath: 'key' })
        }
      },
    })
  }
  return dbPromise
}

function toSummary(track: TrackRecord): TrackSummary {
  const { blob: _blob, ...summary } = track
  void _blob
  return summary
}

export async function getAllTrackSummaries(): Promise<TrackSummary[]> {
  const db = await getDb()
  const all = await db.getAll('tracks')
  return all.map(toSummary)
}

export async function getTrackRecord(id: string): Promise<TrackRecord | null> {
  const db = await getDb()
  const track = await db.get('tracks', id)
  return track ?? null
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

export async function deleteTrack(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('tracks', id)
}

export async function addDeletedKey(key: string): Promise<void> {
  if (!key) return
  const db = await getDb()
  await db.put('deleted', { key, deletedAt: Date.now() })
}

export async function getDeletedKeys(): Promise<Set<string>> {
  const db = await getDb()
  const keys = await db.getAllKeys('deleted')
  return new Set(keys as string[])
}

export async function addDeletedEntry(
  entry: {
    key: string
    title?: string
    artist?: string
    album?: string
    folder?: string
    filename?: string
  },
): Promise<void> {
  if (!entry.key) return
  const db = await getDb()
  await db.put('deleted', { ...entry, deletedAt: Date.now() })
}

export async function getDeletedEntries(): Promise<
  Array<{
    key: string
    deletedAt: number
    title?: string
    artist?: string
    album?: string
    folder?: string
    filename?: string
  }>
> {
  const db = await getDb()
  return (await db.getAll('deleted')) as Array<{
    key: string
    deletedAt: number
    title?: string
    artist?: string
    album?: string
    folder?: string
    filename?: string
  }>
}

export async function removeDeletedKey(key: string): Promise<void> {
  if (!key) return
  const db = await getDb()
  await db.delete('deleted', key)
}

export async function setFavoriteKey(key: string, favorite: boolean): Promise<void> {
  if (!key) return
  const db = await getDb()
  if (favorite) {
    await db.put('favorites', { key, updatedAt: Date.now() })
    return
  }
  await db.delete('favorites', key)
}

export async function getFavoriteKeys(): Promise<Set<string>> {
  const db = await getDb()
  const keys = await db.getAllKeys('favorites')
  return new Set(keys as string[])
}
