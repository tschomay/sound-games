/**
 * Pick which input device the microphone session actually opens.
 *
 * Every game already gets `createMicSource`'s own Speakerphone-over-Bluetooth
 * steering for free (see `engine/source.ts`) — a paired Bluetooth accessory's
 * mic is avoided automatically wherever the browser exposes that route. This
 * screen is the explicit override on top of that default, reachable any time
 * from the menu's tools, independent of any game or of calibration: a player
 * who *wants* the accessory's mic (a headset held close in a loud room), or
 * whose browser exposes no "Speakerphone" route to steer onto in the first
 * place (desktop, iOS), needs a way to choose deliberately.
 */
import {
  ensureMicSession,
  listMicDevices,
  selectMicDevice,
  stopSession,
  type Session,
} from '../engine/session';
import { el, overlay, topbar, type Cleanup } from '../ui';

export function micSetupScreen(root: HTMLElement): Cleanup {
  const stage = el('div', { class: 'stage' });
  const body = el('div', { class: 'stack' });
  stage.appendChild(body);
  root.appendChild(el('div', { class: 'screen screen--scroll' }, topbar('Microphone'), stage));

  let disposed = false;
  let switching = false;
  /** The device the live session actually opened — may differ from whatever
   *  was last clicked, since picking "System default" can still land on the
   *  Speakerphone route via `createMicSource`'s own steering. */
  let activeDeviceId: string | undefined;

  const gate = overlay(
    "Choose which microphone the games use — useful for steering off a paired Bluetooth " +
      "headset's mic, which otherwise drags your speaker's audio down to call quality the " +
      'moment a game starts listening.',
    'Continue',
    () => void begin(),
    'Your audio is analysed on your device and never leaves it.',
  );
  stage.appendChild(gate.root);

  async function begin(): Promise<void> {
    gate.setBusy(true);
    try {
      const session = await ensureMicSession();
      if (disposed) return;
      gate.root.remove();
      activeDeviceId = session.source.deviceId;
      await renderDevices();
    } catch (error) {
      if (disposed) return;
      gate.showError(error instanceof Error ? error.message : 'Could not open the microphone.');
    }
  }

  async function renderDevices(): Promise<void> {
    const devices = await listMicDevices().catch(() => []);
    if (disposed) return;

    if (devices.length < 2) {
      // Nothing to choose between: one input, or a browser that won't name
      // its devices at all. Same "no choice screen for the common case" call
      // as `sourceGate`'s mic-only gate.
      body.replaceChildren(
        el('h1', { text: 'Microphone' }),
        el('p', {
          text:
            devices.length === 1
              ? `Only one input on this device: ${devices[0].label || 'Microphone'}.`
              : "This browser won't list individual input devices — there's nothing to choose between.",
        }),
      );
      return;
    }

    const rows = [
      deviceOption(null, 'System default', 'Steers onto Speakerphone automatically where one exists.'),
      ...devices.map((device, index) =>
        deviceOption(device.deviceId, device.label || `Microphone ${index + 1}`),
      ),
    ];
    body.replaceChildren(
      el('h1', { text: 'Microphone' }),
      el('p', {
        class: 'hint',
        text: 'Choosing a specific device sticks until you change it again or reload the app.',
      }),
      el('div', { class: 'setup' }, ...rows),
    );
  }

  function deviceOption(deviceId: string | null, label: string, detail?: string): HTMLElement {
    const isActive = deviceId === (activeDeviceId ?? null);
    const button = el('button', { class: 'btn-ghost setup-action', text: isActive ? 'Active' : 'Use' });
    button.disabled = isActive || switching;
    button.addEventListener('click', () => void choose(deviceId));
    return el(
      'div',
      { class: 'setup-row', 'data-done': isActive ? 'true' : 'false' },
      el(
        'div',
        { class: 'setup-text' },
        el('strong', { text: label }),
        detail ? el('span', { class: 'hint', text: detail }) : null,
      ),
      button,
    );
  }

  async function choose(deviceId: string | null): Promise<void> {
    if (switching) return;
    switching = true;
    try {
      const session: Session = await selectMicDevice(deviceId);
      if (disposed) return;
      activeDeviceId = session.source.deviceId;
    } catch (error) {
      if (disposed) return;
      body.prepend(
        el('p', {
          class: 'error',
          text: error instanceof Error ? error.message : 'Could not switch microphones.',
        }),
      );
    } finally {
      switching = false;
      if (!disposed) await renderDevices();
    }
  }

  // Picks up a Bluetooth accessory connecting or disconnecting while this
  // screen is open, without requiring a manual refresh.
  const onDeviceChange = (): void => {
    if (!disposed && activeDeviceId !== undefined) void renderDevices();
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

  return () => {
    disposed = true;
    navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    stopSession();
    root.replaceChildren();
  };
}
