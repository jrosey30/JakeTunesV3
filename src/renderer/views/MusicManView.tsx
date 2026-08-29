import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { audioFromBase64Mpeg } from '../audio/base64-audio'
import { libraryHiddenTrackIds } from '../liveSets'
import { useLibrary } from '../context/LibraryContext'
import { attachClipToBroadcast, detachClipFromBroadcast } from '../audio/eq'
import { setNotice } from '../activity'
import { ChatConversation } from '../types'
import ConfirmDialog from '../components/ConfirmDialog'
import musicmanAvatar from '../assets/musicman-avatar.png'
import '../styles/musicman.css'

// 4.5: the Music Man page is now just the chat. His old repertoire — building
// playlists, recommendations, duplicate/genre/metadata cleanup, artwork — is
// integrated throughout the app in its own places now (Your Mixes, Discovery,
// GenresView, the dedup modal, Get Info, the art panel). The one thing with no
// other home, the BPM/key analysis backfill, stays as a compact strip below the
// chat. The dormant playlist/metadata IPC handlers in main are left untouched.

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

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  // 4.5: tagged version of the assistant's response (with ElevenLabs
  // [scoff]/[laughs]/[softer]/etc. inline). Hidden from display — `content`
  // is the stripped-clean version — but used by the speaker button so v3 still
  // performs the dialogue expressively when the user opts into hearing it.
  contentRaw?: string
}

