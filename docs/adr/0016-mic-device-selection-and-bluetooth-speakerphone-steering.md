# Mic device selection, and steering off a Bluetooth accessory's own mic by default

## The hazard, precisely

Once a Bluetooth speaker or headset is paired, a plain `getUserMedia({ audio:
… })` request with no device chosen doesn't reliably land on the phone's own
mic. On Android, `AudioManager` hints apps toward a connected accessory's mic
as soon as one is available, and most apps — this one included, before this
change — follow that hint with no explicit choice at all. That's what forces
the Bluetooth link into HFP, the low-quality, bidirectional call profile, even
though nothing here ever wanted the accessory's mic: whatever else is playing
over the same link's high-quality A2DP profile degrades the instant the game's
mic session opens, for a reason the player did nothing to cause and has no way
to see.

## Decision: `createMicSource` steers onto the "Speakerphone" route itself, by default

Chrome on Android enumerates its audio *routes* as pseudo mic devices —
"Speakerphone", "Earpiece", "Wired Headset", "Bluetooth …" — rather than
physical hardware. `engine/source.ts` now opens the default stream first (as
before), then — only when the caller asked for "whatever's default", i.e.
passed no explicit device — checks the now-labelled device list for a
"Speakerphone" entry (`pickSpeakerphoneDevice`, a pure string-match function,
unit-tested directly) and reopens onto it if one exists and the default
stream didn't already land there. "Speakerphone" is also the better route on
its own merits even with nothing Bluetooth involved: "Earpiece", the other
common default, is built for a handset held to the ear — narrow pickup, quiet
at any distance a phone propped up or laid down actually needs.

This is a mitigation, not a fix, and the doc comment on `createMicSource` says
so rather than overclaiming: A2DP (high-quality, output-only) and HFP
(call-quality, bidirectional) are competing profiles most Bluetooth
accessories cannot run at once, so the moment *any* app opens a recording
session, the OS tends to renegotiate the link to HFP regardless of which mic
that session actually reads from — a limit one level below anything a web
page can reach into. Native apps have an OS-level opt-out
(`AVAudioSessionCategoryOptionAllowBluetoothA2DP` on iOS; nothing analogous is
exposed to web JS on either platform). What steering *does* fix is the
self-inflicted half: this app dragging the link into HFP on its own, for no
reason, because it never made an explicit choice. iOS and desktop expose no
such pseudo-devices at all, so `pickSpeakerphoneDevice` finds nothing and this
is a silent no-op there, same as always.

## Decision: an explicit override lives at its own route, not folded into any game's gate

`sourceGate` (`screens/source-picker.ts`) is a pre-permission gate — it runs
*before* `getUserMedia` is ever called, so device labels aren't available to
offer a choice from there even if the shape fit. And the choice this ADR adds
is a standing preference, not a per-round one: nobody wants to re-pick their
mic at the start of every game. So `screens/mic-setup.ts` is its own screen at
`#/mic-setup`, reached from a new "Microphone" card in the menu's `TOOLS`
section (alongside "Signal scope") rather than a fourth row on the
calibration-profile-backed `setupPanel` — device choice isn't part of
`CalibrationProfile`, has no "done" state to render, and doesn't gate any
game the way Room/Voice control do.

The screen opens the mic once (`ensureMicSession()`, the existing shared
gate pattern from `latency-setup.ts`), then lists every input
(`listMicDevices()`) as a row per device plus a "System default" row, each
with a "Use" button; `selectMicDevice(deviceId | null)` in `engine/session.ts`
reopens the session on that specific device. A `devicechange` listener
refreshes the list live if a Bluetooth accessory connects or disconnects
while the screen is open.

**Why the picker can show a device other than what was clicked.** Choosing
"System default" still goes through `createMicSource`'s own steering, so it
can resolve to the concrete Speakerphone device rather than staying
"default" — the same divergence Auralux's reference implementation
documents. The screen tracks `session.source.deviceId` (a new optional field
on `AudioSource`, populated from `MediaStreamTrack.getSettings().deviceId`)
as the source of truth for which row shows "Active", not whichever row was
last clicked, so the picker always reflects what's actually open rather than
what was last requested.

## Decision: `ensureMicSession()`'s existing no-argument callers are untouched

`ensureMicSession` gained an optional `deviceId` parameter, but its
short-circuit — "an already-open mic session, on whichever device, satisfies
a call with no explicit device" — is unchanged, and every existing caller
(`play.ts`, `scope.ts`, `calibrate.ts`, `latency-setup.ts`) still calls it
with no arguments at all. Only `selectMicDevice` needs a *specific* device: it
calls `stopSession()` first so the reuse branch never applies, then calls
`ensureMicSession(deviceId)` to actually open the requested one. This keeps
the change additive with zero behavioural risk to every screen that isn't
`mic-setup.ts`.

## Consequences

- `AudioSource` (`engine/types.ts`) gained an optional `deviceId` field.
  `FileSource` never sets it; only a mic source does, and only when the
  browser reports one back.
- `createMicSource`, `ensureMicSession`, and the new `selectMicDevice` all
  take an optional device parameter now, but none of the prior call sites had
  to change — this is a pure addition to the shape they already had.
- `listMicDevices` is exported from both `engine/source.ts` (the raw
  `enumerateDevices` wrapper) and re-exported from `engine/session.ts`, so
  `mic-setup.ts` only needs one import path, matching how it already imports
  everything else session-related.
- Untested end to end on a real Bluetooth pairing, for the same reason every
  prior device-specific claim in this repo carries that caveat: this sandboxed
  environment has no real hardware to pair. `pickSpeakerphoneDevice` — the one
  piece of this that's pure logic — is unit-tested directly; the rest is the
  same "gate renders, cleanup clears the root" boundary `latency-setup.test.ts`
  already drew for a screen whose interesting behaviour needs a live mic
  session to exercise.
