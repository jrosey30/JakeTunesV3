import MusicManChat from '../components/MusicManChat'
import musicmanAvatar from '../assets/musicman-avatar.png'
import '../styles/musicman.css'

// V7: the Music Man page is only the chat. The brain's tile wall, the "In the
// Store" badge and the tempo-and-key strip are gone: the nightly check
// (main/self-care.ts) measures songs that have no tempo yet, by itself.

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

export default function MusicManView() {
  return (
    <div className="musicman">
      <div className="musicman-header">
        <div className="musicman-avatar">
          <img src={musicmanAvatar} alt="The Music Man" width="88" height="88" />
        </div>
        <div className="musicman-header-text">
          <div className="musicman-title">The Music Man</div>
          <div className="musicman-tagline">"{TAGLINES[Math.floor(new Date().getDate() + new Date().getMonth() * 31) % TAGLINES.length]}"</div>
        </div>
      </div>

      <div className="musicman-content musicman-content--chat">
        {/* The conversation lives in MusicManChat — shared with the
            right-hand drawer (2026-09-02) so the two never drift. */}
        <MusicManChat variant="page" />
      </div>
    </div>
  )
}