export default function MusicManView() {
  // The wall — what the brain actually knows (brain-status IPC).
  const [brain, setBrain] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    window.electronAPI.brainStatus?.().then((r) => { if (r?.ok) setBrain(r) }).catch(() => {})
  }, [])
  const { state: libState, dispatch } = useLibrary()
  const [chatInput, setChatInput] = useState('')
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speakingIdx, setSpeakingIdx] = useState(-1)
  // Audio analysis backfill (4.0 §2.4b). The main-side worker drains the queue
  // (subprocess isolation + playback debounce); the renderer enqueues + tracks
  // progress. Counter derives from audioAnalysisCounts (a memo over the live
  // library), so it can't go stale on remount.
  const [analysisRunning, setAnalysisRunning] = useState(false)
  const [analysisStatus, setAnalysisStatus] = useState<string | null>(null)
  // Confirm before force-remeasuring tempos that already have a BPM — the
  // backfill button alone skips those, which left the post-clamp library stuck.
  const [remeasureConfirmOpen, setRemeasureConfirmOpen] = useState(false)
  const analysisTotalRef = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Stop any in-flight TTS when the view unmounts (e.g. navigating away).
  // Detach → pause → null, then tell the rest of the app speaking has ended so
  // the avatar/EQ state resets and dead nodes don't accumulate.
  useEffect(() => () => {
    if (audioRef.current) {
      detachClipFromBroadcast(audioRef.current)
      audioRef.current.pause()
      audioRef.current = null
      window.dispatchEvent(new Event('musicman-speaking-end'))
    }
  }, [])

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

    try {
      const result = await window.electronAPI.musicmanChat(newMessages)
      // 2026-08-07: the Music Man has HANDS — when his create_playlist
      // tool fired, the resolved playlist lands in the sidebar HERE, the
      // same ADD_PLAYLIST path a hand-made playlist uses.
      if (result.createdPlaylist && result.createdPlaylist.trackIds.length > 0) {
        const playlist = { id: `mm-${Date.now()}`, name: result.createdPlaylist.name, trackIds: result.createdPlaylist.trackIds }
        dispatch({ type: 'ADD_PLAYLIST', playlist })
        void window.electronAPI.tasteLedgerAppend?.([{
          surface: 'mm-playlist', verdict: 'accept',
          key: { playlistId: playlist.id },
          ctx: { name: playlist.name, trackCount: playlist.trackIds.length },
        }])
      }
      // 4.5: store BOTH the stripped text (for display) and the raw text with
      // [scoff]/[laughs] tags intact (for the speaker button to feed ElevenLabs
      // v3). textRaw defaults to text on older builds + error paths.
      const finalMessages: ChatMessage[] = [...newMessages, {
        role: 'assistant',
        content: result.text,
        contentRaw: result.textRaw || result.text,
      }]
      setMessages(finalMessages)

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
    } catch (err) {
      // Roll back the optimistic user bubble and restore their typed text so
      // the message isn't lost when the chat IPC throws.
      setMessages(messages)
      setChatInput(text)
      setNotice(err instanceof Error ? err.message : 'The Music Man could not respond.', { kind: 'error' })
    } finally {
      setIsLoading(false)
    }
  }

  const speakMessage = async (text: string, index: number) => {
    if (isSpeaking && audioRef.current) {
      detachClipFromBroadcast(audioRef.current)
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
    try {
      const tts = await window.electronAPI.musicmanSpeak(text)
      if (tts.ok && tts.audio) {
        const audio = audioFromBase64Mpeg(tts.audio)
        attachClipToBroadcast(audio)
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
    } catch (err) {
      setIsSpeaking(false)
      setSpeakingIdx(-1)
      window.dispatchEvent(new Event('musicman-speaking-end'))
      setNotice(err instanceof Error ? err.message : 'Could not play speech.', { kind: 'error' })
    }
  }

  const handleChatKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // ── Audio analysis backfill (BPM + key) ────────────────────────────────
  // Enqueue unanalyzed tracks (or, with force, every track with a path). The
  // main worker drains the queue with subprocess isolation + 5s playback
  // debounce. Default filter excludes tracks with both a timestamp AND a bpm;
  // failed-but-timestamped tracks resurface so they can be retried. Force is
  // how the post-clamp / Essentia-double library gets healed — without it
  // "All tracks already analyzed" was a lie about accuracy.
  const enqueueAudioAnalysis = useCallback(async (force: boolean) => {
    if (analysisRunning) return
    const tracksToAnalyze = libState.tracks.filter(t =>
      t.path && (force || !t.audioAnalysisAt || !t.bpm),
    )
    if (tracksToAnalyze.length === 0) {
      setAnalysisStatus('All tracks already analyzed.')
      setTimeout(() => setAnalysisStatus(null), 4000)
      return
    }
    const jobs = tracksToAnalyze.map(t => ({
      trackId: t.id,
      colonPath: t.path,
      fingerprint: `${(t.title || '').toLowerCase().trim()}|${(t.artist || '').toLowerCase().trim()}|${t.duration || 0}`,
    }))
    analysisTotalRef.current = jobs.length
    setAnalysisRunning(true)
    setAnalysisStatus(force ? `Re-measuring ${jobs.length.toLocaleString()} tempos…` : null)
    try {
      await window.electronAPI.audioAnalysisEnqueueMany(jobs)
    } catch (err) {
      setAnalysisRunning(false)
      setNotice(err instanceof Error ? err.message : 'Could not start audio analysis.', { kind: 'error' })
    }
  }, [analysisRunning, libState.tracks])

  const runAudioAnalysisBackfill = useCallback(() => {
    void enqueueAudioAnalysis(false)
  }, [enqueueAudioAnalysis])

  const confirmRemeasureTempos = useCallback(() => {
    setRemeasureConfirmOpen(false)
    void enqueueAudioAnalysis(true)
  }, [enqueueAudioAnalysis])

  const cancelAudioAnalysisBackfill = useCallback(async () => {
    await window.electronAPI.audioAnalysisClearQueue()
    setAnalysisRunning(false)
    setAnalysisStatus('Cancelled.')
    setTimeout(() => setAnalysisStatus(null), 4000)
  }, [])

  // Subscribe to worker progress: pipe per-track results into libState (so the
  // counter recomputes live) and flip running→false on completion. Status poll
  // surfaces the playback-paused state.
  useEffect(() => {
    if (!analysisRunning) return
    const unsubProgress = window.electronAPI.onAudioAnalysisProgress((payload) => {
      const { remaining, trackId, audioAnalysisAt, bpm, keyRoot, keyMode, camelotKey, keyConfidence } = payload
      if (typeof trackId === 'number' && typeof audioAnalysisAt === 'number') {
        const updates: { id: number; field: string; value: string | boolean }[] = [
          { id: trackId, field: 'audioAnalysisAt', value: String(audioAnalysisAt) },
        ]
        if (typeof bpm === 'number' && bpm > 0) updates.push({ id: trackId, field: 'bpm', value: String(bpm) })
        if (keyRoot) updates.push({ id: trackId, field: 'keyRoot', value: keyRoot })
        if (keyMode) updates.push({ id: trackId, field: 'keyMode', value: keyMode })
        if (camelotKey) updates.push({ id: trackId, field: 'camelotKey', value: camelotKey })
        if (typeof keyConfidence === 'number') updates.push({ id: trackId, field: 'keyConfidence', value: String(keyConfidence) })
        dispatch({ type: 'UPDATE_TRACKS', updates })
      }
      if (remaining === 0) {
        setAnalysisRunning(false)
        const sessionTotal = analysisTotalRef.current
        setAnalysisStatus(sessionTotal > 0 ? `Done — ${sessionTotal} tracks analyzed.` : 'Done — analysis complete.')
        setTimeout(() => setAnalysisStatus(null), 8000)
      }
    })
    const pollId = setInterval(async () => {
      const s = await window.electronAPI.audioAnalysisStatus()
      if (!s.ok) return
      if (s.isPlaybackActive) {
        setAnalysisStatus('Paused — playback active')
      } else {
        setAnalysisStatus((prev) => (prev === 'Paused — playback active' ? null : prev))
      }
      if (s.queueLength === 0 && !s.workerRunning) {
        setAnalysisRunning(false)
      }
    }, 2000)
    return () => {
      unsubProgress()
      clearInterval(pollId)
    }
  }, [analysisRunning, dispatch])

  // Analyzed/total/remaining — "analyzed" means timestamp set AND bpm produced
  // (a librosa failure leaves the timestamp but no bpm, so it stays "remaining"
  // and can be retried). Recomputes live as progress dispatches land.
  const audioAnalysisCounts = useMemo(() => {
    // Count the SAME songs the rest of the app counts: full-live-concert
    // territory (merged show + constituent tracks) is hidden from Songs
    // (LC-5), so the banner excludes it too — 8,551 vs 8,496 confusion
    // (Jake, 2026-07-19) came from this denominator mismatch. The
    // analyzer itself still walks everything; only the arithmetic shown
    // matches the visible library.
    const hidden = libraryHiddenTrackIds(new Set(libState.tracks.map((t) => t.id)))
    let analyzed = 0
    let total = 0
    for (const t of libState.tracks) {
      if (!t.path || hidden.has(t.id)) continue
      total++
      if (t.audioAnalysisAt && t.bpm) analyzed++
    }
    return { analyzed, total, remaining: total - analyzed }
  }, [libState.tracks])

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

      {brain && (() => {
        const n = (k: string) => Number(brain[k] || 0)
        const pct = (k: string) => n('tracks') > 0 ? Math.round((n(k) / n('tracks')) * 100) : 0
        const ageDays = brain.descriptorsMtime ? (Date.now() - Number(brain.descriptorsMtime)) / 86_400_000 : null
        const health: 'green' | 'amber' | 'red' = ageDays == null ? 'red' : ageDays < 1.5 ? 'green' : ageDays < 3.5 ? 'amber' : 'red'
        const stamp = brain.descriptorsMtime ? new Date(Number(brain.descriptorsMtime)).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never'
        return (
          <div className="mm-wall">
            <div className="mm-wall-head">
              <span className="mm-wall-title">THE BRAIN</span>
              <span className={`mm-wall-health mm-wall-health--${health}`}
                title="How fresh the nightly training is — red would have caught the week the trainer was silently down">
                ● last learned {stamp}
              </span>
            </div>
            <div className="mm-wall-tiles">
              <div className="mm-wall-tile" title="Songs where the brain has written a prose descriptor of how the track FEELS">
                <span className="mm-wall-num">{n('descriptors').toLocaleString()}</span>
                <span className="mm-wall-label">songs described · {pct('descriptors')}%</span>
              </div>
              <div className="mm-wall-tile" title="Descriptors enriched with lyric THEMES (the meaning pass)">
                <span className="mm-wall-num">{n('themed').toLocaleString()}</span>
                <span className="mm-wall-label">with themes</span>
              </div>
              <div className="mm-wall-tile" title="Songs with fetched lyrics">
                <span className="mm-wall-num">{n('lyrics').toLocaleString()}</span>
                <span className="mm-wall-label">lyrics on file</span>
              </div>
              <div className="mm-wall-tile" title="Genre taxonomy coverage">
                <span className="mm-wall-num">{pct('subgenred')}%</span>
                <span className="mm-wall-label">subgenred</span>
              </div>
              <div className="mm-wall-tile" title="Your 5-star exemplars — the taste anchors">
                <span className="mm-wall-num">{n('starred').toLocaleString()}</span>
                <span className="mm-wall-label">taste anchors</span>
              </div>
              <div className="mm-wall-tile" title="iPod activity syncs absorbed — including every song you personally added or pulled in review">
                <span className="mm-wall-num">{n('syncs')}<small> / {n('syncEdits')} edits</small></span>
                <span className="mm-wall-label">syncs learned</span>
              </div>
            </div>
          </div>
        )
      })()}

      <div className="musicman-content musicman-content--chat">
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
                        onClick={() => speakMessage(msg.contentRaw || msg.content, i)}
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

        {/* The one piece of his old repertoire with no other home: BPM/key
            analysis, which feeds DJ/vibe features. Compact strip, not a tab. */}
        <div className="musicman-analysis-strip">
          <span className="musicman-analysis-label">
            Library analysis · {audioAnalysisCounts.analyzed.toLocaleString()} / {audioAnalysisCounts.total.toLocaleString()} tracks have BPM + key
          </span>
          {analysisRunning ? (
            <div className="musicman-analysis-controls">
              <div className="musicman-org-bar-track" style={{ flex: 1, minWidth: 80 }}>
                <div className="musicman-org-bar-fill" style={{ width: `${(audioAnalysisCounts.analyzed / Math.max(audioAnalysisCounts.total, 1)) * 100}%` }} />
              </div>
              <button className="musicman-org-action-btn" onClick={cancelAudioAnalysisBackfill}>Cancel</button>
              {analysisStatus && <span className="musicman-analysis-status">{analysisStatus}</span>}
            </div>
          ) : (
            <div className="musicman-analysis-controls">
              <button
                className="musicman-org-action-btn"
                onClick={runAudioAnalysisBackfill}
                disabled={audioAnalysisCounts.remaining === 0}
              >
                {audioAnalysisCounts.remaining === 0
                  ? 'All tracks analyzed'
                  : `Analyze ${audioAnalysisCounts.remaining.toLocaleString()} remaining`}
              </button>
              <button
                className="musicman-org-action-btn"
                onClick={() => setRemeasureConfirmOpen(true)}
                disabled={audioAnalysisCounts.total === 0}
                title="Re-run BPM/key analysis on every track — fixes half/double tempo errors from older analysis"
              >
                Re-measure tempos
              </button>
              {analysisStatus && <span className="musicman-analysis-status">{analysisStatus}</span>}
            </div>
          )}
        </div>
        {remeasureConfirmOpen && (
          <ConfirmDialog
            message={`Re-measure BPM and key on all ${audioAnalysisCounts.total.toLocaleString()} tracks?`}
            detail="Runs the newer tempo arbiter on every file. Wrong half/double BPMs get corrected into metadata overrides. Playback pauses analysis automatically — leave the app idle while it works."
            confirmLabel="Re-measure"
            cancelLabel="Cancel"
            destructive={false}
            onConfirm={confirmRemeasureTempos}
            onCancel={() => setRemeasureConfirmOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
