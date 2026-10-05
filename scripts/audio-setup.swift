// Creates a Multi-Output device "Meeting" = <your current output> + BlackHole 2ch and makes it the
// system output, so you hear the call normally while BlackHole gets a copy for Souffleur.
//   swift scripts/audio-setup.swift create    → create (or recreate) "Meeting", set as default output
//   swift scripts/audio-setup.swift restore   → set default output back to the device saved by `create`
//   swift scripts/audio-setup.swift status    → show current default output and whether "Meeting" exists
import CoreAudio
import Foundation

let meetingName = "Meeting"
let meetingUID = "com.souffleur.meeting"
let stateFile = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("souffleur/audio-prev-output.txt")

func fail(_ msg: String) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(1) }

func stringProp(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString? = nil
    let st = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0) }
    return st == noErr ? value as String? : nil
}
func name(_ id: AudioObjectID) -> String { stringProp(id, kAudioObjectPropertyName) ?? "?" }
func uid(_ id: AudioObjectID) -> String { stringProp(id, kAudioDevicePropertyDeviceUID) ?? "?" }

func allDevices() -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}
func outputChannels(_ id: AudioObjectID) -> Int {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let buf = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { buf.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, buf) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(buf).reduce(0) { $0 + Int($1.mNumberChannels) }
}
func defaultOutput() -> AudioObjectID {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var id: AudioObjectID = 0; var size = UInt32(MemoryLayout<AudioObjectID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id)
    return id
}
func setDefaultOutput(_ id: AudioObjectID) {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var v = id
    let st = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, UInt32(MemoryLayout<AudioObjectID>.size), &v)
    if st != noErr { fail("Impossible de changer la sortie par défaut (OSStatus \(st))") }
}
func find(uid target: String) -> AudioObjectID? { allDevices().first { uid($0) == target } }
func find(nameContains s: String) -> AudioObjectID? { allDevices().first { name($0).localizedCaseInsensitiveContains(s) } }

let cmd = CommandLine.arguments.dropFirst().first ?? "status"
switch cmd {
case "status":
    let d = defaultOutput()
    print("Sortie par défaut : \(name(d))")
    print("Device Meeting    : \(find(uid: meetingUID) != nil ? "existe" : "absent")")
    print("BlackHole 2ch     : \(find(nameContains: "BlackHole") != nil ? "présent" : "ABSENT")")

case "create":
    guard let bh = find(nameContains: "BlackHole") else { fail("BlackHole 2ch introuvable — installe-le : brew install blackhole-2ch") }
    var phones = defaultOutput()
    if uid(phones) == meetingUID {
        // Already on Meeting: reuse the headphones saved last time
        guard let prev = try? String(contentsOf: stateFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), let p = find(uid: prev) else {
            fail("La sortie actuelle est déjà Meeting. Choisis d'abord tes écouteurs dans Réglages → Son, puis relance.")
        }
        phones = p
    }
    guard outputChannels(phones) > 0, phones != bh else { fail("La sortie actuelle (\(name(phones))) n'est pas un casque/haut-parleur utilisable.") }
    if let old = find(uid: meetingUID) { AudioHardwareDestroyAggregateDevice(old) }
    let desc: [String: Any] = [
        "name": meetingName,
        "uid": meetingUID,
        "stacked": 1,                                   // Multi-Output (not aggregate input)
        "private": 0,
        "master": uid(phones),                          // clock source = the real hardware
        "subdevices": [
            ["uid": uid(phones)],
            ["uid": uid(bh), "drift": 1],               // drift compensation on the virtual device
        ],
    ]
    var newID: AudioObjectID = 0
    let st = AudioHardwareCreateAggregateDevice(desc as CFDictionary, &newID)
    if st != noErr { fail("Création du Multi-Output échouée (OSStatus \(st))") }
    try? FileManager.default.createDirectory(at: stateFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    do { try uid(phones).write(to: stateFile, atomically: true, encoding: .utf8) }
    catch { fail("Impossible d'enregistrer la sortie audio actuelle (\(stateFile.path)) : \(error)") }
    usleep(300_000) // let CoreAudio publish the device before selecting it
    setDefaultOutput(newID)
    print("OK — sortie système = \"\(meetingName)\" (\(name(phones)) + \(name(bh))).")
    print("Règle le volume de \(name(phones)) AVANT : les touches volume ne marchent pas sur un Multi-Output.")
    print("Retour normal : swift scripts/audio-setup.swift restore")

case "restore":
    guard let prev = try? String(contentsOf: stateFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), let p = find(uid: prev) else {
        fail("Aucune sortie précédente enregistrée (ou device débranché). Choisis ta sortie dans Réglages → Son.")
    }
    setDefaultOutput(p)
    print("OK — sortie système = \(name(p)).")

default:
    fail("Usage: swift scripts/audio-setup.swift create|restore|status")
}
