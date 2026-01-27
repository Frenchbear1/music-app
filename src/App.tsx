import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { TabKey, TrackSummary } from './types'
import {
  deleteAllTracks,
  getAllTrackSummaries,
  getTrackBlob,
  updateTrack,
  upsertTracks,
} from './lib/db'
import { importAudioFiles } from './lib/metadata'

type ImportProgress = {
  completed: number
  total: number
}

type FilterBy = 'all' | 'title' | 'artist' | 'album' | 'folder' | 'filename'

const FILTER_LABELS: Record<FilterBy, string> = {
  all: 'Everything',
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  folder: 'Folder',
  filename: 'Filename',
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const totalSeconds = Math.floor(seconds)
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function defaultSort(tracks: TrackSummary[]) {
  return [...tracks].sort((a, b) => b.addedAt - a.addedAt)
}

function useStorageEstimate() {
  const [estimate, setEstimate] = useState<{
    usedMB: number
    quotaMB: number
  } | null>(null)

  const refresh = useCallback(async () => {
    if (!navigator.storage?.estimate) return
    const result = await navigator.storage.estimate()
    const usedMB = (result.usage ?? 0) / (1024 * 1024)
    const quotaMB = (result.quota ?? 0) / (1024 * 1024)
    setEstimate({ usedMB, quotaMB })
  }, [])

  useEffect(() => {
    refresh().catch(() => undefined)
  }, [refresh])

  return { estimate, refresh }
}

function App() {
  const [tracks, setTracks] = useState<TrackSummary[]>([])
  const [tab, setTab] = useState<TabKey>('library')
  const [search, setSearch] = useState('')
  const [filterBy, setFilterBy] = useState<FilterBy>('all')
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [statusMessage, setStatusMessage] = useState('')

  const [queueIds, setQueueIds] = useState<string[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [currentDuration, setCurrentDuration] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const currentObjectUrlRef = useRef<string | null>(null)
  const pendingPlayRef = useRef(false)

  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const { estimate: storageEstimate, refresh: refreshStorageEstimate } =
    useStorageEstimate()

  const loadTracks = useCallback(async () => {
    const all = await getAllTrackSummaries()
    setTracks(all)
  }, [])

  useEffect(() => {
    loadTracks().catch(() => undefined)
  }, [loadTracks])

  const filteredTracks = useMemo(() => {
    const loweredSearch = search.trim().toLowerCase()

    const base = tracks.filter((track) => !(tab === 'favorites' && !track.favorite))
    if (!loweredSearch) return defaultSort(base)

    const matches = (track: TrackSummary) => {
      const fields =
        filterBy === 'all'
          ? [track.title, track.artist, track.album, track.folder, track.filename]
          : [track[filterBy]]

      return fields.join(' ').toLowerCase().includes(loweredSearch)
    }

    return defaultSort(base.filter(matches))
  }, [tracks, tab, search, filterBy])

  const currentTrack = useMemo(() => {
    return currentId ? tracks.find((t) => t.id === currentId) ?? null : null
  }, [currentId, tracks])

  const currentIndex = useMemo(() => {
    if (!currentId) return -1
    return queueIds.indexOf(currentId)
  }, [queueIds, currentId])

  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex >= 0 && currentIndex < queueIds.length - 1

  const handleImport = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return

      setStatusMessage('')

      const files = Array.from(fileList)
      setImportProgress({ completed: 0, total: files.length })

      const newTracks = await importAudioFiles(files, (completed, total) => {
        setImportProgress({ completed, total })
      })

      await upsertTracks(newTracks)
      await loadTracks()

      setImportProgress(null)
      setStatusMessage(
        newTracks.length === 0
          ? 'No audio files found in that selection.'
          : `Imported ${newTracks.length} track${newTracks.length === 1 ? '' : 's'}. Ready offline.`,
      )

      refreshStorageEstimate().catch(() => undefined)
    },
    [loadTracks, refreshStorageEstimate],
  )

  const openFolderPicker = useCallback(() => {
    folderInputRef.current?.click()
  }, [])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const clearLibrary = useCallback(async () => {
    await deleteAllTracks()
    setTracks([])
    setQueueIds([])
    setCurrentId(null)
    setIsPlaying(false)
    setCurrentTime(0)
    setCurrentDuration(0)
    setStatusMessage('Library cleared.')

    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }

    if (currentObjectUrlRef.current) {
      URL.revokeObjectURL(currentObjectUrlRef.current)
      currentObjectUrlRef.current = null
    }

    refreshStorageEstimate().catch(() => undefined)
  }, [refreshStorageEstimate])

  const setFavorite = useCallback(async (id: string, favorite: boolean) => {
    const updated = await updateTrack(id, (track) => ({ ...track, favorite }))
    if (!updated) return

    setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)))
  }, [])

  const toggleFavorite = useCallback(
    (track: TrackSummary) => {
      setFavorite(track.id, !track.favorite).catch(() => undefined)
    },
    [setFavorite],
  )

  const loadTrackIntoAudio = useCallback(
    async (id: string) => {
      const blob = await getTrackBlob(id)
      if (!blob) return

      const audio = audioRef.current
      if (!audio) return

      if (currentObjectUrlRef.current) {
        URL.revokeObjectURL(currentObjectUrlRef.current)
        currentObjectUrlRef.current = null
      }

      const objectUrl = URL.createObjectURL(blob)
      currentObjectUrlRef.current = objectUrl

      audio.src = objectUrl
      audio.currentTime = 0
      setCurrentTime(0)
      setCurrentDuration(0)

      if (pendingPlayRef.current || isPlaying) {
        try {
          await audio.play()
          setIsPlaying(true)
        } catch {
          setIsPlaying(false)
        } finally {
          pendingPlayRef.current = false
        }
      }
    },
    [isPlaying],
  )

  useEffect(() => {
    if (!currentId) return
    loadTrackIntoAudio(currentId).catch(() => undefined)
  }, [currentId, loadTrackIntoAudio])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime)
    }

    const onLoadedMetadata = () => {
      setCurrentDuration(Number.isFinite(audio.duration) ? audio.duration : 0)
    }

    const onEnded = () => {
      if (canGoNext) {
        const nextId = queueIds[currentIndex + 1]
        if (nextId) {
          pendingPlayRef.current = true
          setCurrentId(nextId)
          return
        }
      }
      setIsPlaying(false)
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
    }
  }, [canGoNext, currentIndex, queueIds])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !audio.src) return

    if (isPlaying) {
      audio.play().catch(() => {
        setIsPlaying(false)
      })
    } else {
      audio.pause()
    }
  }, [isPlaying])

  const playTrack = useCallback(
    (track: TrackSummary, list: TrackSummary[]) => {
      const ids = list.map((t) => t.id)
      setQueueIds(ids)
      pendingPlayRef.current = true
      setCurrentId(track.id)
      setIsPlaying(true)
    },
    [],
  )

  const playFromVisible = useCallback(
    (track: TrackSummary) => {
      playTrack(track, filteredTracks)
    },
    [filteredTracks, playTrack],
  )

  const goNext = useCallback(() => {
    if (!canGoNext) return
    const nextId = queueIds[currentIndex + 1]
    if (!nextId) return
    pendingPlayRef.current = isPlaying
    setCurrentId(nextId)
  }, [canGoNext, currentIndex, isPlaying, queueIds])

  const goPrev = useCallback(() => {
    if (!canGoPrev) return
    const prevId = queueIds[currentIndex - 1]
    if (!prevId) return
    pendingPlayRef.current = isPlaying
    setCurrentId(prevId)
  }, [canGoPrev, currentIndex, isPlaying, queueIds])

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return

    if (!currentId && filteredTracks.length > 0) {
      playTrack(filteredTracks[0], filteredTracks)
      return
    }

    if (!audio.src && currentId) {
      pendingPlayRef.current = true
      setIsPlaying(true)
      return
    }

    setIsPlaying((prev) => !prev)
  }, [currentId, filteredTracks, playTrack])

  const seekTo = useCallback((value: number) => {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = value
    setCurrentTime(value)
  }, [])

  const activeCount = filteredTracks.length
  const totalCount = tracks.length

  return (
    <div className="app">
      <audio ref={audioRef} />

      <header className="app__header">
        <div>
          <h1 className="app__title">Music App</h1>
          <p className="app__subtitle">
            Import MP3 folders once, then it plays offline — even on a plane.
          </p>
        </div>

        <div className="app__tabs" role="tablist" aria-label="Library Tabs">
          <button
            className={`tab ${tab === 'library' ? 'tab--active' : ''}`}
            onClick={() => setTab('library')}
            role="tab"
            aria-selected={tab === 'library'}
          >
            Library
          </button>
          <button
            className={`tab ${tab === 'favorites' ? 'tab--active' : ''}`}
            onClick={() => setTab('favorites')}
            role="tab"
            aria-selected={tab === 'favorites'}
          >
            Favorites
          </button>
        </div>
      </header>

      <section className="panel panel--import">
        <div className="panel__row">
          <div className="panel__actions">
            <button className="btn btn--primary" onClick={openFolderPicker}>
              Import Folder
            </button>
            <button className="btn" onClick={openFilePicker}>
              Import Songs
            </button>
            <button className="btn btn--ghost" onClick={clearLibrary}>
              Clear Library
            </button>

            <input
              ref={folderInputRef}
              className="sr-only"
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac"
              multiple
              onChange={(e) => handleImport(e.target.files).catch(() => undefined)}
              // These attributes enable folder picking in Chromium-based browsers.
              {...({ webkitdirectory: '' } as Record<string, string>)}
              {...({ directory: '' } as Record<string, string>)}
            />

            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac"
              multiple
              onChange={(e) => handleImport(e.target.files).catch(() => undefined)}
            />
          </div>

          <div className="panel__meta">
            <span className="pill">
              Showing {activeCount} / {totalCount}
            </span>
            {storageEstimate && (
              <span className="pill">
                Storage {storageEstimate.usedMB.toFixed(0)} / {storageEstimate.quotaMB.toFixed(0)} MB
              </span>
            )}
          </div>
        </div>

        <div className="panel__hint">
          Tip: click <strong>Import Folder</strong> and pick{' '}
          <code>Downloads\Music</code> (or any folder). Browsers block auto-scanning
          local files, but once you import, everything is saved for offline playback.
        </div>

        {importProgress && (
          <div className="progress">
            <div
              className="progress__bar"
              style={{
                width:
                  importProgress.total === 0
                    ? '0%'
                    : `${Math.min(
                        100,
                        Math.round((importProgress.completed / importProgress.total) * 100),
                      )}%`,
              }}
            />
            <div className="progress__label">
              Importing {importProgress.completed} / {importProgress.total}
            </div>
          </div>
        )}

        {statusMessage && <div className="status">{statusMessage}</div>}
      </section>

      <section className="panel panel--controls">
        <div className="controls">
          <label className="field">
            <span className="field__label">Filter By</span>
            <select
              className="field__select"
              value={filterBy}
              onChange={(e) => setFilterBy(e.target.value as FilterBy)}
            >
              {(Object.keys(FILTER_LABELS) as FilterBy[]).map((key) => (
                <option key={key} value={key}>
                  {FILTER_LABELS[key]}
                </option>
              ))}
            </select>
          </label>

          <label className="field field--search">
            <span className="field__label">Search</span>
            <div className="search">
              <input
                className="field__input search__input"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Type to search..."
              />
              <button
                className="btn btn--primary search__btn"
                type="button"
                onClick={() => setSearch((prev) => prev.trim())}
                aria-label="Search"
                title="Search"
              >
                Search
              </button>
            </div>
          </label>
        </div>
      </section>

      <main className="library" aria-live="polite">
        {filteredTracks.length === 0 ? (
          <div className="empty">
          <div className="empty__title">No tracks yet</div>
          <div className="empty__text">
              Import a folder or some songs to build your offline library.
          </div>
        </div>
      ) : (
          <ul className="track-list">
            {filteredTracks.map((track) => {
              const isActive = track.id === currentId
              return (
                <li key={track.id} className={`track ${isActive ? 'track--active' : ''}`}>
                  <button className="track__main" onClick={() => playFromVisible(track)}>
                    <div className="art" aria-hidden="true">
                      {track.artUrl ? (
                        <img src={track.artUrl} alt="" loading="lazy" />
                      ) : (
                        <div className="art__fallback">♪</div>
                      )}
                    </div>

                    <div className="track__meta">
                      <div className="track__title" title={track.title}>
                        {track.title}
                      </div>
                      <div className="track__sub">
                        <span title={track.artist}>{track.artist}</span>
                        <span className="dot">•</span>
                        <span title={track.album}>{track.album}</span>
                        <span className="dot">•</span>
                        <span title={track.folder}>{track.folder}</span>
                      </div>
                    </div>

                    <div className="track__right">
                      <span className="track__duration">{formatTime(track.duration)}</span>
                      <span className="track__added">
                        {new Date(track.addedAt).toLocaleDateString()}
                      </span>
                    </div>
                  </button>

                  <div className="track__actions">
                    <button
                      className={`icon-btn ${track.favorite ? 'icon-btn--favorite' : ''}`}
                      onClick={() => toggleFavorite(track)}
                      aria-label={track.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      title={track.favorite ? 'Remove from favorites' : 'Add to favorites'}
                    >
                      {track.favorite ? '♥' : '♡'}
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </main>

      <footer className="player">
        <div className="player__now">
          <div className="art art--small" aria-hidden="true">
            {currentTrack?.artUrl ? (
              <img src={currentTrack.artUrl} alt="" />
            ) : (
              <div className="art__fallback">♪</div>
            )}
          </div>
          <div className="player__meta">
            <div className="player__title">{currentTrack?.title ?? 'Nothing playing'}</div>
            <div className="player__sub">
              {currentTrack
                ? `${currentTrack.artist} • ${currentTrack.album} • ${currentTrack.folder}`
                : 'Import music to start playing offline.'}
            </div>
          </div>
        </div>

        <div className="player__controls">
          <div className="player__buttons">
            <button className="icon-btn" onClick={goPrev} disabled={!canGoPrev} aria-label="Previous">
              ‹‹
            </button>
            <button className="icon-btn icon-btn--play" onClick={togglePlayPause} aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button className="icon-btn" onClick={goNext} disabled={!canGoNext} aria-label="Next">
              ››
            </button>
          </div>

          <div className="player__timeline">
            <span className="time">{formatTime(currentTime)}</span>
            <input
              className="timeline"
              type="range"
              min={0}
              max={Math.max(currentDuration, 0)}
              step={0.1}
              value={Math.min(currentTime, currentDuration || currentTime)}
              onChange={(e) => seekTo(Number(e.target.value))}
              disabled={!currentTrack}
              aria-label="Seek"
            />
            <span className="time">{formatTime(currentDuration)}</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

export default App
