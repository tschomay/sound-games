import { describe, expect, it } from 'vitest';
import { pickSpeakerphoneDevice } from '../source';

/** Enough of `MediaDeviceInfo` for `pickSpeakerphoneDevice`, which only reads `label`. */
function device(label: string): MediaDeviceInfo {
  return { deviceId: label, label, kind: 'audioinput', groupId: '' } as MediaDeviceInfo;
}

describe('pickSpeakerphoneDevice', () => {
  it('finds the Speakerphone pseudo-device among Android route labels', () => {
    const devices = [device('Earpiece'), device('Speakerphone'), device('Wired Headset')];
    expect(pickSpeakerphoneDevice(devices)?.label).toBe('Speakerphone');
  });

  it('is case-insensitive', () => {
    expect(pickSpeakerphoneDevice([device('SPEAKERPHONE')])?.label).toBe('SPEAKERPHONE');
  });

  it('returns undefined when nothing matches — iOS and desktop devices, or a Bluetooth accessory alone', () => {
    const devices = [device('Bluetooth Hands-Free'), device('Earpiece'), device('MacBook Pro Microphone')];
    expect(pickSpeakerphoneDevice(devices)).toBeUndefined();
  });

  it('returns undefined for an empty device list', () => {
    expect(pickSpeakerphoneDevice([])).toBeUndefined();
  });
});
