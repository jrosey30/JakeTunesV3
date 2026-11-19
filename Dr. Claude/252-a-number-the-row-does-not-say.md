# Brief 252 — A number the row doesn't say is another track (the desktop's half)

**Date:** 2026-11-19
**Repo:** JakeTunes V3 (desktop)
**Twin of:** JakeTunesMobile Brief 252 (jrosey30/JakeTunesMobile#822, merged 2026-11-19 as 988208e3, live on homemini). Jake said yes to the desktop's version next.

## Why

A row that names a compilation has no clock: Apple's length for it is a compilation's, so neither app holds a file to it. Jake's row for "White Lines (Don't Do It)" by Grandmaster & Melle Mel names Apple's Various Artists "1983" (460.4 s). His copy is the 459.7 s single. With no clock, only the title judge stands between that row and Qobuz's "White Lines 89" by Melle Mel (track 54918217, 421 s, on "The Greatest Hip-Hop Songs Vol. 1"), and it doesn't hold: `recoTitleMatches`' last arm passes two titles when the first three quarters of the shorter one agree, and "whiteline" is three quarters of "whitelines89".

On V3 main (97021b5f) the desktop's judge passes all of it: `titleReads("White Lines (Don't Do It)", "White Lines 89")` is true, `verifyCandidate` calls the 89 exact for the "1983" row, `rankStreamripCandidates` ranks it, and "Revolution 9", "Obstacle 2", "Another Brick in the Wall, Pt. 2" and "Public Service Announcement 2000" come out exact for "Revolution 1", "Obstacle 1", Pt. 1 and "Public Service Announcement".

## The rule (the phone's, written the same)

`addsNumber(want, got)` in `src/main/streamrip-match.ts`, with `songName`, `numbersSaid`, `numberWord`, `romanNumeral`, `NAMES_A_PART` and `FIRST_PART`, ported from the phone's `backend/src/util/streamripMatch.ts` line for line. Both sides carry ⚠️ TWIN. A song's title whose own name carries a number the request doesn't say is another track.

- **Only the name counts:** the title without its edition labels, without any bracket (innermost first), and without anything after a spaced dash. A year in a bracket or a dash tail is a remaster stamp or a live date, and the version checks and the clock judge those, as before.
- **The request may say the number any way:** in digits anywhere in it, in words ("Anthem Part Two" for "Anthem, Pt. 2"), in roman numerals ("(Part II)" for "Pt. 2"), or as half a year ('89 for 1989).
- **Spacing never counts.** The name is read folded and split at its marks, and a number is added only when both readings add one: "54-46 That's My Number" is "5446 Thats My Number", "1 2 X U" is "12XU", "10:00PM" is 10 PM. A 0 adds nothing ("Insomnia 2.0").
- **A first part is the song when the request names no part** ("America Is My Home, Pt. 1", 202 s, for "America Is My Home", 203 s). "Pt. 2" still counts.

Asked in the same three places as on the phone, for songs only:

- **`rankStreamripCandidates`**, for `wantMediaType` 'track' and a summary title under streamrip's 50-character cut (`SUMMARY_TITLE_CUT`; "…, Pt. 12" can be cut to "…, Pt. 1"). Such a hit is never offered, so it costs no question to Qobuz and no fetch. It is not reported among `rejectedVersions`: it is another track, not a version of this one.
- **`verifyCandidate`'s title step:** a 'title' reject, "is titled “White Lines 89”, not “White Lines (Don't Do It)” (it adds 89)". This judges Qobuz's whole title before a fetch (`judgeHitsByMeta`, the album door's tracks too), the file's tags after one, and Bandcamp's and SoundCloud's files.
- **`hitsByAnotherName`:** a hit the ranking would refuse for its number doesn't send the walk to MusicBrainz.

Never in `titleReads`, which `onWantedAlbum` reads album names with: "OK Computer OKNOTOK 1997 2017" stays OK Computer.

## Two desktop decisions

