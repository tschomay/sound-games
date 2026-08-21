import { describe, expect, it } from 'vitest';
import { sourceGate } from '../source-picker';

/** Button text within a gate's root, in DOM order. */
function buttonTexts(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('button')).map((button) => button.textContent ?? '');
}

describe('sourceGate', () => {
  it('renders only a mic button when file support is not requested (the default)', () => {
    const gate = sourceGate('intro', () => {});
    expect(buttonTexts(gate.root)).toEqual(['Open microphone']);
  });

  it('renders both buttons when a game supports mic and file', () => {
    const gate = sourceGate('intro', () => {}, { allowFile: true });
    expect(buttonTexts(gate.root)).toEqual(['Use microphone', 'Choose a file']);
  });

  it('renders only a file button for a file-only game (sources: ["file"])', () => {
    // This is the case play.ts drives for a `GameDefinition` whose `sources`
    // is `['file']` alone — Drop Siege (docs/ideas.md B2) is the first one.
    const gate = sourceGate('intro', () => {}, { allowFile: true, allowMic: false });
    expect(buttonTexts(gate.root)).toEqual(['Choose a file']);
    expect(gate.root.querySelector('.gate-actions')).toBeNull();
  });

  it('the file-only button is styled as the primary action', () => {
    const gate = sourceGate('intro', () => {}, { allowFile: true, allowMic: false });
    const button = gate.root.querySelector('button');
    expect(button?.className).toContain('btn-primary');
  });
});
