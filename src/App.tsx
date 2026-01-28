import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type { TabKey, TrackSummary } from './types'
import {
  deleteAllTracks,
  deleteTrack,
  addDeletedEntry,
  getAllTrackSummaries,
  getDeletedEntries,
  getDeletedKeys,
  getFavoriteKeys,
  getTrackBlob,
  removeDeletedKey,
  setFavoriteKey,
  updateTrack,
  upsertTracks,
} from './lib/db'
import { syncEmbeddedSongs } from './lib/embedded'
import { buildSourceKeyFromFile, buildTrackFromFile, importAudioFiles } from './lib/metadata'

type ImportProgress = {
  completed: number
  total: number
  label?: string
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const totalSeconds = Math.floor(seconds)
  const mins = Math.floor(totalSeconds / 60)
  const secs = totalSeconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function stripExtension(filename: string) {
  const dotIndex = filename.lastIndexOf('.')
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename
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
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [deletedOpen, setDeletedOpen] = useState(false)
  const [deletedEntries, setDeletedEntries] = useState<
    Array<{
      key: string
      deletedAt: number
      title?: string
      artist?: string
      album?: string
      folder?: string
      filename?: string
    }>
  >([])
  const [albumConfirm, setAlbumConfirm] = useState<{
    folder: string
    name: string
    count: number
    tracks: TrackSummary[]
  } | null>(null)

  const [queueIds, setQueueIds] = useState<string[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [currentDuration, setCurrentDuration] = useState(0)
  const [shuffleOn, setShuffleOn] = useState(false)
  const [titleMarquee, setTitleMarquee] = useState(false)
  const [titleShift, setTitleShift] = useState(0)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const titleRef = useRef<HTMLDivElement | null>(null)
  const currentObjectUrlRef = useRef<string | null>(null)
  const pendingPlayRef = useRef(false)
  const longPressTimerRef = useRef<number | null>(null)
  const longPressTriggeredRef = useRef(false)
  const albumLongPressTimerRef = useRef<number | null>(null)
  const albumLongPressTriggeredRef = useRef(false)
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
    }, 0)
    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [statusMessage])

  useEffect(() => {
    if (deletedOpen || albumConfirm) {
      document.body.classList.add('no-scroll')
      return
    }
    document.body.classList.remove('no-scroll')
  }, [deletedOpen, albumConfirm])

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
      const fields = [
        track.title,
        track.artist,
        track.album,
        track.folder,
        track.filename,
      ]

      return fields.join(' ').toLowerCase().includes(loweredSearch)
    }

    return defaultSort(base.filter(matches))
  }, [tracks, tab, selectedAlbum, search])

  const deletedGroups = useMemo(() => {
    const groups = new Map<string, typeof deletedEntries>()

    const parseFolder = (entry: (typeof deletedEntries)[number]) => {
      if (entry.folder) return entry.folder
      if (entry.key.startsWith('file:')) {
        const trimmed = entry.key.slice('file:'.length)
        const sepIndex = trimmed.lastIndexOf('|')
        if (sepIndex > 0) return trimmed.slice(0, sepIndex)
      }
      if (entry.key.startsWith('embedded:')) return 'Embedded'
      return 'Imported'
    }

    const parseFilename = (entry: (typeof deletedEntries)[number]) => {
      if (entry.filename) return entry.filename
      if (entry.key.startsWith('file:')) {
        const trimmed = entry.key.slice('file:'.length)
        const sepIndex = trimmed.lastIndexOf('|')
        if (sepIndex >= 0) return trimmed.slice(sepIndex + 1)
      }
      return entry.key
    }

    for (const entry of deletedEntries) {
      const folder = parseFolder(entry)
      const filename = parseFilename(entry)
      const list = groups.get(folder) ?? []
      list.push({ ...entry, filename, folder })
      groups.set(folder, list)
    }

    return Array.from(groups.entries()).map(([folder, entries]) => ({
      folder,
      entries,
    }))
  }, [deletedEntries])

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
      const deletedKeys = await getDeletedKeys()
      const favoriteKeys = await getFavoriteKeys()
      const existingSummaries = await getAllTrackSummaries()
      const existingByKey = new Map<string, { id: string; addedAt: number; favorite: boolean }>()
      for (const track of existingSummaries) {
        if (track.sourceKey) {
          existingByKey.set(track.sourceKey, {
            id: track.id,
            addedAt: track.addedAt,
            favorite: track.favorite,
          })
        }
      }
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

        const seenKeys = new Set<string>()
        for (const file of files) {
          const sourceKey = buildSourceKeyFromFile(file)
          if (seenKeys.has(sourceKey)) {
            completed += 1
            setImportProgress({ completed, total, label: 'Loading for this session' })
            continue
          }
          seenKeys.add(sourceKey)
          if (deletedKeys.has(sourceKey)) {
            completed += 1
            setImportProgress({ completed, total, label: 'Loading for this session' })
            continue
          }
          const track = await buildTrackFromFile(file, {
            source: 'session',
            sourceKey,
            favorite:
              favoriteKeys.has(sourceKey) || existingByKey.get(sourceKey)?.favorite || false,
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

      const newTracks = await importAudioFiles(
        files,
        (completed, total) => {
          setImportProgress({ completed, total, label: 'Importing' })
        },
        { deletedKeys, existingByKey, favoriteKeys },
      )

      for (const track of newTracks) {
        if (track.sourceKey && favoriteKeys.has(track.sourceKey)) {
          track.favorite = true
        }
      }

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
    setImportOpen(false)
    folderInputRef.current?.click()
  }, [])

  const openFilePicker = useCallback(() => {
    setImportOpen(false)
    fileInputRef.current?.click()
  }, [])

  const clearLibrary = useCallback(async () => {
    const confirmed = window.confirm('Clear your entire library? This cannot be undone.')
    if (!confirmed) return
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
      const track = tracks.find((t) => t.id === id)
      if (track?.sourceKey) {
        await setFavoriteKey(track.sourceKey, favorite)
      }
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
    [libraryMode, tracks],
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

      const sourceKey = track.sourceKey || `file:${track.folder}|${track.filename}`
      await addDeletedEntry({
        key: sourceKey,
        title: track.title,
        artist: track.artist,
        album: track.album,
        folder: track.folder,
        filename: track.filename,
      })

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

  const toggleDeletedList = useCallback(async () => {
    setDeletedOpen((prev) => !prev)
    if (!deletedOpen) {
      const entries = await getDeletedEntries()
      setDeletedEntries(
        [...entries].sort((a, b) => b.deletedAt - a.deletedAt),
      )
    }
  }, [deletedOpen])

  const restoreDeletedEntry = useCallback(async (key: string) => {
    await removeDeletedKey(key)
    setDeletedEntries((prev) => prev.filter((entry) => entry.key !== key))
  }, [])

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
    const el = titleRef.current
    if (!el) return
    const update = () => {
      const overflow = el.scrollWidth - el.clientWidth
      setTitleMarquee(overflow > 0)
      setTitleShift(overflow > 0 ? overflow : 0)
    }
    update()
    const handleResize = () => update()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [currentTrack?.title])

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

  const ensurePlay = useCallback(() => {
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

    setIsPlaying(true)
    audio.play().catch(() => {
      setIsPlaying(false)
    })
  }, [currentId, filteredTracks, playTrack])

  const ensurePause = useCallback(() => {
    const audio = audioRef.current
    audio?.pause()
    setIsPlaying(false)
  }, [])

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

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const mediaSession = navigator.mediaSession

    try {
      mediaSession.metadata = currentTrack
        ? new MediaMetadata({
            title: currentTrack.title || 'Unknown title',
            artist: currentTrack.artist || 'Unknown artist',
            album: currentTrack.album || '',
            artwork: currentTrack.artUrl ? [{ src: currentTrack.artUrl }] : [],
          })
        : null
    } catch {
      // Ignore metadata errors on unsupported platforms.
    }
  }, [currentTrack])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const mediaSession = navigator.mediaSession

    try {
      if (!currentTrack) {
        mediaSession.playbackState = 'none'
      } else {
        mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
      }
    } catch {
      // Ignore playbackState errors on unsupported platforms.
    }
  }, [currentTrack, isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const mediaSession = navigator.mediaSession
    const setHandler = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        mediaSession.setActionHandler(action, handler)
      } catch {
        // Ignore unsupported action handlers.
      }
    }

    setHandler('play', ensurePlay)
    setHandler('pause', ensurePause)
    setHandler('previoustrack', goPrev)
    setHandler('nexttrack', goNext)
    setHandler('seekto', (details) => {
      if (typeof details?.seekTime !== 'number') return
      seekTo(details.seekTime)
    })
    setHandler('seekbackward', null)
    setHandler('seekforward', null)
    setHandler('stop', ensurePause)

    return () => {
      setHandler('play', null)
      setHandler('pause', null)
      setHandler('previoustrack', null)
      setHandler('nexttrack', null)
      setHandler('seekto', null)
      setHandler('seekbackward', null)
      setHandler('seekforward', null)
      setHandler('stop', null)
    }
  }, [ensurePause, ensurePlay, goNext, goPrev, seekTo])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const mediaSession = navigator.mediaSession
    if (!mediaSession.setPositionState) return
    try {
      if (!currentTrack || !Number.isFinite(currentDuration) || currentDuration <= 0) {
        mediaSession.setPositionState({
          duration: 0,
          playbackRate: 1,
          position: 0,
        })
        return
      }

      const audio = audioRef.current
      const playbackRate = audio?.playbackRate ?? 1
      const position = Math.min(Math.max(currentTime, 0), currentDuration)

      mediaSession.setPositionState({
        duration: currentDuration,
        playbackRate,
        position,
      })
    } catch {
      // Ignore position state errors on unsupported platforms.
    }
  }, [currentDuration, currentTime, currentTrack])

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

  const clearAlbumLongPressTimer = useCallback(() => {
    if (albumLongPressTimerRef.current !== null) {
      window.clearTimeout(albumLongPressTimerRef.current)
      albumLongPressTimerRef.current = null
    }
  }, [])

  const startAlbumLongPress = useCallback(
    (album: { folder: string; name: string; count: number; tracks: TrackSummary[] }) => {
      albumLongPressTriggeredRef.current = false
      clearAlbumLongPressTimer()

      albumLongPressTimerRef.current = window.setTimeout(() => {
        albumLongPressTriggeredRef.current = true
        setAlbumConfirm(album)
      }, 650)
    },
    [clearAlbumLongPressTimer],
  )

  const endAlbumLongPress = useCallback(() => {
    clearAlbumLongPressTimer()
  }, [clearAlbumLongPressTimer])

  const confirmRemoveAlbum = useCallback(async () => {
    if (!albumConfirm) return
    const removedIds = new Set(albumConfirm.tracks.map((track) => track.id))

    if (libraryMode === 'session') {
      albumConfirm.tracks.forEach((track) => {
        sessionBlobsRef.current.delete(track.id)
      })
    } else {
      for (const track of albumConfirm.tracks) {
        await deleteTrack(track.id)
      }
    }

    setTracks((prev) => prev.filter((track) => !removedIds.has(track.id)))
    setQueueIds((prev) => prev.filter((id) => !removedIds.has(id)))

    if (currentId && removedIds.has(currentId)) {
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

    if (tab === 'albums' && selectedAlbumFolder === albumConfirm.folder) {
      setSelectedAlbumFolder(null)
    }

    refreshStorageEstimate().catch(() => undefined)
    setAlbumConfirm(null)
  }, [
    albumConfirm,
    currentId,
    libraryMode,
    refreshStorageEstimate,
    selectedAlbumFolder,
    tab,
  ])

  const activeCount =
    tab === 'albums' && !selectedAlbumFolder ? embeddedAlbums.length : filteredTracks.length
  const totalCount = tracks.length


  return (
    <div className="app">
      <audio ref={audioRef} />

      <header className="app__header">
        <div className="app__top">
          <div className="app__brand">
            <h1 className="app__title">My Music</h1>
          </div>
          <div className="header-actions">
            <button
              className={`icon-btn search-toggle ${searchOpen ? 'search-toggle--active' : ''}`}
              type="button"
              onClick={() => setSearchOpen((prev) => !prev)}
              aria-expanded={searchOpen}
              aria-controls="search-panel"
              aria-label="Toggle search"
              title="Search"
            >
              <svg className="search-toggle__icon" viewBox="0 0 24 24" focusable="false">
                <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M20 20l-3.8-3.8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <div className="import">
              <button
                className={`icon-btn import__btn ${importOpen ? 'import__btn--active' : ''}`}
                type="button"
                onClick={() => {
                  setImportOpen((prev) => !prev)
                  setSettingsOpen(false)
                }}
                aria-expanded={importOpen}
                aria-controls="import-menu"
                aria-label="Import"
                title="Import"
              >
                <svg className="import__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    d="M12 3v10m0 0l-4-4m4 4l4-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {importOpen && (
                <>
                  <button
                    className="import__backdrop"
                    type="button"
                    onClick={() => setImportOpen(false)}
                    aria-label="Close import menu"
                  />
                  <div id="import-menu" className="import__menu" role="menu">
                    <button
                      className="import-card"
                      onClick={openFolderPicker}
                      role="menuitem"
                      type="button"
                    >
                      <div className="import-card__icon">
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path
                            d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                      <div className="import-card__content">
                        <div className="import-card__title">Import Folder</div>
                        <div className="import-card__meta">Load all songs in a folder</div>
                      </div>
                    </button>
                    <button
                      className="import-card"
                      onClick={openFilePicker}
                      role="menuitem"
                      type="button"
                    >
                      <div className="import-card__icon">
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path
                            d="M9 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M10 9h4m-4 4h4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                      <div className="import-card__content">
                        <div className="import-card__title">Import Songs</div>
                        <div className="import-card__meta">Pick individual files</div>
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="settings">
              <button
                className={`icon-btn settings__btn ${settingsOpen ? 'settings__btn--active' : ''}`}
                type="button"
                onClick={() => {
                  setSettingsOpen((prev) => !prev)
                  setImportOpen(false)
                }}
                aria-expanded={settingsOpen}
                aria-controls="settings-menu"
                aria-label="Settings"
                title="Settings"
              >
                <img src="/icons/settings.png" alt="" className="icon-img" aria-hidden="true" />
              </button>

              {settingsOpen && (
                <>
                  <button
                    className="settings__backdrop"
                    type="button"
                    onClick={() => setSettingsOpen(false)}
                    aria-label="Close settings"
                  />
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
                      <button className="btn btn--ghost" onClick={clearLibrary} role="menuitem">
                        Clear Library
                      </button>
                      <button className="btn" onClick={toggleDeletedList} role="menuitem">
                        Show Deleted Songs
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

      </header>

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

      <section className="player player--top">
          <div className="player__now">
            <div className="player__meta">
              <div
                ref={titleRef}
                className={`player__title ${titleMarquee ? 'marquee' : ''}`}
                style={
                  titleMarquee
                    ? ({ '--marquee-shift': `-${titleShift}px` } as React.CSSProperties)
                    : undefined
                }
              >
                <span key={currentTrack?.id ?? 'none'}>
                  {currentTrack ? stripExtension(currentTrack.filename) : 'Nothing playing'}
                </span>
              </div>
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
        <section id="search-panel" className="search-panel">
          <div className="controls">
            <label className="field field--search">
              <div className="search-shell">
                <input
                  className="search-shell__input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search your library..."
                />
                {search && (
                  <button
                    type="button"
                    className="search-shell__clear"
                    onClick={() => setSearch('')}
                    aria-label="Clear search"
                    title="Clear search"
                  >
                    ×
                  </button>
                )}
              </div>
            </label>
          </div>
        </section>
      )}

      {deletedOpen && (
        <div className="deleted-modal deleted-modal--full" role="dialog" aria-modal="true">
          <button
            className="deleted-modal__backdrop"
            type="button"
            onClick={() => setDeletedOpen(false)}
            aria-label="Close deleted songs list"
          />
          <div className="deleted-modal__content">
            <div className="deleted-modal__header">
              <h2 className="deleted-modal__title">Deleted Songs</h2>
              <div className="deleted-modal__actions">
                <button
                  className="btn btn--ghost"
                  type="button"
                  onClick={() => {
                    const confirmed = window.confirm(
                      'Clear this deleted list view? This does not restore songs.',
                    )
                    if (!confirmed) return
                    setDeletedEntries([])
                  }}
                >
                  Clear List
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => setDeletedOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
            <div className="deleted-list__container">
              {deletedEntries.length === 0 ? (
                <div className="deleted-list__empty">No deleted songs yet.</div>
              ) : (
                <div className="deleted-groups">
                  {deletedGroups.map((group) => (
                    <div key={group.folder} className="deleted-group">
                      <div className="deleted-group__title">{group.folder}</div>
                      <ul className="deleted-list__items">
                        {group.entries.map((entry) => (
                          <li key={entry.key} className="deleted-list__item">
                            <div className="deleted-list__row">
                              <div className="deleted-list__info">
                                <div className="deleted-list__file">
                                  {entry.filename || 'Unknown file'}
                                </div>
                              </div>
                              <button
                                className="deleted-list__restore"
                                type="button"
                                onClick={() => restoreDeletedEntry(entry.key)}
                                aria-label="Restore song"
                                title="Restore"
                              >
                                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                  <path
                                    d="M3 12a9 9 0 1 0 3-6.7"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                  <path
                                    d="M3 4v4h4"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {albumConfirm && (
        <div className="deleted-modal deleted-modal--compact" role="dialog" aria-modal="true">
          <button
            className="deleted-modal__backdrop"
            type="button"
            onClick={() => setAlbumConfirm(null)}
            aria-label="Cancel album removal"
          />
          <div className="deleted-modal__content">
            <div className="deleted-modal__header deleted-modal__header--stacked">
              <h2 className="deleted-modal__title">Remove album?</h2>
              <div className="deleted-modal__actions">
                <button className="btn" type="button" onClick={() => setAlbumConfirm(null)}>
                  Cancel
                </button>
                <button className="btn btn--ghost" type="button" onClick={confirmRemoveAlbum}>
                  Remove Album
                </button>
              </div>
            </div>
            <div className="deleted-list__empty deleted-list__note">
              This will remove “{albumConfirm.name}” and its {albumConfirm.count}{' '}
              {albumConfirm.count === 1 ? 'song' : 'songs'} from the app.
            </div>
          </div>
        </div>
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
                      onPointerDown={() => startAlbumLongPress(album)}
                      onPointerUp={endAlbumLongPress}
                      onPointerLeave={endAlbumLongPress}
                      onPointerCancel={endAlbumLongPress}
                      onClick={() => {
                        if (albumLongPressTriggeredRef.current) {
                          albumLongPressTriggeredRef.current = false
                          return
                        }
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
                      <div className="track__title" title={track.filename}>
                        {stripExtension(track.filename)}
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

      <div className="tabs-dock">
        <div className="tabs-group">
          <div className="app__tabs" role="tablist" aria-label="Library Tabs">
            <input
              type="radio"
              name="library-tabs"
              id="tab-library"
              className="tab-input"
              checked={tab === 'library'}
              onChange={() => {
                setTab('library')
                setSelectedAlbumFolder(null)
              }}
            />
            <label
              htmlFor="tab-library"
              className="tab"
              role="tab"
              aria-selected={tab === 'library'}
            >
              Library
            </label>

            <input
              type="radio"
              name="library-tabs"
              id="tab-favorites"
              className="tab-input"
              checked={tab === 'favorites'}
              onChange={() => {
                setTab('favorites')
                setSelectedAlbumFolder(null)
              }}
            />
            <label
              htmlFor="tab-favorites"
              className="tab"
              role="tab"
              aria-selected={tab === 'favorites'}
            >
              Favorites
            </label>

            <input
              type="radio"
              name="library-tabs"
              id="tab-albums"
              className="tab-input"
              checked={tab === 'albums'}
              onChange={() => {
                setTab('albums')
                setSelectedAlbumFolder(null)
              }}
            />
            <label
              htmlFor="tab-albums"
              className="tab"
              role="tab"
              aria-selected={tab === 'albums'}
            >
              Albums
            </label>
          </div>
        </div>
      </div>

    </div>
  )
}

export default App

