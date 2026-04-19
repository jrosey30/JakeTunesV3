import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useLibrary } from '../context/LibraryContext'
import { useAudio } from '../hooks/useAudio'
import { Track, MetadataIssue, ChatConversation, RestoreScanResult, RestoreApplyResult, RestoreDiff } from '../types'
import musicmanAvatar from '../assets/musicman-avatar.png'
import '../styles/musicman.css'

const TAGLINES = [
  "I was into that before it was cool. And after. Because it's always been cool.",
  "You probably haven't heard of my favorite band. That's kind of the point.",
  "I don't have guilty pleasures. I have correct opinions.",
  "My taste is an acquired taste. You just haven't acquired it yet.",
  "I liked their early stuff. Before they got listenable.",
  "Streaming killed the record store. I'm what's left.",
  "I judge people by their record collections. Yours needs work.",
  "The algorithm could never do what I do. It lacks contempt.",
  "I only listen to vinyl. And cassette. And reel-to-reel. Fine, and MP3. But I hate it.",
  "I've forgotten more B-sides than you've heard A-sides.",
  "My recommendations come with a side of unsolicited opinions.",
  "If you have to ask what genre it is, you're not ready.",
  "I was streaming before streaming. It was called 'having friends with taste.'",
  "Every song I recommend is a gift. Most people don't deserve it.",
  "I don't gatekeep music. I quality-control it.",
  "You like what you like. I like what's actually good.",
  "The mainstream is a river. I'm the ocean.",
  "I've never skipped a track in my life. Unlike some people.",
  "My playlists have playlists.",
  "I peaked musically in 2003. So did everyone else. They just don't know it.",
  "If it's on TikTok, I liked it three years ago.",
  "I don't do shuffle. Music has an order. Respect it.",
  "The best album of all time changes daily. Only I know which one it is today.",
  "I have a vinyl for every mood. Including this one: disappointed.",
  "I'm not pretentious. I'm precise.",
  "Support your local record store. Specifically, mine.",
  "The only thing I stream is consciousness.",
  "You call it obscure. I call it essential.",
  "I was doing crate digging before you were doing anything.",
  "My ears are insured. Emotionally, not financially.",
  "I don't have a type. I have range. You wouldn't understand.",
]

const CHAT_INTROS = [
  "Look, I don't just listen to music. I understand it. I've forgotten more about obscure B-sides than most people will ever know. Go ahead. Ask me something. But fair warning — I might judge your taste.",
  "Oh good, another person who wants my opinion. Lucky for you, my opinions are correct. Ask away — but don't waste my time with anything you could Google.",
  "You want to talk music? Finally, someone with ambition. Most people just press shuffle and call it a personality. What do you want to know?",
  "Welcome to the only conversation about music that matters today. I've been waiting for someone to ask me something worth answering. No pressure.",
  "I could be organizing my vinyl right now, but sure, let's chat. Ask me anything. I promise to be honest. Brutally, if necessary.",
  "You've come to the right place. Or the wrong place, depending on how attached you are to your current opinions. What's on your mind?",
  "Before you ask — yes, I've heard it. Yes, I have thoughts. And yes, they're better than yours. Go ahead.",
  "I've spent more time in record stores than most people spend awake. That expertise is now available to you. You're welcome. Ask.",
  "Another day, another chance to educate someone about music. I don't do this for the gratitude. I do it because someone has to. What do you need?",
  "Sure, the internet exists. But the internet doesn't have taste. I do. Ask me something real.",
  "I was born for this. Literally — my first word was 'overrated.' Hit me with a question.",
  "Let's skip the small talk. You have questions. I have answers and a superiority complex. Let's go.",
  "Most music advice is bad. Mine isn't. That's not arrogance, it's a track record. What do you want to know?",
  "I've been told I'm 'a lot.' I prefer 'thorough.' Ask me anything about music — I dare you to stump me.",
]

