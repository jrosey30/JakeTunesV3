import CoreAudio
import Foundation

// List all audio output devices with their transport type, or set the default output device
// Usage: swift audio_helper.swift list
//        swift audio_helper.swift set <deviceID>

func getDeviceName(_ id: AudioDeviceID) -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceNameCFString,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name)
    return name as String
}

func getTransportType(_ id: AudioDeviceID) -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyTransportType,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var transport: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    AudioObjectGetPropertyData(id, &address, 0, nil, &size, &transport)
    switch transport {
    case kAudioDeviceTransportTypeBuiltIn: return "builtin"
    case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "bluetooth"
    case kAudioDeviceTransportTypeAirPlay: return "airplay"
    case kAudioDeviceTransportTypeUSB: return "usb"
    case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: return "hdmi"
    case kAudioDeviceTransportTypeVirtual: return "virtual"
    case kAudioDeviceTransportTypeAggregate: return "aggregate"
    default: return "other"
    }
}

func hasOutputChannels(_ id: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    let status = AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size)
    if status != noErr || size == 0 { return false }

    let bufferListPointer = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { bufferListPointer.deallocate() }
    let result = AudioObjectGetPropertyData(id, &address, 0, nil, &size, bufferListPointer)
    if result != noErr { return false }

    let bufferList = bufferListPointer.assumingMemoryBound(to: AudioBufferList.self).pointee
    if bufferList.mNumberBuffers == 0 { return false }

    // Check first buffer has channels
    return bufferList.mBuffers.mNumberChannels > 0
}

func getDefaultOutputDevice() -> AudioDeviceID {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var deviceId: AudioDeviceID = 0
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceId)
    return deviceId
}

func listDevices() {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var ids = [AudioDeviceID](repeating: 0, count: count)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids)

    let defaultId = getDefaultOutputDevice()
    var devices: [[String: Any]] = []

    for id in ids {
        guard hasOutputChannels(id) else { continue }
        let name = getDeviceName(id)
        let transport = getTransportType(id)
        devices.append([
            "id": Int(id),
            "name": name,
            "transport": transport,
            "isDefault": id == defaultId
        ])
    }

    let json = try! JSONSerialization.data(withJSONObject: devices, options: .prettyPrinted)
    print(String(data: json, encoding: .utf8)!)
}

func setDefaultDevice(_ deviceId: UInt32) {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var id = deviceId
    let status = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0, nil,
        UInt32(MemoryLayout<AudioDeviceID>.size),
        &id
    )
    if status == noErr {
        print("{\"ok\":true}")
    } else {
        print("{\"ok\":false,\"error\":\"CoreAudio error \\(status)\"}")
    }
}

// Main
let args = CommandLine.arguments
if args.count < 2 {
    print("Usage: audio_helper list | set <deviceId>")
    exit(1)
}

switch args[1] {
case "list":
    listDevices()
case "set":
    guard args.count >= 3, let id = UInt32(args[2]) else {
        print("{\"ok\":false,\"error\":\"Missing device ID\"}")
        exit(1)
    }
    setDefaultDevice(id)
default:
    print("Usage: audio_helper list | set <deviceId>")
    exit(1)
}
