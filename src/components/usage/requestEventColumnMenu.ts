const MARGIN = 8;
const OFFSET = 6;
const MENU_WIDTH = 232;
const MENU_MAX_HEIGHT = 360;

export function resolveRequestEventColumnMenuPosition(
  anchor: { top: number; bottom: number; right: number },
  viewport: { width: number; height: number }
) {
  const width = Math.min(MENU_WIDTH, Math.max(0, viewport.width - MARGIN * 2));
  const below = Math.max(0, viewport.height - anchor.bottom - MARGIN - OFFSET);
  const above = Math.max(0, anchor.top - MARGIN - OFFSET);
  const opensBelow = below >= MENU_MAX_HEIGHT || below >= above;
  return {
    position: 'fixed' as const,
    width,
    left: Math.max(MARGIN, Math.min(anchor.right - width, viewport.width - width - MARGIN)),
    maxHeight: Math.min(MENU_MAX_HEIGHT, opensBelow ? below : above),
    ...(opensBelow
      ? { top: anchor.bottom + OFFSET }
      : { bottom: viewport.height - anchor.top + OFFSET }),
  };
}