**1. What the rule reads a title through.** The brief said `(t) => searchTitle(t) || t`. Here it is that, and then without a credit written outside brackets (`numberedName`): searchTitle keeps "Ain't Hard 2 Find feat. E-40, Richie Rich, B-Legit & C-Bo" whole, so the rule read "40" as added, and "a lot ft. 21 Savage" as adding 21. The phone's `withoutEditionLabels` drops that credit, and since `songName` takes off every bracket and dash tail itself, the credit is the only thing the phone's `plain` changes in what the rule reads. So the twins stay one rule. On Jake's data the two choices refuse exactly the same pairs (below); the phone's test for the 2Pac title fails with `searchTitle` alone, and a mutation pins it.

**2. A SoundCloud upload's "Artist - Title".** `verifyCandidate` already reads "Villanova - Mr Vibe" as "Mr Vibe" when what precedes the dash names the artist (`withoutArtistPrefix`). The number is read from what follows the artist when that reads as the song, and from the tag as written otherwise:

- "blink-182 - All The Small Things" for blink-182's own song (168.2 s, his library): exact. The whole tag reads as the song too ("allthesmallthings" is inside it), and its name, everything before the spaced dash, would be "blink-182": reading the tag as written would add 182. Jake has 108 songs by blink-182, and others by 311, Sum 41, 2Pac, 50 Cent, 21 Savage, D12, Jurassic 5, Collect 200.
- "The Beatles - Revolution 9" for "Revolution 1", no clock: refused, it adds 9.
- "Collect 200 - 2023 Remaster" for Collect 200's own "Collect 200": what follows the dash is no song, so the tag as written is read, and it says 200. Exact.

## Measured, 2026-11-19, main (97021b5f) against this branch

**Pairs in his library.** Every ordered pair of his 14,338 songs by one artist (as the gate reads artists) whose titles differ and that the desktop's `titleReads` reads as one title: 812 (request, file) pairs, the same 812 as the phone counted. `addsNumber` says 48 add a number, the phone's same 48. Through `verifyCandidate` (request: title and artist; file: title, artist and album; no clock, as on the White Lines row), old against new, 47 verdicts change and nothing else does:

- 46 exact before, refused now: 30 pairs of songs, both ways round where both read. Every one is another track: Pink Floyd's "Pigs on the Wing 1" and "2" (84.7 / 86.9 s) and the three "Another Brick in the Wall" parts, the Beatles' "Revolution", "Revolution 1" and "Revolution 9", Interpol's "Obstacle 1" and "2", Failure's three "Segue"s, Geese's three "A Beautiful Memory" parts, the Flaming Lips' "Yoshimi" Pt. 1 and 2, Big Pun's "Pakinamac" parts, Sublime's "Maybe Partying Will Help" parts, Slipknot's "Vermilion" and "Vermilion, Pt. 2", blink-182's "Anthem" and "Anthem Part Two" against "ANTHEM PART 3", Palmeira's "Na Baixa Do Sapateiro" and its "Part 2", Prairie Princess's "Powerline" and "Powerline Part 2", Eminem's two "Public Service Announcement"s, Drake's "Started From the Bottom" and "Star67", Linkin Park's "Points Of Authority" and "One Step Closer" against the Collision Course mash-up, and the Nirvana Amsterdam '91 full set (2,583 s) against Unplugged's "Come As You Are (Live)".
- Six of them run within 5 s of each other (Pigs on the Wing, two Sublime parts, blink-182's Anthem, Palmeira): no clock could tell those apart.
- 1 was refused before as another version and is refused now for its number first: The Orb's "Pi Part 1" for "Pi (Part 2) (Orb Remix)".
- The 48th, Nirvana's Amsterdam '91 set for the studio "Come as You Are", was refused before as live and still is.

With `searchTitle` alone as what the rule reads through, the same 48 (the phone's measurement, `v3-plain.mts`, and this one agree).

**His copies.** Of the 936 rows the desktop's walks were measured on, 868 carry the title of his own copy. Held against what each row asks for (his copy's title, artist, album and length), `verifyCandidate` passes 829 before and 829 after, and changes no verdict. `addsNumber` refuses none of the 868.

**The walk.** The desktop's real `streamrip:download-by-query` handler on Electron's runtime (the desktop walk harness from Brief 251's measurements), over the 936 real rows it was measured on (209 Listen List rows, 55 from the downloader's notes, 23 real failures, 64 rap rows Apple labels clean, 293 of his Bandcamp songs, 292 Apple-matched library songs), nothing imported, both builds on the same saved answers. The phone harness's saved Qobuz searches and track answers were merged in (their keys are the same as the desktop's), and the 81 rows still missing a Qobuz, MusicBrainz or Apple answer were filled online and walked again.

