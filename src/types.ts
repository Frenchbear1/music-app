export type SortField =
  | 'title'
  | 'artist'
  | 'album'
  | 'duration'
  | 'addedAt'
  | 'folder'
  | 'filename'

export type SortDirection = 'asc' | 'desc'

export type TabKey = 'library' | 'favorites'

export interface TrackRecord {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  addedAt: number
  favorite: boolean
  folder: string
  filename: string
  artUrl?: string
  blob: Blob
}

export interface TrackSummary {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  addedAt: number
  favorite: boolean
  folder: string
  filename: string
  artUrl?: string
}
