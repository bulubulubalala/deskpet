import { desktopCapturer, screen } from "electron";

import type { CapturedFrame } from "./screen-watcher";

export async function capturePrimaryScreen(): Promise<CapturedFrame | null> {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, 1280 / display.size.width);
  const width = Math.max(1, Math.round(display.size.width * scale));
  const height = Math.max(1, Math.round(display.size.height * scale));
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width, height },
    fetchWindowIcons: false,
  });
  const source =
    sources.find((item) => item.display_id === String(display.id)) ?? sources[0] ?? null;
  if (source === null || source.thumbnail.isEmpty()) {
    return null;
  }
  return { jpeg: source.thumbnail.toJPEG(72), appTitle: source.name };
}
