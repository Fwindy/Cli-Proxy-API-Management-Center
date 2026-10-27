import { describe, expect, test } from 'bun:test';
import { resolveRequestEventColumnMenuPosition } from '../src/components/usage/requestEventColumnMenu';

describe('request event column menu placement', () => {
  test('opens below and aligns with the right edge of the trigger when space permits', () => {
    expect(
      resolveRequestEventColumnMenuPosition(
        { top: 100, bottom: 140, right: 1100 },
        { width: 1280, height: 900 }
      )
    ).toEqual({ position: 'fixed', width: 232, left: 868, maxHeight: 360, top: 146 });
  });

  test('opens above near the bottom edge without moving page content', () => {
    expect(
      resolveRequestEventColumnMenuPosition(
        { top: 760, bottom: 800, right: 1100 },
        { width: 1280, height: 900 }
      )
    ).toEqual({ position: 'fixed', width: 232, left: 868, maxHeight: 360, bottom: 146 });
  });

  test('stays within narrow viewports', () => {
    const position = resolveRequestEventColumnMenuPosition(
      { top: 40, bottom: 80, right: 170 },
      { width: 200, height: 600 }
    );
    expect(position.width).toBe(184);
    expect(position.left).toBe(8);
    expect(position.left + position.width).toBeLessThanOrEqual(192);
  });

  test('limits menu height to the available viewport space', () => {
    const position = resolveRequestEventColumnMenuPosition(
      { top: 150, bottom: 190, right: 500 },
      { width: 600, height: 400 }
    );
    expect(position.maxHeight).toBe(196);
    expect(position.top).toBe(196);
  });
});
