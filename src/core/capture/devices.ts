/**
 * Audio inputs from `ffmpeg -list_devices true -f dshow -i dummy` (stderr). Handles both formats:
 *   [dshow @ 0x1] "Microphone (Realtek)" (audio)            (ffmpeg ≥ 5 and 4.x with type suffix)
 *   [dshow @ 0x1] DirectShow audio devices                   (older, section headers)
 * "Alternative name" lines are skipped.
 */
export function parseDshowAudioDevices(stderr: string): string[] {
  const names: string[] = [];
  let inAudioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/Alternative name/i.test(line)) continue;
    if (/DirectShow video devices/i.test(line)) inAudioSection = false;
    else if (/DirectShow audio devices/i.test(line)) inAudioSection = true;
    const m = /"([^"]+)"(?:\s+\((audio|video|none)[^)]*\))?\s*$/.exec(line);
    if (!m) continue;
    const kind = m[2];
    if (kind === "audio" || (!kind && inAudioSection)) names.push(m[1]!);
  }
  return [...new Set(names)];
}

/**
 * Audio inputs from `ffmpeg -f avfoundation -list_devices true -i ""` (stderr, macOS):
 *   [AVFoundation indev @ 0x1] AVFoundation audio devices:
 *   [AVFoundation indev @ 0x1] [0] MacBook Pro Microphone              (ffmpeg ≥ 9: "…  [uid:BuiltInMicrophoneDevice]")
 * Returns the names (avfoundation accepts `-i ":<name>"`), video devices are skipped.
 */
export function parseAvfoundationAudioDevices(stderr: string): string[] {
  const names: string[] = [];
  let inAudioSection = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation video devices/i.test(line)) inAudioSection = false;
    else if (/AVFoundation audio devices/i.test(line)) inAudioSection = true;
    else if (inAudioSection) {
      // ffmpeg ≥ 9 appends "  [uid:…]" to each name.
      const m = /\]\s*\[(\d+)\]\s+(.+?)(?:\s+\[uid:[^\]]*\])?\s*$/.exec(line);
      if (m) names.push(m[2]!);
    }
  }
  return [...new Set(names)];
}

export const avfoundationListArgs = (): string[] => ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""];

export const dshowListArgs = (): string[] => ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
