/**
 * MusicManChat — the conversation with the Music Man, one component, two
 * homes (2026-09-02, Jake: "a button i press and then a narrow window …
 * slides out from the right? or should it still have its own page?" —
 * both). The PAGE (MusicManView) renders it with the history rail; the
 * DRAWER (MusicManDrawer, the Genius-sidebar slot next to Up Next) renders
 * the compact variant seeded with what the listener is looking at.
 *
 * All chat state, history persistence, sending, and the ElevenLabs speaker
 * button live here so the two surfaces cannot drift.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { audioFromBase64Mpeg } from '../audio/base64-audio'
import { useLibrary } from '../context/LibraryContext'
import { attachClipToBroadcast, detachClipFromBroadcast } from '../audio/eq'
import { setNotice } from '../activity'
import { ChatConversation } from '../types'

export const CHAT_INTROS = [
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

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  // 4.5: tagged version of the assistant's response (with ElevenLabs
  // [scoff]/[laughs]/[softer]/etc. inline). Hidden from display — `content`
  // is the stripped-clean version — but used by the speaker button so v3 still
  // performs the dialogue expressively when the user opts into hearing it.
  contentRaw?: string
}

interface Props {
  /** 'page' shows the history rail; 'drawer' is the narrow companion. */
  variant: 'page' | 'drawer'
  /** What the listener is looking at / hearing — sent with every message
   *  so the answer lands on the thing in front of them. Drawer only. */
  contextLine?: string
}

export default function MusicManChat({ variant, contextLine }: Props) {
  const { dispatch } = useLibrary()
  const [chatInput, setChatInput] = useState('')
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [speakingIdx, setSpeakingIdx] = useState(-1)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // The drawer opens to type — focus the box on mount.
  useEffect(() => {
    if (variant === 'drawer') inputRef.current?.focus()
  }, [variant])

  // Stop any in-flight TTS when the surface unmounts (navigating away,
  // closing the drawer). Detach → pause → null, then tell the rest of the
  // app speaking has ended so the avatar/EQ state resets.
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
      const result = await window.electronAPI.musicmanChat(newMessages, contextLine || undefined)
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

  const intro = CHAT_INTROS[Math.floor(new Date().getDate() + new Date().getMonth() * 31) % CHAT_INTROS.length]

  return (
    <div className={`musicman-chat-layout musicman-chat-layout--${variant}`}>
      {variant === 'page' && conversations.length > 0 && (
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
          {variant === 'page' && (
            <div className="musicman-chat-msg musicman-chat-msg--system">
              <p>{intro}</p>
            </div>
          )}
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
          {variant === 'drawer' && messages.length > 0 && (
            <button className="musicman-chat-send musicman-chat-clear" onClick={startNewChat} title="Start a new conversation" disabled={isLoading}>New</button>
          )}
          <input
            ref={inputRef}
            className="musicman-chat-input"
            type="text"
            placeholder={variant === 'drawer' ? 'Ask about this…' : 'Ask The Music Man anything...'}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleChatKeyDown}
            disabled={isLoading}
          />
          <button className="musicman-chat-send" disabled={!chatInput.trim() || isLoading} onClick={sendMessage}>Ask</button>
        </div>
      </div>
    </div>
  )
}
