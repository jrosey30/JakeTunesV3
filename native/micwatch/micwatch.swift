// micwatch — the microphone sensor behind JakeTunes' "Pause for video calls".
//
// Prints ONE JSON line per state change on stdout, and the current state once
// at start:
//
//   {"bundles":["us.zoom.xos"],"input":true,"pids":[812]}
//   {"bundles":[],"input":false,"pids":[]}
//
// "input" is true when at least one process on this Mac is running audio
// INPUT (using the microphone) according to CoreAudio's per-process state
// (macOS 14+: kAudioHardwarePropertyProcessObjectList lists an AudioProcess
// object per audio client, each with PID / BundleID / IsRunningInput). That
// is what a call looks like from the outside — FaceTime, Zoom, Teams, Webex,
// Google Meet in any browser, a Slack huddle, Discord — with no per-app hack.
//
// Nothing is excluded here. The Node side (src/main/pause-for-calls.ts) drops
// JakeTunes' own processes, because the app records the mic itself (Savant
// song recognition, mixtape intros).
//
// Low power: property listeners on the system object's process list and on
// every process object's IsRunningInput, plus a 2 s poll (with leeway) as a
// safety net. No busy loop. Reading these properties never opens the
// microphone and never triggers a TCC prompt.
//
// Exit codes: 0 — stdin closed (the parent went away) or --dump finished;
//             2 — unsupported (reason on stderr, one line).
//
//   micwatch          stream state changes until stdin closes
//   micwatch --dump   print every audio process once (debug aid) and exit
//
// Built by scripts/build-native.sh into native/bin/micwatch (gitignored) and
// shipped as Resources/bin/micwatch (package.json build.extraResources).
import CoreAudio
import Foundation

let EXIT_UNSUPPORTED: Int32 = 2

func fail(_ reason: String) -> Never {
  FileHandle.standardError.write(("unsupported: " + reason + "\n").data(using: .utf8)!)
  exit(EXIT_UNSUPPORTED)
}

let minVersion = OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 0)
guard ProcessInfo.processInfo.isOperatingSystemAtLeast(minVersion) else {
  fail("macOS 14 or newer is required for per-process audio state (this is \(ProcessInfo.processInfo.operatingSystemVersionString))")
}

// ── CoreAudio property helpers ──────────────────────────────────────────

@Sendable func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

@Sendable func u32(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var addr = address(selector)
  var value = UInt32(0)
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

@Sendable func i32(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Int32? {
  var addr = address(selector)
  var value = Int32(0)
  var size = UInt32(MemoryLayout<Int32>.size)
  return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

@Sendable func str(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = address(selector)
  var value: Unmanaged<CFString>? = nil
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr, let s = value?.takeRetainedValue() else { return nil }
  return s as String
}

/// Every AudioProcess object CoreAudio knows about, or nil when the property
/// itself is unavailable (older OS, broken coreaudiod).
@Sendable func processObjects() -> [AudioObjectID]? {
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  let system = AudioObjectID(kAudioObjectSystemObject)
  var size = UInt32(0)
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return nil }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return nil }
  return ids
}

guard processObjects() != nil else {
  fail("CoreAudio did not return the process object list (kAudioHardwarePropertyProcessObjectList)")
}

// ── --dump: one listing, then exit ──────────────────────────────────────

if CommandLine.arguments.dropFirst().contains("--dump") {
  let list = processObjects() ?? []
  print("processes: \(list.count)")
  for obj in list {
    let pid = i32(obj, kAudioProcessPropertyPID) ?? -1
    let bundle = str(obj, kAudioProcessPropertyBundleID) ?? ""
    let running = u32(obj, kAudioProcessPropertyIsRunning) ?? 9
    let input = u32(obj, kAudioProcessPropertyIsRunningInput) ?? 9
    let output = u32(obj, kAudioProcessPropertyIsRunningOutput) ?? 9
    print("pid=\(pid) bundle=\(bundle.isEmpty ? "-" : bundle) running=\(running) input=\(input) output=\(output)")
  }
  exit(0)
}

// ── Streaming mode ──────────────────────────────────────────────────────

struct Entry {
  let pid: Int32
  let bundle: String
}

// Everything below runs on this one serial queue (listener blocks, the
// poll timer), so the mutable state needs no further locking.
let queue = DispatchQueue(label: "micwatch")
var listening = Set<AudioObjectID>()
var lastLine: String? = nil

setvbuf(stdout, nil, _IOLBF, 0)

/// Processes currently running input, sorted by pid for a stable encoding.
@Sendable func snapshot() -> [Entry] {
  var out: [Entry] = []
  for obj in processObjects() ?? [] {
    guard u32(obj, kAudioProcessPropertyIsRunningInput) == 1 else { continue }
    out.append(Entry(pid: i32(obj, kAudioProcessPropertyPID) ?? -1, bundle: str(obj, kAudioProcessPropertyBundleID) ?? ""))
  }
  return out.sorted { $0.pid < $1.pid }
}

// ⚠️ TWIN: src/main/pause-for-calls-core.ts parseStateLine() reads exactly this
// shape ({"bundles":[…],"input":bool,"pids":[…]}); change both or neither.
@Sendable func encode(_ entries: [Entry]) -> String {
  let object: [String: Any] = [
    "input": !entries.isEmpty,
    "pids": entries.map { Int($0.pid) },
    "bundles": entries.map { $0.bundle },
  ]
  // sortedKeys keeps the line byte-stable, so "changed?" is a string compare.
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
    return "{\"bundles\":[],\"input\":false,\"pids\":[]}"
  }
  return String(decoding: data, as: UTF8.self)
}

@Sendable func publish(force: Bool = false) {
  let line = encode(snapshot())
  if force || line != lastLine {
    lastLine = line
    print(line)
    fflush(stdout)
  }
}

/// Listen to IsRunningInput on every process object we have not seen yet.
/// Objects that disappeared are forgotten (CoreAudio tore them down; there
/// is nothing left to remove a listener from).
@Sendable func refreshListeners() {
  let current = Set(processObjects() ?? [])
  for obj in current.subtracting(listening) {
    var addr = address(kAudioProcessPropertyIsRunningInput)
    let status = AudioObjectAddPropertyListenerBlock(obj, &addr, queue) { _, _ in publish() }
    if status == noErr { listening.insert(obj) }
  }
  listening = listening.intersection(current)
}

// New or vanished audio clients → re-attach per-process listeners, re-check.
var listAddr = address(kAudioHardwarePropertyProcessObjectList)
let listStatus = AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &listAddr, queue) { _, _ in
  refreshListeners()
  publish()
}
guard listStatus == noErr else {
  fail("could not listen to the process object list (OSStatus \(listStatus))")
}

// Safety net: a 2 s poll with generous leeway (coalesced by the kernel).
let timer = DispatchSource.makeTimerSource(queue: queue)
timer.schedule(deadline: .now() + 2, repeating: 2.0, leeway: .milliseconds(500))
timer.setEventHandler {
  refreshListeners()
  publish()
}
timer.resume()

// The parent keeps our stdin open; EOF means it is gone, so we go too
// (never an orphaned sensor after the app quits).
let stdinWatch = Thread {
  while readLine(strippingNewline: true) != nil { /* ignore input */ }
  exit(0)
}
stdinWatch.start()

queue.async {
  refreshListeners()
  publish(force: true)   // the current state, once, at start
}

dispatchMain()
