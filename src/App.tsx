import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { TabKey, TrackSummary } from './types'
import {
  deleteAllTracks,
  deleteTrack,
  getAllTrackSummaries,
  getTrackBlob,
  updateTrack,
  upsertTracks,
} from './lib/db'
import { syncEmbeddedSongs } from './lib/embedded'
import { buildTrackFromFile, importAudioFiles } from './lib/metadata'

type ImportProgress = {
  completed: number
  total: number
  label?: string
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh().catch(() => undefined)
  }, [refresh])

  return { estimate, refresh }
}

function App() {
  const [tracks, setTracks] = useState<TrackSummary[]>([])
  const [libraryMode, setLibraryMode] = useState<'offline' | 'session'>('offline')
  const [tab, setTab] = useState<TabKey>('library')
  const [selectedAlbumFolder, setSelectedAlbumFolder] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filterBy, setFilterBy] = useState<FilterBy>('all')
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const [queueIds, setQueueIds] = useState<string[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [currentDuration, setCurrentDuration] = useState(0)
  const [shuffleOn, setShuffleOn] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const currentObjectUrlRef = useRef<string | null>(null)
  const pendingPlayRef = useRef(false)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressTriggeredRef = useRef(false)
  const sessionBlobsRef = useRef<Map<string, Blob>>(new Map())

  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const { estimate: storageEstimate, refresh: refreshStorageEstimate } =
    useStorageEstimate()

  const loadTracks = useCallback(async () => {
    const all = await getAllTrackSummaries()
    setTracks(all)
    setLibraryMode('offline')
  }, [])

  useEffect(() => {
    loadTracks().catch(() => undefined)
  }, [loadTracks])

  useEffect(() => {
    let cancelled = false
    let started = false
    const label = 'Syncing embedded songs'

    const run = async () => {
      const result = await syncEmbeddedSongs(({ completed, total }) => {
        if (cancelled || total === 0) return
        started = true
        setStatusMessage('')
        setImportProgress({ completed, total, label })
      })

      if (cancelled || result.total === 0) return

      if (started) {
        setImportProgress(null)
      }

      if (result.imported > 0) {
        await loadTracks()
        setStatusMessage(
          `Synced ${result.imported} embedded track${result.imported === 1 ? '' : 's'}.`,
        )
        refreshStorageEstimate().catch(() => undefined)
        return
      }

      setStatusMessage('Embedded songs are up to date.')
    }

    run().catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [loadTracks, refreshStorageEstimate])

  useEffect(() => {
    if (!statusMessage) return
    const timeoutId = window.setTimeout(() => {
      setStatusMessage('')
    }, 5000)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [statusMessage])

  const embeddedAlbums = useMemo(() => {
    const embeddedTracks = tracks.filter(
      (track) => track.source === 'embedded' || track.source === 'imported',
    )
    const albumsByFolder = new Map<
      string,
      { folder: string; name: string; count: number; tracks: TrackSummary[] }
    >()

    for (const track of embeddedTracks) {
      const folder = track.folder || 'Embedded'
      const existing = albumsByFolder.get(folder)

      if (existing) {
        existing.count += 1
        existing.tracks.push(track)
        continue
      }

      const fallbackName = folder.split('/').filter(Boolean).pop() ?? 'Embedded'
      albumsByFolder.set(folder, {
        folder,
        name: track.album || fallbackName,
        count: 1,
        tracks: [track],
      })
    }

    return Array.from(albumsByFolder.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  }, [tracks])

  const selectedAlbum = useMemo(() => {
    if (!selectedAlbumFolder) return null
    return embeddedAlbums.find((album) => album.folder === selectedAlbumFolder) ?? null
  }, [embeddedAlbums, selectedAlbumFolder])

  const filteredTracks = useMemo(() => {
    const loweredSearch = search.trim().toLowerCase()

    if (tab === 'albums' && !selectedAlbum) {
      return []
    }

    const base =
      tab === 'favorites'
        ? tracks.filter((track) => track.favorite)
        : tab === 'albums' && selectedAlbum
          ? selectedAlbum.tracks
          : tracks

    if (!loweredSearch) return defaultSort(base)

    const matches = (track: TrackSummary) => {
      const fields =
        filterBy === 'all'
          ? [track.title, track.artist, track.album, track.folder, track.filename]
          : [track[filterBy]]

      return fields.join(' ').toLowerCase().includes(loweredSearch)
    }

    return defaultSort(base.filter(matches))
  }, [tracks, tab, selectedAlbum, search, filterBy])

  useEffect(() => {
    if (tab !== 'albums' && selectedAlbumFolder) {
      setSelectedAlbumFolder(null)
    }
  }, [tab, selectedAlbumFolder])

  useEffect(() => {
    if (tab === 'albums' && selectedAlbumFolder && !selectedAlbum) {
      setSelectedAlbumFolder(null)
    }
  }, [tab, selectedAlbumFolder, selectedAlbum])

  const currentTrack = useMemo(() => {
    return currentId ? tracks.find((t) => t.id === currentId) ?? null : null
  }, [currentId, tracks])

  const currentIndex = useMemo(() => {
    if (!currentId) return -1
    return queueIds.indexOf(currentId)
  }, [queueIds, currentId])

  const canGoPrev = currentIndex > 0
  const canGoNext = currentIndex >= 0 && currentIndex < queueIds.length - 1
  const canShuffleStep = queueIds.length > 1
  const prevDisabled = shuffleOn ? !canShuffleStep : !canGoPrev
  const nextDisabled = shuffleOn ? !canShuffleStep : !canGoNext

  const pickRandomNextId = useCallback(() => {
    if (queueIds.length === 0) return null
    const candidates = queueIds.filter((id) => id !== currentId)
    const pool = candidates.length > 0 ? candidates : queueIds
    const index = Math.floor(Math.random() * pool.length)
    return pool[index] ?? null
  }, [queueIds, currentId])

  const handleImport = useCallback(
    async (fileList: FileList | null, mode: 'offline' | 'session') => {
      if (!fileList || fileList.length === 0) return

      setSettingsOpen(false)
      setStatusMessage('')

      const files = Array.from(fileList)
      setImportProgress({
        completed: 0,
        total: files.length,
        label: mode === 'session' ? 'Loading for this session' : 'Importing',
      })

      if (mode === 'session') {
        const sessionTracks: TrackSummary[] = []
        const sessionBlobs = new Map<string, Blob>()

        let completed = 0
        const total = files.length

        for (const file of files) {
          const track = await buildTrackFromFile(file, {
            source: 'session',
          })
          sessionTracks.push(track)
          sessionBlobs.set(track.id, track.blob)
          completed += 1
          setImportProgress({ completed, total, label: 'Loading for this session' })
        }

        sessionBlobsRef.current = sessionBlobs
        setTracks(sessionTracks)
        setLibraryMode('session')
        setImportProgress(null)
        setStatusMessage(
          sessionTracks.length === 0
            ? 'No audio files found in that selection.'
            : `Loaded ${sessionTracks.length} track${sessionTracks.length === 1 ? '' : 's'} for this session.`,
        )
        return
      }

      const newTracks = await importAudioFiles(files, (completed, total) => {
        setImportProgress({ completed, total, label: 'Importing' })
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
    setSettingsOpen(false)
    await deleteAllTracks()
    sessionBlobsRef.current = new Map()
    setTracks([])
    setLibraryMode('offline')
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

  const setFavorite = useCallback(
    async (id: string, favorite: boolean) => {
      if (libraryMode === 'session') {
        setTracks((prev) =>
          prev.map((t) => (t.id === id ? { ...t, favorite } : t)),
        )
        return
      }

      const updated = await updateTrack(id, (track) => ({ ...track, favorite }))
      if (!updated) return

      setTracks((prev) => prev.map((t) => (t.id === id ? updated : t)))
    },
    [libraryMode],
  )

  const toggleFavorite = useCallback(
    (track: TrackSummary) => {
      setFavorite(track.id, !track.favorite).catch(() => undefined)
    },
    [setFavorite],
  )

  const handleDeleteTrack = useCallback(
    async (track: TrackSummary) => {
      const confirmed = window.confirm(`Delete "${track.title}"?`)
      if (!confirmed) return

      if (libraryMode === 'session') {
        sessionBlobsRef.current.delete(track.id)
      } else {
        await deleteTrack(track.id)
      }

      setTracks((prev) => prev.filter((t) => t.id !== track.id))
      setQueueIds((prev) => prev.filter((id) => id !== track.id))

      if (currentId === track.id) {
        setCurrentId(null)
        setIsPlaying(false)
        setCurrentTime(0)
        setCurrentDuration(0)

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
      }

      refreshStorageEstimate().catch(() => undefined)
    },
    [currentId, libraryMode, refreshStorageEstimate],
  )

  const loadTrackIntoAudio = useCallback(
    async (id: string) => {
      const sessionBlob = sessionBlobsRef.current.get(id)
      const blob = sessionBlob ?? (await getTrackBlob(id))
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

      if (pendingPlayRef.current) {
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
    [],
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
      if (shuffleOn) {
        const nextId = pickRandomNextId()
        if (nextId) {
          pendingPlayRef.current = true
          setCurrentId(nextId)
          return
        }
      } else if (canGoNext) {
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
  }, [canGoNext, currentIndex, pickRandomNextId, queueIds, shuffleOn])

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
    const nextId = shuffleOn ? pickRandomNextId() : queueIds[currentIndex + 1]
    if (!nextId) return
    pendingPlayRef.current = isPlaying
    setCurrentId(nextId)
  }, [currentIndex, isPlaying, pickRandomNextId, queueIds, shuffleOn])

  const goPrev = useCallback(() => {
    const prevId = shuffleOn ? pickRandomNextId() : queueIds[currentIndex - 1]
    if (!prevId) return
    pendingPlayRef.current = isPlaying
    setCurrentId(prevId)
  }, [currentIndex, isPlaying, pickRandomNextId, queueIds, shuffleOn])

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

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const startLongPress = useCallback(
    (track: TrackSummary) => {
      longPressTriggeredRef.current = false
      clearLongPressTimer()

      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true
        handleDeleteTrack(track).catch(() => undefined)
      }, 650)
    },
    [clearLongPressTimer, handleDeleteTrack],
  )

  const endLongPress = useCallback(() => {
    clearLongPressTimer()
  }, [clearLongPressTimer])

  const activeCount =
    tab === 'albums' && !selectedAlbumFolder ? embeddedAlbums.length : filteredTracks.length
  const totalCount = tracks.length

  return (
    <div className="app">
      <audio ref={audioRef} />

      <header className="app__header">
        <div className="app__top">
          <div className="app__brand">
            <h1 className="app__title">Music App</h1>
          </div>
          <div className="settings">
            <button
              className={`icon-btn settings__btn ${settingsOpen ? 'settings__btn--active' : ''}`}
              type="button"
              onClick={() => setSettingsOpen((prev) => !prev)}
              aria-expanded={settingsOpen}
              aria-controls="settings-menu"
              aria-label="Settings"
              title="Settings"
            >
              <img src="/icons/settings.png" alt="" className="icon-img" aria-hidden="true" />
            </button>

            {settingsOpen && (
              <div id="settings-menu" className="settings__menu" role="menu">
                <div className="settings__meta">
                  <span className="pill">
                    Showing {activeCount} / {totalCount}
                  </span>
                  {storageEstimate && (
                    <span className="pill">
                      Storage {storageEstimate.usedMB.toFixed(0)} / {storageEstimate.quotaMB.toFixed(0)} MB
                    </span>
                  )}
                </div>

                <div className="settings__actions">
                  <button className="btn btn--primary" onClick={openFolderPicker} role="menuitem">
                    Import Folder
                  </button>
                  <button className="btn" onClick={openFilePicker} role="menuitem">
                    Import Songs
                  </button>
                  <button className="btn btn--ghost" onClick={clearLibrary} role="menuitem">
                    Clear Library
                  </button>
                </div>

                <input
                  ref={folderInputRef}
                  className="sr-only"
                  type="file"
                  accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac"
                  multiple
                  onChange={(e) => handleImport(e.target.files, 'offline').catch(() => undefined)}
                  {...({ webkitdirectory: '' } as Record<string, string>)}
                  {...({ directory: '' } as Record<string, string>)}
                />

                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac"
                  multiple
                  onChange={(e) => handleImport(e.target.files, 'offline').catch(() => undefined)}
                />

              </div>
            )}
          </div>
        </div>

        

        <div className="app__center">
          <div className="tabs-group">
            <div className="app__tabs" role="tablist" aria-label="Library Tabs">
              <button
                className={`tab ${tab === 'library' ? 'tab--active' : ''}`}
                onClick={() => {
                  setTab('library')
                  setSelectedAlbumFolder(null)
                }}
                role="tab"
                aria-selected={tab === 'library'}
              >
                Library
              </button>
              <button
                className={`tab ${tab === 'favorites' ? 'tab--active' : ''}`}
                onClick={() => {
                  setTab('favorites')
                  setSelectedAlbumFolder(null)
                }}
                role="tab"
                aria-selected={tab === 'favorites'}
              >
                Favorites
              </button>
              <button
                className={`tab ${tab === 'albums' ? 'tab--active' : ''}`}
                onClick={() => {
                  setTab('albums')
                  setSelectedAlbumFolder(null)
                }}
                role="tab"
                aria-selected={tab === 'albums'}
              >
                Albums
              </button>
            </div>

            <button
              className={`icon-btn toggle-btn ${searchOpen ? 'toggle-btn--active' : ''}`}
              type="button"
              onClick={() => setSearchOpen((prev) => !prev)}
              aria-expanded={searchOpen}
              aria-controls="search-panel"
              aria-label="Toggle search and filter"
              title="Search and Filter"
            >
              <svg
                className="toggle-btn__icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M4 6h16l-6.8 7.4v4.8l-2.4-1.4v-3.4L4 6z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <section className="player player--top">
          <div className="player__now">
            <div className="player__meta">
              <div className="player__title">{currentTrack?.title ?? 'Nothing playing'}</div>
            </div>
          </div>

          <div className="player__controls">
            <div className="player__buttons">
              <button
                className={`icon-btn shuffle-btn ${shuffleOn ? 'shuffle-btn--active' : ''}`}
                onClick={() => setShuffleOn((prev) => !prev)}
                aria-pressed={shuffleOn}
                aria-label={shuffleOn ? 'Shuffle on' : 'Shuffle off'}
                title={shuffleOn ? 'Shuffle on' : 'Shuffle off'}
              >
                <img src="/icons/shuffle.png" alt="" className="icon-img" aria-hidden="true" />
              </button>
              <div className="player__main-controls">
                <button className="icon-btn" onClick={goPrev} disabled={prevDisabled} aria-label="Previous">
                  <img src="/icons/backward-arrow.png" alt="" className="icon-img" aria-hidden="true" />
                </button>
                <button className="icon-btn icon-btn--play" onClick={togglePlayPause} aria-label={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? 'Pause' : 'Play'}
                </button>
                <button className="icon-btn" onClick={goNext} disabled={nextDisabled} aria-label="Next">
                  <img src="/icons/next.png" alt="" className="icon-img" aria-hidden="true" />
                </button>
              </div>
              <button
                className={`icon-btn favorite-btn ${currentTrack?.favorite ? 'favorite-btn--active' : ''}`}
                onClick={() => currentTrack && toggleFavorite(currentTrack)}
                disabled={!currentTrack}
                aria-label={currentTrack?.favorite ? 'Remove from favorites' : 'Add to favorites'}
                title={currentTrack?.favorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <img
                  src={currentTrack?.favorite ? '/icons/filled-heart.png' : '/icons/heart.png'}
                  alt=""
                  className="icon-img icon-img--large"
                  aria-hidden="true"
                />
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
        </section>

      {(importProgress || statusMessage) && (
        <section className="panel panel--status">
          {importProgress && (
            <div className="progress">
              <div className="progress__meta">
                <span className="pill">
                  {(importProgress.label ?? 'Importing')} {importProgress.completed} /{' '}
                  {importProgress.total}
                </span>
              </div>
              <div className="progress__track">
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
              </div>
            </div>
          )}
          {statusMessage && <div className="status">{statusMessage}</div>}
        </section>
      )}

      {searchOpen && (
        <section id="search-panel" className="panel panel--controls">
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
      )}

      {tab === 'albums' && selectedAlbum && (
        <section className="panel panel--albums">
          <button
            className="btn btn--ghost"
            type="button"
            onClick={() => setSelectedAlbumFolder(null)}
          >
            ← All Albums
          </button>
          <span className="pill">
            {selectedAlbum.name} · {selectedAlbum.count} song
            {selectedAlbum.count === 1 ? '' : 's'}
          </span>
        </section>
      )}

      <main className="library" aria-live="polite">
        {tab === 'albums' && !selectedAlbum ? (
          <div className="albums">
            {embeddedAlbums.length === 0 ? (
              <div className="empty">
                <div className="empty__title">No albums yet</div>
                <div className="empty__text">
                  Add folders inside public/songs and run generate:songs.
                </div>
              </div>
            ) : (
              <ul className="album-list">
                {embeddedAlbums.map((album) => (
                  <li key={album.folder} className="album">
                    <button
                      className="album__btn"
                      type="button"
                      onClick={() => {
                        setTab('albums')
                        setSelectedAlbumFolder(album.folder)
                      }}
                    >
                      <div className="album__name" title={album.name}>
                        {album.name}
                      </div>
                      <div className="album__meta">
                        <span>{album.count} song{album.count === 1 ? '' : 's'}</span>
                        <span className="album__folder">{album.folder}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : filteredTracks.length === 0 ? (
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
                  <button
                    className="track__main"
                    onPointerDown={() => startLongPress(track)}
                    onPointerUp={endLongPress}
                    onPointerLeave={endLongPress}
                    onPointerCancel={endLongPress}
                    onClick={() => {
                      if (longPressTriggeredRef.current) {
                        longPressTriggeredRef.current = false
                        return
                      }
                      playFromVisible(track)
                    }}
                    title="Tap to play. Press and hold to delete."
                  >
                    <div className="track__meta">
                      <div className="track__title" title={track.title}>
                        {track.title}
                      </div>
                    </div>

                    <div className="track__right">
                      <div className="track__stats">
                        <span className="track__duration">{formatTime(track.duration)}</span>
                        <span className="track__added">
                          {new Date(track.addedAt).toLocaleDateString()}
                        </span>
                      </div>

                      <button
                        className={`icon-btn track__favorite ${track.favorite ? 'icon-btn--favorite' : ''}`}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          toggleFavorite(track)
                        }}
                        aria-label={track.favorite ? 'Remove from favorites' : 'Add to favorites'}
                        title={track.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      >
                        <img
                          src={track.favorite ? '/icons/filled-heart.png' : '/icons/heart.png'}
                          alt=""
                          className="icon-img icon-img--small"
                          aria-hidden="true"
                        />
                      </button>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </main>

    </div>
  )
}

export default App