const TABS = ['Ask Me Anything', 'Recommendations', 'Build a Playlist', 'Organize Library', 'Fix Metadata'] as const
type Tab = typeof TABS[number]

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface PlaylistResult {
  name: string
  commentary: string
  tracks: Track[]
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return ''
  const totalSecs = Math.floor(ms / 1000)
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

interface Recommendation {
  title: string
  artist: string
  year?: number
  genre: string
  source: string
  why: string
  artUrl?: string
}

export default function MusicManView() {
  const { state: libState, dispatch } = useLibrary()
  const { playTrack } = useAudio()
  const [activeTab, setActiveTab] = useState<Tab>('Ask Me Anything')
  const [chatInput, setChatInput] = useState('')
  const [playlistInput, setPlaylistInput] = useState('')
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speakingIdx, setSpeakingIdx] = useState(-1)
  const [speakingCommentary, setSpeakingCommentary] = useState(false)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [playlistResult, setPlaylistResult] = useState<PlaylistResult | null>(null)
  const [playlistSaved, setPlaylistSaved] = useState(false)
  const [metaScanning, setMetaScanning] = useState(false)
  const [metaIssues, setMetaIssues] = useState<MetadataIssue[]>([])
  const [metaFixed, setMetaFixed] = useState<Set<number>>(new Set())
  const [metaScanned, setMetaScanned] = useState(false)
  const [restoreXmlPath, setRestoreXmlPath] = useState<string | null>(null)
  const [restoreScan, setRestoreScan] = useState<RestoreScanResult | null>(null)
  const [restoreScanning, setRestoreScanning] = useState(false)
  const [restoreApplying, setRestoreApplying] = useState(false)
  const [restoreApplied, setRestoreApplied] = useState<RestoreApplyResult | null>(null)
  const [restoreApprovedIds, setRestoreApprovedIds] = useState<Set<number>>(new Set())
  const [restoreExpandedGroups, setRestoreExpandedGroups] = useState<Set<string>>(new Set())
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [artFetching, setArtFetching] = useState<Set<string>>(new Set())
  const [artProgress, setArtProgress] = useState<{ done: number; total: number } | null>(null)
  const [orgApplied, setOrgApplied] = useState<Set<string>>(new Set())
  const [recs, setRecs] = useState<Recommendation[]>([])
  const [recsLoading, setRecsLoading] = useState(false)
  const [recsLoaded, setRecsLoaded] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Load chat history on mount
  useEffect(() => {
    window.electronAPI.loadChatHistory().then(result => {
      if (result.ok && result.conversations) {
        setConversations(result.conversations)
      }
    })
  }, [])

  const saveConversations = useCallback((convs: ChatConversation[]) => {
    setConversations(convs)
    window.electronAPI.saveChatHistory(convs)
  }, [])

  const startNewChat = useCallback(() => {
    setActiveChatId(null)
    setMessages([])
    setChatInput('')
  }, [])

  const loadChat = useCallback((conv: ChatConversation) => {
    setActiveChatId(conv.id)
    setMessages(conv.messages)
  }, [])

  const deleteChat = useCallback((id: string) => {
    const updated = conversations.filter(c => c.id !== id)
    saveConversations(updated)
    if (activeChatId === id) {
      setActiveChatId(null)
      setMessages([])
    }
  }, [conversations, activeChatId, saveConversations])

  const sendMessage = async () => {
    const text = chatInput.trim()
    if (!text || isLoading) return
    setChatInput('')

    const newMessages: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setIsLoading(true)

    const result = await window.electronAPI.musicmanChat(newMessages)
    const finalMessages: ChatMessage[] = [...newMessages, { role: 'assistant', content: result.text }]
    setMessages(finalMessages)
    setIsLoading(false)

    // Auto-save to history
    const chatId = activeChatId || `chat-${Date.now()}`
    const title = newMessages[0]?.content.slice(0, 50) || 'Untitled'
    const existing = conversations.find(c => c.id === chatId)
    let updated: ChatConversation[]
    if (existing) {
      updated = conversations.map(c => c.id === chatId ? { ...c, messages: finalMessages } : c)
    } else {
      const newConv: ChatConversation = { id: chatId, title, messages: finalMessages, createdAt: new Date().toISOString() }
      updated = [newConv, ...conversations]
    }
    setActiveChatId(chatId)
    saveConversations(updated)
  }

  const speakMessage = async (text: string, index: number) => {
    if (isSpeaking && audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
      window.dispatchEvent(new Event('musicman-speaking-end'))
      if (speakingIdx === index) {
        setIsSpeaking(false)
        setSpeakingIdx(-1)
        return
      }
    }
    setIsSpeaking(true)
    setSpeakingIdx(index)
    const tts = await window.electronAPI.musicmanSpeak(text)
    if (tts.ok && tts.audio) {
      const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
      audioRef.current = audio
      audio.onended = () => {
        setIsSpeaking(false)
        setSpeakingIdx(-1)
        window.dispatchEvent(new Event('musicman-speaking-end'))
      }
      window.dispatchEvent(new Event('musicman-speaking-start'))
      audio.play().catch(() => {
        setIsSpeaking(false)
        setSpeakingIdx(-1)
        window.dispatchEvent(new Event('musicman-speaking-end'))
      })
    } else {
      setIsSpeaking(false)
      setSpeakingIdx(-1)
    }
  }

  const generatePlaylist = async () => {
    const mood = playlistInput.trim()
    if (!mood || playlistLoading) return
    setPlaylistLoading(true)
    setPlaylistResult(null)
    setPlaylistSaved(false)

    const compactTracks = libState.tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist,
      album: t.album, genre: t.genre, year: t.year
    }))

    const result = await window.electronAPI.musicmanPlaylist(mood, compactTracks)

    if (result.ok && result.trackIds) {
      const trackMap = new Map(libState.tracks.map(t => [t.id, t]))
      const playlistTracks = result.trackIds
        .map(id => trackMap.get(id))
        .filter((t): t is Track => t !== undefined)

      setPlaylistResult({
        name: result.name || 'Untitled',
        commentary: result.commentary || '',
        tracks: playlistTracks
      })
    }

    setPlaylistLoading(false)
  }

  const savePlaylist = useCallback(() => {
    if (!playlistResult || playlistSaved) return
    const id = `mm-${Date.now()}`
    dispatch({
      type: 'ADD_PLAYLIST',
      playlist: {
        id,
        name: playlistResult.name,
        trackIds: playlistResult.tracks.map(t => t.id),
        commentary: playlistResult.commentary,
      }
    })
    setPlaylistSaved(true)
  }, [playlistResult, playlistSaved, dispatch])

  const speakCommentary = useCallback(async () => {
    if (!playlistResult?.commentary) return
    if (speakingCommentary && audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
      setSpeakingCommentary(false)
      window.dispatchEvent(new Event('musicman-speaking-end'))
      return
    }
    setSpeakingCommentary(true)
    const tts = await window.electronAPI.musicmanSpeak(playlistResult.commentary)
    if (tts.ok && tts.audio) {
      const audio = new Audio(`data:audio/mpeg;base64,${tts.audio}`)
      audioRef.current = audio
      audio.onended = () => {
        setSpeakingCommentary(false)
        window.dispatchEvent(new Event('musicman-speaking-end'))
      }
      window.dispatchEvent(new Event('musicman-speaking-start'))
      audio.play().catch(() => {
        setSpeakingCommentary(false)
        window.dispatchEvent(new Event('musicman-speaking-end'))
      })
    } else {
      setSpeakingCommentary(false)
    }
  }, [playlistResult, speakingCommentary])

  const scanMetadata = useCallback(async () => {
    if (metaScanning) return
    setMetaScanning(true)
    setMetaIssues([])
    setMetaFixed(new Set())
    setMetaScanned(false)

    const compactTracks = libState.tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist,
      album: t.album, genre: t.genre, year: t.year
    }))

    const result = await window.electronAPI.musicmanScanMetadata(compactTracks)
    if (result.ok && result.issues) {
      setMetaIssues(result.issues as MetadataIssue[])
    }
    setMetaScanning(false)
    setMetaScanned(true)
  }, [metaScanning, libState.tracks])

  const applyFix = useCallback(async (issueIdx: number) => {
    const issue = metaIssues[issueIdx]
    if (!issue || !issue.suggested) return

    const allIds = [...issue.trackIds, ...(issue.altTrackIds || [])]
    const updates = allIds.map(id => ({
      id,
      field: issue.field,
      value: issue.suggested,
    }))
    dispatch({ type: 'UPDATE_TRACKS', updates })
    setMetaFixed(prev => new Set([...prev, issueIdx]))

    // Persist to disk — include a fingerprint so the override can be
    // validated on future loads. Track IDs aren't stable across re-parses
    // of the iTunesDB; without a fingerprint, an override for id=2963
    // silently re-targets whatever track ends up at 2963 next time.
    const trackMap = new Map(libState.tracks.map(t => [t.id, t]))
    for (const id of allIds) {
      const t = trackMap.get(id)
      const fp = t
        ? `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`
        : ''
      await window.electronAPI.saveMetadataOverride(id, issue.field, issue.suggested, fp)
    }
  }, [metaIssues, dispatch, libState.tracks])

  const restoreGroupedDiffs = useMemo(() => {
    if (!restoreScan) return []
    const byGroup = new Map<string, { album: string; artist: string; diffs: RestoreDiff[] }>()
    for (const d of restoreScan.diffs) {
      const existing = byGroup.get(d.groupKey)
      if (existing) {
        existing.diffs.push(d)
      } else {
        byGroup.set(d.groupKey, { album: d.groupAlbum, artist: d.groupArtist, diffs: [d] })
      }
    }
    return Array.from(byGroup.entries())
      .map(([key, val]) => ({ key, ...val }))
      .sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album))
  }, [restoreScan])

  const pickAndScanXml = useCallback(async () => {
    if (restoreScanning) return
    setRestoreError(null)
    setRestoreApplied(null)
    const picked = await window.electronAPI.restoreXmlPickFile()
    if (!picked.ok || !picked.path) return
    setRestoreXmlPath(picked.path)
    setRestoreScanning(true)
    setRestoreScan(null)
    const result = await window.electronAPI.restoreXmlScan(picked.path)
    setRestoreScanning(false)
    if (!result.ok || !result.data) {
      setRestoreError(result.error || 'Scan failed')
      return
    }
    setRestoreScan(result.data)
    // Default: everything approved
    setRestoreApprovedIds(new Set(result.data.diffs.map(d => d.id)))
    setRestoreExpandedGroups(new Set())
  }, [restoreScanning])

  const rescanXml = useCallback(async () => {
    if (!restoreXmlPath || restoreScanning) return
    setRestoreError(null)
    setRestoreApplied(null)
    setRestoreScanning(true)
    setRestoreScan(null)
    const result = await window.electronAPI.restoreXmlScan(restoreXmlPath)
    setRestoreScanning(false)
    if (!result.ok || !result.data) {
      setRestoreError(result.error || 'Scan failed')
      return
    }
    setRestoreScan(result.data)
    setRestoreApprovedIds(new Set(result.data.diffs.map(d => d.id)))
    setRestoreExpandedGroups(new Set())
  }, [restoreXmlPath, restoreScanning])

  const toggleRestoreTrack = useCallback((id: number) => {
    setRestoreApprovedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleRestoreGroup = useCallback((diffs: RestoreDiff[]) => {
    setRestoreApprovedIds(prev => {
      const ids = diffs.map(d => d.id)
      const allApproved = ids.every(id => prev.has(id))
      const next = new Set(prev)
      if (allApproved) ids.forEach(id => next.delete(id))
      else ids.forEach(id => next.add(id))
      return next
    })
  }, [])

  const toggleRestoreExpanded = useCallback((key: string) => {
    setRestoreExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const approveAllRestore = useCallback(() => {
    if (!restoreScan) return
    setRestoreApprovedIds(new Set(restoreScan.diffs.map(d => d.id)))
  }, [restoreScan])

  const approveNoneRestore = useCallback(() => {
    setRestoreApprovedIds(new Set())
  }, [])

  const applyRestore = useCallback(async () => {
    if (!restoreXmlPath || !restoreScan || restoreApplying) return
    if (restoreApprovedIds.size === 0) return
    setRestoreApplying(true)
    setRestoreError(null)
    const result = await window.electronAPI.restoreXmlApply(
      restoreXmlPath,
      Array.from(restoreApprovedIds),
    )
    setRestoreApplying(false)
    if (!result.ok || !result.data) {
      setRestoreError(result.error || 'Apply failed')
      return
    }
    setRestoreApplied(result.data)
    // Reload library from iPod so the corrected metadata shows up
    try {
      const reloaded = await window.electronAPI.loadTracks()
      if (reloaded?.tracks) {
        dispatch({ type: 'SET_TRACKS', tracks: reloaded.tracks as Track[] })
      }
    } catch {
      // Non-fatal; user can restart to see changes
    }
  }, [restoreXmlPath, restoreScan, restoreApprovedIds, restoreApplying, dispatch])

  // Album art helpers
  const uniqueAlbums = (() => {
    const seen = new Map<string, { artist: string; album: string; trackCount: number }>()
    for (const t of libState.tracks) {
      if (!t.album) continue
      const key = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
      const existing = seen.get(key)
      if (existing) {
        existing.trackCount++
      } else {
        seen.set(key, { artist: t.artist, album: t.album, trackCount: 1 })
      }
    }
    return Array.from(seen.entries()).map(([key, val]) => ({ key, ...val }))
      .sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album))
  })()

  const fetchSingleArt = useCallback(async (artist: string, album: string) => {
    const key = `${artist.toLowerCase().trim()}|||${album.toLowerCase().trim()}`
    setArtFetching(prev => new Set([...prev, key]))
    const result = await window.electronAPI.fetchAlbumArt(artist, album)
    setArtFetching(prev => { const next = new Set(prev); next.delete(key); return next })
    if (result.ok && result.key && result.hash) {
      dispatch({ type: 'ADD_ARTWORK', key: result.key, hash: result.hash })
    }
    return result.ok
  }, [dispatch])

  const fetchAllMissing = useCallback(async () => {
    const missing = uniqueAlbums.filter(a => !libState.artworkMap[a.key])
    if (missing.length === 0) return
    setArtProgress({ done: 0, total: missing.length })
    for (let i = 0; i < missing.length; i++) {
      await fetchSingleArt(missing[i].artist, missing[i].album)
      setArtProgress({ done: i + 1, total: missing.length })
      // Small delay between requests
      if (i < missing.length - 1) await new Promise(r => setTimeout(r, 200))
    }
    setArtProgress(null)
  }, [uniqueAlbums, libState.artworkMap, fetchSingleArt])

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const handlePlaylistKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && playlistInput.trim()) {
      e.preventDefault()
      generatePlaylist()
    }
  }

  const fetchRecommendations = useCallback(async () => {
    if (recsLoading) return
    setRecsLoading(true)
    const compactTracks = libState.tracks.map(t => ({
      id: t.id, title: t.title, artist: t.artist,
      album: t.album, genre: t.genre, year: t.year
    }))
    const result = await window.electronAPI.musicmanRecommendations(compactTracks)
    if (result.ok && result.recommendations) {
      setRecs(result.recommendations)
    }
    setRecsLoading(false)
    setRecsLoaded(true)
  }, [recsLoading, libState.tracks])

  // Auto-fetch recommendations on first tab visit
  useEffect(() => {
    if (activeTab === 'Recommendations' && !recsLoaded && !recsLoading && libState.tracks.length > 0) {
      fetchRecommendations()
    }
  }, [activeTab, recsLoaded, recsLoading, libState.tracks.length, fetchRecommendations])

  // Library analysis (computed client-side, instant)
  const libraryAnalysis = useMemo(() => {
    if (libState.tracks.length === 0) return null
    const tracks = libState.tracks

    // Stats
    const uniqueArtists = new Set(tracks.map(t => t.artist?.toLowerCase().trim()).filter(Boolean))
    const uniqueAlbums = new Set(tracks.map(t => `${t.artist?.toLowerCase().trim()}|||${t.album?.toLowerCase().trim()}`).filter(k => !k.startsWith('|||')))
    const uniqueGenres = new Set(tracks.map(t => t.genre?.toLowerCase().trim()).filter(Boolean))

    // Duplicates: same title + artist
    const dupeMap = new Map<string, Track[]>()
    for (const t of tracks) {
      const key = `${t.title.toLowerCase().trim()}|||${t.artist.toLowerCase().trim()}`
      const list = dupeMap.get(key) || []
      list.push(t)
      dupeMap.set(key, list)
    }
    const duplicates = Array.from(dupeMap.entries())
      .filter(([, list]) => list.length > 1)
      .map(([, list]) => list)
      .sort((a, b) => b.length - a.length)

    // Single-track albums (you only have 1 song from this album)
    const albumTrackCount = new Map<string, { artist: string; album: string; count: number }>()
    for (const t of tracks) {
      if (!t.album) continue
      const key = `${t.artist.toLowerCase().trim()}|||${t.album.toLowerCase().trim()}`
      const existing = albumTrackCount.get(key)
      if (existing) existing.count++
      else albumTrackCount.set(key, { artist: t.artist, album: t.album, count: 1 })
    }
    const singleTrackAlbums = Array.from(albumTrackCount.values())
      .filter(a => a.count === 1)
      .sort((a, b) => a.artist.localeCompare(b.artist))

    // Genre breakdown
    const genreCounts = new Map<string, number>()
    for (const t of tracks) {
      const g = t.genre || '(none)'
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1)
    }
    const genres = Array.from(genreCounts.entries())
      .sort((a, b) => b[1] - a[1])

    // Missing metadata
    const missingArtist = tracks.filter(t => !t.artist || t.artist.trim() === '')
    const missingAlbum = tracks.filter(t => !t.album || t.album.trim() === '')
    const missingGenre = tracks.filter(t => !t.genre || t.genre.trim() === '')
    const missingYear = tracks.filter(t => !t.year || t.year === 0 || t.year === '0')

    // Decade breakdown
    const decades = new Map<string, number>()
    for (const t of tracks) {
      const yr = typeof t.year === 'string' ? parseInt(t.year) : t.year
      if (yr && yr > 1900) {
        const dec = `${Math.floor(yr / 10) * 10}s`
        decades.set(dec, (decades.get(dec) || 0) + 1)
      }
    }
    const decadeList = Array.from(decades.entries()).sort((a, b) => a[0].localeCompare(b[0]))

    // Genre merge suggestions — find near-duplicates
    const genreNames = Array.from(genreCounts.keys()).filter(g => g !== '(none)')
    const genreMerges: { from: string; to: string; fromCount: number; toCount: number; trackIds: number[] }[] = []
    const mergedSet = new Set<string>()
    for (const g1 of genreNames) {
      for (const g2 of genreNames) {
        if (g1 >= g2) continue
        if (mergedSet.has(g1) || mergedSet.has(g2)) continue
        const lo1 = g1.toLowerCase().replace(/[^a-z0-9]/g, '')
        const lo2 = g2.toLowerCase().replace(/[^a-z0-9]/g, '')
        // Exact match after normalization (e.g. "Hip-Hop" vs "HipHop")
        let isMerge = lo1 === lo2
        // One is a short extension of the other (e.g. "Electronic" vs "Electronica")
        if (!isMerge && lo1.length >= 4 && lo2.length >= 4) {
          const shorter = lo1.length <= lo2.length ? lo1 : lo2
          const longer = lo1.length <= lo2.length ? lo2 : lo1
          if (longer.startsWith(shorter) && (longer.length - shorter.length) <= 3) {
            isMerge = true
          }
        }
        if (isMerge) {
          const c1 = genreCounts.get(g1) || 0
          const c2 = genreCounts.get(g2) || 0
          const [keep, merge] = c1 >= c2 ? [g1, g2] : [g2, g1]
          const ids = tracks.filter(t => t.genre === merge).map(t => t.id)
          genreMerges.push({ from: merge, to: keep, fromCount: genreCounts.get(merge) || 0, toCount: genreCounts.get(keep) || 0, trackIds: ids })
          mergedSet.add(merge)
        }
      }
    }

    // Auto-fill missing genres based on artist's most common genre
    const artistGenreMap = new Map<string, Map<string, number>>()
    for (const t of tracks) {
      if (!t.artist || !t.genre) continue
      const aKey = t.artist.toLowerCase().trim()
      if (!artistGenreMap.has(aKey)) artistGenreMap.set(aKey, new Map())
      const gm = artistGenreMap.get(aKey)!
      gm.set(t.genre, (gm.get(t.genre) || 0) + 1)
    }
    const genreFills: { trackId: number; title: string; artist: string; suggestedGenre: string }[] = []
    const manualGenreGroups: { artist: string; trackIds: number[]; titles: string[] }[] = []
    const manualGroupMap = new Map<string, { artist: string; trackIds: number[]; titles: string[] }>()
    for (const t of missingGenre) {
      const aKey = t.artist?.toLowerCase().trim()
      if (!aKey) continue
      const gm = artistGenreMap.get(aKey)
      if (gm && gm.size > 0) {
        const best = Array.from(gm.entries()).sort((a, b) => b[1] - a[1])[0][0]
        genreFills.push({ trackId: t.id, title: t.title, artist: t.artist, suggestedGenre: best })
      } else {
        // No auto-suggestion — group for manual fill
        if (!manualGroupMap.has(aKey)) {
          manualGroupMap.set(aKey, { artist: t.artist || 'Unknown', trackIds: [], titles: [] })
        }
        const g = manualGroupMap.get(aKey)!
        g.trackIds.push(t.id)
        g.titles.push(t.title)
      }
    }
    for (const g of manualGroupMap.values()) {
      manualGenreGroups.push(g)
    }
    manualGenreGroups.sort((a, b) => b.trackIds.length - a.trackIds.length)

    return {
      totalTracks: tracks.length,
      totalArtists: uniqueArtists.size,
      totalAlbums: uniqueAlbums.size,
      totalGenres: uniqueGenres.size,
      duplicates,
      singleTrackAlbums,
      genres,
      decadeList,
      genreMerges,
      genreFills,
      manualGenreGroups,
      missing: {
        artist: missingArtist,
        album: missingAlbum,
        genre: missingGenre,
        year: missingYear,
      }
    }
  }, [libState.tracks])

  const [orgExpanded, setOrgExpanded] = useState<Set<string>>(new Set())
  const [mergeTargets, setMergeTargets] = useState<Record<number, string>>({})
  const [renamingGenre, setRenamingGenre] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [manualGenreInputs, setManualGenreInputs] = useState<Record<string, string>>({})
  const toggleOrgSection = useCallback((section: string) => {
    setOrgExpanded(prev => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }, [])

  const applyGenreMerge = useCallback(async (idx: number, from: string, defaultTo: string, trackIds: number[]) => {
    const to = (mergeTargets[idx] ?? defaultTo).trim()
    if (!to) return
    const key = `merge:${from}`
    if (orgApplied.has(key)) return
    const updates = trackIds.map(id => ({ id, field: 'genre', value: to }))
    dispatch({ type: 'UPDATE_TRACKS', updates })
    for (const id of trackIds) {
      await window.electronAPI.saveMetadataOverride(id, 'genre', to)
    }
    setOrgApplied(prev => new Set([...prev, key]))
  }, [dispatch, orgApplied, mergeTargets])

  const renameGenre = useCallback(async (oldGenre: string, newGenre: string) => {
    const trimmed = newGenre.trim()
    if (!trimmed || trimmed === oldGenre) { setRenamingGenre(null); return }
    const ids = libState.tracks.filter(t => t.genre === oldGenre).map(t => t.id)
    if (ids.length === 0) { setRenamingGenre(null); return }
    const updates = ids.map(id => ({ id, field: 'genre', value: trimmed }))
    dispatch({ type: 'UPDATE_TRACKS', updates })
    for (const id of ids) {
      await window.electronAPI.saveMetadataOverride(id, 'genre', trimmed)
    }
    setRenamingGenre(null)
    setOrgApplied(prev => new Set([...prev, `rename:${oldGenre}`]))
  }, [dispatch, libState.tracks])

  const applyManualGenre = useCallback(async (artistKey: string, trackIds: number[], genre: string) => {
    const trimmed = genre.trim()
    if (!trimmed) return
    const key = `manual:${artistKey}`
    if (orgApplied.has(key)) return
    const updates = trackIds.map(id => ({ id, field: 'genre', value: trimmed }))
    dispatch({ type: 'UPDATE_TRACKS', updates })
    for (const id of trackIds) {
      await window.electronAPI.saveMetadataOverride(id, 'genre', trimmed)
    }
    setOrgApplied(prev => new Set([...prev, key]))
  }, [dispatch, orgApplied])

  const applyGenreFill = useCallback(async (trackId: number, genre: string) => {
    const key = `fill:${trackId}`
    if (orgApplied.has(key)) return
    dispatch({ type: 'UPDATE_TRACKS', updates: [{ id: trackId, field: 'genre', value: genre }] })
    await window.electronAPI.saveMetadataOverride(trackId, 'genre', genre)
    setOrgApplied(prev => new Set([...prev, key]))
  }, [dispatch, orgApplied])

  const applyAllGenreFills = useCallback(async () => {
    if (!libraryAnalysis) return
    for (const fill of libraryAnalysis.genreFills) {
      await applyGenreFill(fill.trackId, fill.suggestedGenre)
    }
  }, [libraryAnalysis, applyGenreFill])

  return (
    <div className="musicman">
      <div className="musicman-header">
        <div className="musicman-avatar">
          <img src={musicmanAvatar} alt="The Music Man" width="88" height="88" />
        </div>
        <div className="musicman-header-text">
          <div className="musicman-title">
            The Music Man
            <span className="musicman-badge">In the Store</span>
          </div>
          <div className="musicman-tagline">"{TAGLINES[Math.floor(new Date().getDate() + new Date().getMonth() * 31) % TAGLINES.length]}"</div>
        </div>
      </div>

      <div className="musicman-tabs">
        {TABS.map(tab => (
          <button
            key={tab}
            className={`musicman-tab ${activeTab === tab ? 'musicman-tab--active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="musicman-content">
        {activeTab === 'Ask Me Anything' && (
          <div className="musicman-chat-layout">
            {conversations.length > 0 && (
              <div className="musicman-chat-history">
                <button className="musicman-chat-new" onClick={startNewChat}>+ New Chat</button>
                <div className="musicman-chat-history-list">
                  {conversations.map(conv => (
                    <div
                      key={conv.id}
                      className={`musicman-chat-history-item ${activeChatId === conv.id ? 'musicman-chat-history-item--active' : ''}`}
                      onClick={() => loadChat(conv)}
                    >
                      <span className="musicman-chat-history-title">{conv.title}</span>
                      <button
                        className="musicman-chat-history-delete"
                        onClick={(e) => { e.stopPropagation(); deleteChat(conv.id) }}
                        title="Delete conversation"
                      >
                        &times;
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="musicman-chat">
              <div className="musicman-chat-messages">
                <div className="musicman-chat-msg musicman-chat-msg--system">
                  <p>{CHAT_INTROS[Math.floor(new Date().getDate() + new Date().getMonth() * 31) % CHAT_INTROS.length]}</p>
                </div>
                {messages.map((msg, i) => (
                  <div key={i} className={`musicman-chat-msg ${msg.role === 'user' ? 'musicman-chat-msg--user' : 'musicman-chat-msg--assistant'}`}>
                    {msg.role === 'assistant' ? (
                      <>
                        {msg.content.split('\n').map((line, j) => (
                          <p key={j}>{line}</p>
                        ))}
                        <button
                          className={`musicman-speak-btn ${isSpeaking && speakingIdx === i ? 'musicman-speak-btn--active' : ''}`}
                          onClick={() => speakMessage(msg.content, i)}
                          title={isSpeaking && speakingIdx === i ? 'Stop' : 'Listen'}
                        >
                          {isSpeaking && speakingIdx === i ? (
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1" /></svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
                              <path d="M1.5 5.5v3h2l3 3v-9l-3 3h-2z" fill="currentColor" stroke="none" />
                              <path d="M9 5.5a2 2 0 010 3" />
                              <path d="M10.5 4a4 4 0 010 6" />
                            </svg>
                          )}
                        </button>
                      </>
                    ) : (
                      <p>{msg.content}</p>
                    )}
                  </div>
                ))}
                {isLoading && (
                  <div className="musicman-chat-msg musicman-chat-msg--assistant">
                    <p className="musicman-typing">thinking...</p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="musicman-chat-input-row">
                <input
                  className="musicman-chat-input"
                  type="text"
                  placeholder="Ask The Music Man anything..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={handleChatKeyDown}
                  disabled={isLoading}
                />
                <button className="musicman-chat-send" disabled={!chatInput.trim() || isLoading} onClick={sendMessage}>Ask</button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'Recommendations' && (
          <div className="musicman-recs">
            {recsLoading && (
              <div className="musicman-recs-loading">
                <p className="musicman-typing">The Music Man is evaluating your taste...</p>
              </div>
            )}
            {!recsLoading && recs.length > 0 && (
              <>
                <div className="musicman-recs-header">
                  <div className="musicman-recs-intro">
                    Based on your library, you clearly have <em>some</em> taste. Here's what you're missing:
                  </div>
                  <button className="musicman-recs-refresh" onClick={fetchRecommendations} title="Get new recommendations">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M1.5 7a5.5 5.5 0 019.5-3.5M12.5 7a5.5 5.5 0 01-9.5 3.5" />
                      <path d="M11 1v3h-3M3 10v3h3" />
                    </svg>
                  </button>
                </div>
                <div className="musicman-recs-grid">
                  {recs.map((rec, i) => (
                    <div key={i} className="musicman-rec-card">
                      <div className="musicman-rec-art">
                        {rec.artUrl ? (
                          <img src={rec.artUrl} alt={rec.title} className="musicman-rec-art-img" />
                        ) : (
                          <svg width="28" height="28" viewBox="0 0 28 28" fill="#c87828" opacity="0.4">
                            <circle cx="14" cy="14" r="12" fill="none" stroke="#c87828" strokeWidth="1" />
                            <circle cx="14" cy="14" r="4" fill="none" stroke="#c87828" strokeWidth="1" />
                          </svg>
                        )}
                      </div>
                      <div className="musicman-rec-info">
                        <div className="musicman-rec-title">{rec.title}</div>
                        <div className="musicman-rec-artist">{rec.artist}{rec.year ? ` (${rec.year})` : ''}</div>
                        <div className="musicman-rec-tags">
                          <span className={`musicman-rec-source musicman-rec-source--${rec.source}`}>{rec.source}</span>
                          <span className="musicman-rec-tag">{rec.genre}</span>
                        </div>
                        <div className="musicman-rec-why">{rec.why}</div>
                        <div className="musicman-rec-links">
                          <a
                            className="musicman-rec-link musicman-rec-link--bandcamp"
                            href={`https://bandcamp.com/search?q=${encodeURIComponent(`${rec.artist} ${rec.title}`)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Bandcamp
                          </a>
                          <a
                            className="musicman-rec-link musicman-rec-link--qobuz"
                            href={`https://www.qobuz.com/us-en/search?q=${encodeURIComponent(`${rec.artist} ${rec.title}`)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Qobuz
                          </a>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {!recsLoading && recsLoaded && recs.length === 0 && (
              <div className="musicman-recs-loading">
                <p>Even I'm stumped. Try again.</p>
                <button className="musicman-chat-send" onClick={fetchRecommendations} style={{ marginTop: 12 }}>Retry</button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Build a Playlist' && (
          <div className="musicman-playlist">
            <div className="musicman-playlist-input-row">
              <input
                className="musicman-chat-input"
                placeholder="e.g., 'Driving at 2am through empty streets'"
                value={playlistInput}
                onChange={(e) => setPlaylistInput(e.target.value)}
                onKeyDown={handlePlaylistKeyDown}
                disabled={playlistLoading}
              />
              <button
                className="musicman-chat-send"
                disabled={!playlistInput.trim() || playlistLoading}
                onClick={generatePlaylist}
              >
                Build
              </button>
            </div>

            {playlistLoading && (
              <div className="musicman-playlist-loading">
                <p className="musicman-typing">The Music Man is curating...</p>
              </div>
            )}

            {playlistResult && (
              <div className="musicman-playlist-result">
                <div className="musicman-playlist-header">
                  <div className="musicman-playlist-name">{playlistResult.name}</div>
                  <div className="musicman-playlist-actions">
                    <button
                      className="musicman-playlist-save"
                      onClick={savePlaylist}
                      disabled={playlistSaved}
                    >
                      {playlistSaved ? 'Saved' : 'Save'}
                    </button>
                    <button
                      className="musicman-playlist-play-all"
                      onClick={() => {
                        if (playlistResult.tracks.length > 0) {
                          playTrack(playlistResult.tracks[0], playlistResult.tracks, 0)
                        }
                      }}
                    >
                      Play All
                    </button>
                  </div>
                </div>
                <div className="musicman-playlist-commentary">
                  {playlistResult.commentary}{' '}
                  <button
                    className={`musicman-commentary-play ${speakingCommentary ? 'musicman-commentary-play--active' : ''}`}
                    onClick={speakCommentary}
                    title={speakingCommentary ? 'Stop' : 'Listen'}
                  >
                    {speakingCommentary ? '■' : '▶'}
                  </button>
                </div>
                <div className="musicman-playlist-tracks">
                  {playlistResult.tracks.map((track, i) => (
                    <div
                      key={track.id}
                      className="musicman-playlist-track"
                      onDoubleClick={() => playTrack(track, playlistResult.tracks, i)}
                    >
                      <span className="musicman-playlist-num">{i + 1}</span>
                      <span className="musicman-playlist-title">{track.title}</span>
                      <span className="musicman-playlist-artist">{track.artist}</span>
                      <span className="musicman-playlist-duration">{formatDuration(track.duration)}</span>
                    </div>
                  ))}
                </div>
                <div className="musicman-playlist-count">
                  {playlistResult.tracks.length} tracks
                </div>
              </div>
            )}

            {!playlistLoading && !playlistResult && (
              <p style={{ color: '#a89878', marginTop: 16 }}>
                Tell me a mood, a memory, or a moment. I'll build you something you didn't know you needed.
              </p>
            )}
          </div>
        )}

        {activeTab === 'Organize Library' && libraryAnalysis && (
          <div className="musicman-organize">
            <div className="musicman-org-stats">
              <div className="musicman-org-stat">
                <div className="musicman-org-stat-num">{libraryAnalysis.totalTracks.toLocaleString()}</div>
                <div className="musicman-org-stat-label">Tracks</div>
              </div>
              <div className="musicman-org-stat">
                <div className="musicman-org-stat-num">{libraryAnalysis.totalArtists.toLocaleString()}</div>
                <div className="musicman-org-stat-label">Artists</div>
              </div>
              <div className="musicman-org-stat">
                <div className="musicman-org-stat-num">{libraryAnalysis.totalAlbums.toLocaleString()}</div>
                <div className="musicman-org-stat-label">Albums</div>
              </div>
              <div className="musicman-org-stat">
                <div className="musicman-org-stat-num">{libraryAnalysis.totalGenres}</div>
                <div className="musicman-org-stat-label">Genres</div>
              </div>
            </div>

            {/* Decades */}
            <div className="musicman-org-section">
              <div className="musicman-org-section-header" onClick={() => toggleOrgSection('decades')}>
                <span>Decades</span>
                <span className="musicman-org-toggle">{orgExpanded.has('decades') ? '−' : '+'}</span>
              </div>
              {orgExpanded.has('decades') && (
                <div className="musicman-org-bars">
                  {libraryAnalysis.decadeList.map(([decade, count]) => (
                    <div key={decade} className="musicman-org-bar-row">
                      <span className="musicman-org-bar-label">{decade}</span>
                      <div className="musicman-org-bar-track">
                        <div className="musicman-org-bar-fill" style={{ width: `${(count / Math.max(...libraryAnalysis.decadeList.map(d => d[1] as number))) * 100}%` }} />
                      </div>
                      <span className="musicman-org-bar-count">{count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Genre Breakdown */}
            <div className="musicman-org-section">
              <div className="musicman-org-section-header" onClick={() => toggleOrgSection('genres')}>
                <span>Genres ({libraryAnalysis.genres.length})</span>
                <span className="musicman-org-toggle">{orgExpanded.has('genres') ? '−' : '+'}</span>
              </div>
              {orgExpanded.has('genres') && (
                <div className="musicman-org-bars">
                  {libraryAnalysis.genres.slice(0, 30).map(([genre, count]) => (
                    <div key={genre} className="musicman-org-bar-row">
                      {renamingGenre === genre ? (
                        <div className="musicman-org-rename-inline">
                          <input
                            className="musicman-org-rename-input"
                            autoFocus
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') renameGenre(genre, renameValue)
                              if (e.key === 'Escape') setRenamingGenre(null)
                            }}
                            onBlur={() => setRenamingGenre(null)}
                          />
                          <button className="musicman-org-action-btn" onMouseDown={e => { e.preventDefault(); renameGenre(genre, renameValue) }}>Rename</button>
                          <span className="musicman-org-bar-count">{count}</span>
                        </div>
                      ) : (
                        <>
                          <span className="musicman-org-bar-label">{genre}</span>
                          <div className="musicman-org-bar-track">
                            <div className="musicman-org-bar-fill" style={{ width: `${(count / libraryAnalysis.genres[0][1]) * 100}%` }} />
                          </div>
                          <span className="musicman-org-bar-count">{count}</span>
                          {genre !== '(none)' && (
                            <button
                              className="musicman-org-rename-btn"
                              onClick={() => { setRenamingGenre(genre); setRenameValue(genre) }}
                              title="Rename genre"
                            >
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
                                <path d="M7.5 2.5l2 2M2 8l5-5 2 2-5 5H2V8z" />
                              </svg>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                  {libraryAnalysis.genres.length > 30 && (
                    <p className="musicman-org-more">+{libraryAnalysis.genres.length - 30} more</p>
                  )}
                </div>
              )}
            </div>

            {/* Duplicates */}
            <div className="musicman-org-section">
              <div className="musicman-org-section-header" onClick={() => toggleOrgSection('dupes')}>
                <span>Potential Duplicates ({libraryAnalysis.duplicates.length})</span>
                <span className="musicman-org-toggle">{orgExpanded.has('dupes') ? '−' : '+'}</span>
              </div>
              {orgExpanded.has('dupes') && (
                <div className="musicman-org-list">
                  {libraryAnalysis.duplicates.length === 0 ? (
                    <p className="musicman-org-empty">No duplicates found. Impressive discipline.</p>
                  ) : (
                    libraryAnalysis.duplicates.slice(0, 50).map((group, i) => (
                      <div key={i} className="musicman-org-dupe-group">
                        <div className="musicman-org-dupe-title">"{group[0].title}" — {group[0].artist} <span className="musicman-org-dupe-count">×{group.length}</span></div>
                        {group.map(t => (
                          <div key={t.id} className="musicman-org-dupe-track">
                            <span className="musicman-org-dupe-album">{t.album || '(no album)'}</span>
                            <span className="musicman-org-dupe-genre">{t.genre || ''}</span>
                          </div>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Single-Track Albums */}
            <div className="musicman-org-section">
              <div className="musicman-org-section-header" onClick={() => toggleOrgSection('singles')}>
                <span>Single-Track Albums ({libraryAnalysis.singleTrackAlbums.length})</span>
                <span className="musicman-org-toggle">{orgExpanded.has('singles') ? '−' : '+'}</span>
              </div>
              {orgExpanded.has('singles') && (
                <div className="musicman-org-list">
                  {libraryAnalysis.singleTrackAlbums.slice(0, 60).map((a, i) => (
                    <div key={i} className="musicman-org-single-row">
                      <span className="musicman-org-single-album">{a.album}</span>
                      <span className="musicman-org-single-artist">{a.artist}</span>
                    </div>
                  ))}
                  {libraryAnalysis.singleTrackAlbums.length > 60 && (
                    <p className="musicman-org-more">+{libraryAnalysis.singleTrackAlbums.length - 60} more</p>
                  )}
                </div>
              )}
            </div>

            {/* Missing Metadata */}
            <div className="musicman-org-section">
              <div className="musicman-org-section-header" onClick={() => toggleOrgSection('missing')}>
                <span>Missing Metadata</span>
                <span className="musicman-org-toggle">{orgExpanded.has('missing') ? '−' : '+'}</span>
              </div>
              {orgExpanded.has('missing') && (
                <div className="musicman-org-missing">
                  {[
                    { label: 'No Artist', items: libraryAnalysis.missing.artist },
                    { label: 'No Album', items: libraryAnalysis.missing.album },
                    { label: 'No Genre', items: libraryAnalysis.missing.genre },
                    { label: 'No Year', items: libraryAnalysis.missing.year },
                  ].map(({ label, items }) => (
                    <div key={label} className="musicman-org-missing-row">
                      <span className="musicman-org-missing-label">{label}</span>
                      <span className={`musicman-org-missing-count ${items.length === 0 ? 'musicman-org-missing-count--good' : ''}`}>
                        {items.length === 0 ? '✓' : items.length}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Genre Merge Suggestions */}
            <div className="musicman-org-section">
              <div className="musicman-org-section-header" onClick={() => toggleOrgSection('merges')}>
                <span>Genre Merge Suggestions ({libraryAnalysis.genreMerges.length})</span>
                <span className="musicman-org-toggle">{orgExpanded.has('merges') ? '−' : '+'}</span>
              </div>
              {orgExpanded.has('merges') && (
                <div className="musicman-org-list">
                  {libraryAnalysis.genreMerges.length === 0 ? (
                    <p className="musicman-org-empty">No duplicate genres detected. Your naming is surprisingly consistent.</p>
                  ) : (
                    <>
                      <p className="musicman-org-hint">These genres look like near-duplicates. Edit the target name to merge into a custom genre or subgenre.</p>
                      {libraryAnalysis.genreMerges.map((merge, i) => {
                        const key = `merge:${merge.from}`
                        const applied = orgApplied.has(key)
                        const targetValue = mergeTargets[i] ?? merge.to
                        return (
                          <div key={i} className={`musicman-org-merge-row ${applied ? 'musicman-org-merge-row--applied' : ''}`}>
                            <div className="musicman-org-merge-info">
                              <span className="musicman-org-merge-from">"{merge.from}"</span>
                              <span className="musicman-org-merge-count">({merge.fromCount})</span>
                              <span className="musicman-org-merge-arrow">→</span>
                              {applied ? (
                                <span className="musicman-org-merge-to">"{targetValue}"</span>
                              ) : (
                                <input
                                  className="musicman-org-merge-target-input"
                                  value={targetValue}
                                  onChange={e => setMergeTargets(prev => ({ ...prev, [i]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') applyGenreMerge(i, merge.from, merge.to, merge.trackIds) }}
                                />
                              )}
                            </div>
                            {applied ? (
                              <span className="musicman-org-applied-badge">Merged</span>
                            ) : (
                              <button
                                className="musicman-org-action-btn"
                                onClick={() => applyGenreMerge(i, merge.from, merge.to, merge.trackIds)}
                              >
                                Merge
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Fill Missing Genres */}
            <div className="musicman-org-section">
              <div className="musicman-org-section-header" onClick={() => toggleOrgSection('fills')}>
                <span>Fill Missing Genres ({libraryAnalysis.missing.genre.length} tracks)</span>
                <span className="musicman-org-toggle">{orgExpanded.has('fills') ? '−' : '+'}</span>
              </div>
              {orgExpanded.has('fills') && (
                <div className="musicman-org-list">
                  {libraryAnalysis.missing.genre.length === 0 ? (
                    <p className="musicman-org-empty">Every track has a genre. Nothing to fill.</p>
                  ) : (
                    <>
                      {libraryAnalysis.genreFills.length > 0 && (
                        <>
                          <div className="musicman-org-fill-header">
                            <p className="musicman-org-hint">Auto-fill: these artists have genres on other tracks.</p>
                            {libraryAnalysis.genreFills.some(f => !orgApplied.has(`fill:${f.trackId}`)) && (
                              <button className="musicman-org-action-btn musicman-org-action-btn--all" onClick={applyAllGenreFills}>
                                Apply All ({libraryAnalysis.genreFills.filter(f => !orgApplied.has(`fill:${f.trackId}`)).length})
                              </button>
                            )}
                          </div>
                          {libraryAnalysis.genreFills.map((fill) => {
                            const key = `fill:${fill.trackId}`
                            const applied = orgApplied.has(key)
                            return (
                              <div key={fill.trackId} className={`musicman-org-fill-row ${applied ? 'musicman-org-fill-row--applied' : ''}`}>
                                <div className="musicman-org-fill-info">
                                  <span className="musicman-org-fill-title">{fill.title}</span>
                                  <span className="musicman-org-fill-artist">{fill.artist}</span>
                                  <span className="musicman-org-fill-arrow">→</span>
                                  <span className="musicman-org-fill-genre">{fill.suggestedGenre}</span>
                                </div>
                                {applied ? (
                                  <span className="musicman-org-applied-badge">Applied</span>
                                ) : (
                                  <button
                                    className="musicman-org-action-btn"
                                    onClick={() => applyGenreFill(fill.trackId, fill.suggestedGenre)}
                                  >
                                    Apply
                                  </button>
                                )}
                              </div>
                            )
                          })}
                        </>
                      )}
                      {libraryAnalysis.manualGenreGroups.length > 0 && (
                        <>
                          <p className="musicman-org-hint" style={{ marginTop: libraryAnalysis.genreFills.length > 0 ? 14 : 0 }}>
                            Manual: type a genre for each artist and hit Apply. All their missing-genre tracks get updated.
                          </p>
                          {libraryAnalysis.manualGenreGroups.map((group) => {
                            const aKey = group.artist.toLowerCase().trim()
                            const applied = orgApplied.has(`manual:${aKey}`)
                            const inputVal = manualGenreInputs[aKey] || ''
                            return (
                              <div key={aKey} className={`musicman-org-manual-row ${applied ? 'musicman-org-manual-row--applied' : ''}`}>
                                <div className="musicman-org-manual-info">
                                  <span className="musicman-org-manual-artist">{group.artist}</span>
                                  <span className="musicman-org-manual-count">{group.trackIds.length} track{group.trackIds.length !== 1 ? 's' : ''}</span>
                                </div>
                                {applied ? (
                                  <span className="musicman-org-applied-badge">Applied</span>
                                ) : (
                                  <div className="musicman-org-manual-action">
                                    <input
                                      className="musicman-org-merge-target-input"
                                      placeholder="Genre..."
                                      value={inputVal}
                                      onChange={e => setManualGenreInputs(prev => ({ ...prev, [aKey]: e.target.value }))}
                                      onKeyDown={e => { if (e.key === 'Enter' && inputVal.trim()) applyManualGenre(aKey, group.trackIds, inputVal) }}
                                    />
                                    <button
                                      className="musicman-org-action-btn"
                                      disabled={!inputVal.trim()}
                                      onClick={() => applyManualGenre(aKey, group.trackIds, inputVal)}
                                    >
                                      Apply
                                    </button>
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'Fix Metadata' && (
          <div className="musicman-metadata">
            <div className="musicman-restore">
              <div className="musicman-restore-header">
                <h3>Restore from XML library</h3>
                <p>Your iTunesDB got scrambled during the storage-mod re-sync. Point me at your iTunes Library XML export and I'll rebuild every mangled title/artist/album from it.</p>
              </div>

              {!restoreScan && !restoreScanning && !restoreApplied && (
                <button className="musicman-chat-send" onClick={pickAndScanXml}>
                  Choose XML & Scan
                </button>
              )}

              {restoreScanning && (
                <p className="musicman-typing">Matching your iPod against the XML...</p>
              )}

              {restoreError && (
                <div className="musicman-restore-error">Error: {restoreError}</div>
              )}

              {restoreApplied && (
                <div className="musicman-restore-applied">
                  <p><strong>Done.</strong> {restoreApplied.tracksRestored} tracks restored, {restoreApplied.tracksWritten} written to iTunesDB.</p>
                  <p className="musicman-restore-backup">Backup saved: <code>{restoreApplied.backup}</code></p>
                  <button className="musicman-chat-send" onClick={rescanXml} style={{ marginTop: 12 }}>Scan Again</button>
                </div>
              )}

              {restoreScan && !restoreApplied && (
                <>
                  <div className="musicman-restore-summary">
                    <div className="musicman-restore-stats">
                      <span><strong>{restoreScan.total}</strong> total</span>
                      <span><strong>{restoreScan.changed}</strong> will change</span>
                      <span><strong>{restoreScan.unchanged}</strong> already correct</span>
                      {restoreScan.unmatched.length > 0 && <span className="musicman-restore-flagged"><strong>{restoreScan.unmatched.length}</strong> unmatched</span>}
                      {restoreScan.ambiguous.length > 0 && <span className="musicman-restore-flagged"><strong>{restoreScan.ambiguous.length}</strong> ambiguous</span>}
                    </div>
                    <div className="musicman-restore-actions">
                      <button className="musicman-metadata-rescan" onClick={approveAllRestore}>Approve all</button>
                      <button className="musicman-metadata-rescan" onClick={approveNoneRestore}>Clear</button>
                      <button className="musicman-metadata-rescan" onClick={rescanXml}>Rescan</button>
                      <button
                        className="musicman-chat-send"
                        onClick={applyRestore}
                        disabled={restoreApprovedIds.size === 0 || restoreApplying}
                      >
                        {restoreApplying ? 'Applying...' : `Apply ${restoreApprovedIds.size} changes`}
                      </button>
                    </div>
                  </div>

                  <div className="musicman-restore-groups">
                    {restoreGroupedDiffs.map(group => {
                      const isExpanded = restoreExpandedGroups.has(group.key)
                      const approvedCount = group.diffs.filter(d => restoreApprovedIds.has(d.id)).length
                      const allApproved = approvedCount === group.diffs.length
                      return (
                        <div key={group.key} className="musicman-restore-group">
                          <div className="musicman-restore-group-header">
                            <input
                              type="checkbox"
                              checked={allApproved}
                              ref={el => { if (el) el.indeterminate = approvedCount > 0 && !allApproved }}
                              onChange={() => toggleRestoreGroup(group.diffs)}
                            />
                            <button
                              className="musicman-restore-group-toggle"
                              onClick={() => toggleRestoreExpanded(group.key)}
                            >
                              {isExpanded ? '▾' : '▸'} <strong>{group.artist}</strong> — {group.album}
                              <span className="musicman-restore-group-count">
                                {approvedCount}/{group.diffs.length} track{group.diffs.length !== 1 ? 's' : ''}
                              </span>
                            </button>
                          </div>
                          {isExpanded && (
                            <div className="musicman-restore-tracks">
                              {group.diffs.map(d => {
                                const approved = restoreApprovedIds.has(d.id)
                                return (
                                  <label key={d.id} className={`musicman-restore-track ${approved ? '' : 'musicman-restore-track--skip'}`}>
                                    <input
                                      type="checkbox"
                                      checked={approved}
                                      onChange={() => toggleRestoreTrack(d.id)}
                                    />
                                    <div className="musicman-restore-track-body">
                                      {d.changed.map(field => (
                                        <div key={field} className="musicman-restore-diff-row">
                                          <span className="musicman-restore-field">{field}</span>
                                          <span className="musicman-restore-old">{String(d.old[field] || '(empty)')}</span>
                                          <span className="musicman-restore-arrow">→</span>
                                          <span className="musicman-restore-new">{String(d.new[field] || '(empty)')}</span>
                                        </div>
                                      ))}
                                      <div className="musicman-restore-match">matched by {d.matchMethod}</div>
                                    </div>
                                  </label>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {(restoreScan.unmatched.length > 0 || restoreScan.ambiguous.length > 0) && (
                    <div className="musicman-restore-flagged-section">
                      <h4>Flagged tracks ({restoreScan.unmatched.length + restoreScan.ambiguous.length})</h4>
                      <p className="musicman-restore-flagged-hint">No confident XML match for these. They'll be left alone.</p>
                      <div className="musicman-restore-flagged-list">
                        {restoreScan.ambiguous.map(t => (
                          <div key={`amb-${t.id}`} className="musicman-restore-flagged-item">
                            <span className="musicman-restore-flagged-tag">ambiguous</span>
                            <span>{t.currentTitle || '(no title)'}</span>
                            {t.currentArtist && <span className="musicman-restore-flagged-meta">— {t.currentArtist}</span>}
                          </div>
                        ))}
                        {restoreScan.unmatched.map(t => (
                          <div key={`un-${t.id}`} className="musicman-restore-flagged-item">
                            <span className="musicman-restore-flagged-tag">unmatched</span>
                            <span>{t.currentTitle || '(no title)'}</span>
                            {t.currentArtist && <span className="musicman-restore-flagged-meta">— {t.currentArtist}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="musicman-restore-divider" />

            {!metaScanned && !metaScanning && (
              <div className="musicman-metadata-intro">
                <p>Misspelled artist names? Wrong genres? "Track 01"? Let me fix your embarrassing metadata.</p>
                <button className="musicman-chat-send" onClick={scanMetadata} style={{ marginTop: 12 }}>Scan for Issues</button>
              </div>
            )}

            {metaScanning && (
              <div className="musicman-metadata-intro">
                <p className="musicman-typing">The Music Man is inspecting your library...</p>
              </div>
            )}

            {metaScanned && metaIssues.length === 0 && (
              <div className="musicman-metadata-intro">
                <p>I hate to say it, but... your metadata is actually fine. Don't let it go to your head.</p>
                <button className="musicman-chat-send" onClick={scanMetadata} style={{ marginTop: 12 }}>Scan Again</button>
              </div>
            )}

            {metaIssues.length > 0 && (
              <>
                <div className="musicman-metadata-summary">
                  Found {metaIssues.length} issue{metaIssues.length !== 1 ? 's' : ''}. {metaFixed.size > 0 && `${metaFixed.size} fixed.`}
                  <button className="musicman-metadata-rescan" onClick={scanMetadata}>Rescan</button>
                </div>
                <div className="musicman-metadata-issues">
                  {metaIssues.map((issue, idx) => {
                    const fixed = metaFixed.has(idx)
                    const trackMap = new Map(libState.tracks.map(t => [t.id, t]))
                    const affectedTracks = issue.trackIds.map(id => trackMap.get(id)).filter(Boolean) as Track[]
                    const altTracks = (issue.altTrackIds || []).map(id => trackMap.get(id)).filter(Boolean) as Track[]
                    const typeLabels: Record<string, string> = {
                      misspelling: 'Misspelling',
                      inconsistent: 'Inconsistent',
                      generic: 'Generic',
                      missing: 'Missing',
                      genre: 'Genre',
                    }
                    return (
                      <div key={idx} className={`musicman-metadata-issue ${fixed ? 'musicman-metadata-issue--fixed' : ''}`}>
                        <div className="musicman-metadata-issue-header">
                          <span className={`musicman-metadata-type musicman-metadata-type--${issue.type}`}>
                            {typeLabels[issue.type] || issue.type}
                          </span>
                          <span className="musicman-metadata-field">{issue.field}</span>
                          {!fixed && issue.suggested && (
                            <button className="musicman-metadata-fix" onClick={() => applyFix(idx)}>Fix</button>
                          )}
                          {fixed && <span className="musicman-metadata-fixed-badge">Fixed</span>}
                        </div>
                        <div className="musicman-metadata-detail">
                          <span className="musicman-metadata-current">"{issue.current || '(empty)'}"</span>
                          {issue.suggested && (
                            <>
                              <span className="musicman-metadata-arrow">→</span>
                              <span className="musicman-metadata-suggested">"{issue.suggested}"</span>
                            </>
                          )}
                          {issue.altCurrent && (
                            <span className="musicman-metadata-alt"> / also appears as "{issue.altCurrent}"</span>
                          )}
                        </div>
                        <div className="musicman-metadata-commentary">{issue.commentary}</div>
                        <div className="musicman-metadata-tracks">
                          {affectedTracks.slice(0, 5).map(t => (
                            <span key={t.id} className="musicman-metadata-track-tag">{t.title} — {t.artist}</span>
                          ))}
                          {altTracks.slice(0, 3).map(t => (
                            <span key={t.id} className="musicman-metadata-track-tag musicman-metadata-track-tag--alt">{t.title} — {t.artist}</span>
                          ))}
                          {affectedTracks.length + altTracks.length > 8 && (
                            <span className="musicman-metadata-track-more">+{affectedTracks.length + altTracks.length - 8} more</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
