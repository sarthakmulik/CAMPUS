/**
 * Voice-note audio helpers shared by the recording preview and the played
 * bubbles: honest duration decoding (MediaRecorder webm files ship without a
 * duration header, so <audio>.duration can be Infinity), a tiny inline
 * waveform for the preview, a duration label that keeps sub-second
 * precision, and a single-play registry so starting one voice pauses the
 * others instead of stacking playback.
 */

export type VoiceMeta = { duration: number; wave: number[] }

/** Duration + a 48-bar normalized waveform for a recorded blob or its URL. */
export async function decodeVoiceMeta(source: Blob | string): Promise<VoiceMeta | null> {
  let context: AudioContext | null = null
  try {
    const bytes = typeof source === 'string'
      ? await (await fetch(source)).arrayBuffer()
      : await source.arrayBuffer()
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    context = new Ctor()
    const buffer = await context.decodeAudioData(bytes.slice(0))
    const channel = buffer.getChannelData(0)
    const bars = 48
    const step = Math.max(1, Math.floor(channel.length / bars))
    const wave: number[] = []
    for (let i = 0; i < bars; i += 1) {
      let peak = 0.001
      const start = i * step
      const end = Math.min(channel.length, start + step)
      for (let j = start; j < end; j += 16) peak = Math.max(peak, Math.abs(channel[j]))
      wave.push(peak)
    }
    void context.close()
    context = null
    const { duration } = buffer
    if (!Number.isFinite(duration) || duration <= 0) return null
    const max = Math.max(...wave)
    return { duration, wave: wave.map(value => value / max) }
  } catch {
    if (context) void context.close()
    return null
  }
}

/** Label keeps sub-second honesty: "0.4s" under 10, whole seconds after. */
export function voiceDurationLabel(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/* single-play registry: the newest voice starts, the others pause */
const playingVoices = new Set<HTMLAudioElement>()

export function pauseOtherVoices(audio: HTMLAudioElement): void {
  playingVoices.forEach(other => {
    if (other !== audio && !other.paused) other.pause()
  })
  playingVoices.add(audio)
}

export function unlinkVoiceAudio(audio: HTMLAudioElement): void {
  playingVoices.delete(audio)
}