- **No row lands differently.** 756 rows land something on both builds, 757 fetches on both, 664 of the 886 rows with his copy's length land within 3 s of it on both. On the 81 filled rows, again identical.
- **One row asks one question fewer.** DJ Duke's "Blow Your Whistle": the branch leaves out Qobuz's "Blow Your Whistle '21" (a 2021 rework the row doesn't name); both builds land the same 168 s copy.
- **Why White Lines doesn't change here:** the desktop asks Qobuz for the whole title first ("Grandmaster & Melle Mel White Lines (Don't Do It)"), and Qobuz's real answer, 10 hits, has no "White Lines 89", so Jake's row never meets it on either build. It does when that first answer is empty: the walk then asks without the bracket, that answer has the 89 as hit 23 of 25, and main imports it after one fetch (the walk test below, run on main's code). This branch fetches nothing.
- **Not measured:** Bandcamp's search for 153 rows was never asked (no Bandcamp search from a Node backend), so on those rows the Bandcamp lane did not run on either build.

## Tests

- `streamrip-match.test.ts`: the phone's Brief 252 tests, on the same real answers: the ranking and `hitsByAnotherName` on Qobuz's answer, every spelling of one recording's number, brackets, credits, roman numerals, words, half years, marks between digits, first parts, labels, albums, and a summary cut at 50 characters.
- `exact-recording.test.ts`: `verifyCandidate` and `judgeHitsByMeta` on the White Lines row and Qobuz's answers for its two hits; his own pairs that are other tracks; his single still exact; the artist prefix (blink-182, the Beatles, Collect 200).
- `streamrip-reach.test.ts`: the White Lines row through the real `streamrip:download-by-query` handler, Qobuz's and Apple's answers of 2026-11-19 written inline (not in `fixtures/qobuz-walks.json`, which both repos share byte for byte). Jake's row as Qobuz answers it lands nothing; when Qobuz answers the whole title with nothing, the walk's second search finds "White Lines 89", and main imports it (one fetch) where this branch fetches nothing; his single, had Qobuz carried it, still comes in.
- 32 mutations (the phone's 27 written against this code, and 5 for the desktop's own decisions: the credit reader, the upload's artist both ways, a number reported as a version, the rule inside `titleReads`), each in a copy of the tree, against the 17 downloader test files (635 tests, green before and after): 31 caught. The 32nd is the phone's equivalent one: once brackets come off innermost first, any bracket left never closes.
- A song named with a number keeps it (Jake asked: "what if its like pop song 89. or 99 BPM"): the request says the number, so "Pop Song 89", "Pop Song '89", "99BPM (Radio Edit)" and "Ninety-Nine BPM" all pass. 504 of his 14,338 songs have a digit in their title; none of his copies is refused.
- `npm run check` passes (both tsconfigs at zero, the whole suite), run by the pre-commit gate. All of it ran through `~/bin/jt-heavy`; the walks waited on the network at `taskpolicy -b nice -n 19`.

## Known gaps

- **Numbers in words or roman numerals in the found title don't count** (the phone's gap too): "Damaged II" still reads as "Damaged I" until a clock says no.
- **A bracket or a dash tail is never read:** Qobuz's "Say Anything (Else) - 2025" is left to the clock.
- **A row with no part that means a later one** ("Another Brick in the Wall", with no Apple match to say "Pt. 2") can now land only Pt. 1.
- **Bandcamp's page list** (`bcNamed` in the store) is filtered by `titleMatches` without the rule, so a Bandcamp page for another numbered track could still take one of the lane's two tries; `verifyCandidate` then refuses the file. The phone judges a Bandcamp page with the whole gate before fetching it.
- **Album downloads** read track titles with `titleReads` (`album-identity.ts`: the tracklist proof, library ownership, completion). Not touched here: "Pigs on the Wing 2" still reads as "Pigs on the Wing 1" there, and the two run 2.2 s apart.

## Twin

The phone's `addsNumber` comment and the Downloads line of JakeTunesMobile's CLAUDE.md say the desktop doesn't have the rule yet. With this merged, that is out of date. Nothing in JakeTunesMobile is edited from here.
