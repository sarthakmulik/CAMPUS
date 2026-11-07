/**
 * Browser-native video pipeline for reels: probe duration, trim a window and
 * re-encode it (compression) via canvas + MediaRecorder — no external
 * dependencies or ffmpeg bundle. Audio is preserved through the WebAudio
 * graph; when the browser refuses, the clip is silently video-only.
 */

const REEL_MAX_SECONDS = 30

export type VideoProbe = {
  duration: number
  width: number
  height: number
}

/** Load a video file's metadata (duration + dimensions). Throws when undecodable. */
export async function probeVideo(file: File): Promise<VideoProbe> {
  const video = document.createElement('video')
  const url = URL.createObjectURL(file)
  try {
    video.preload = 'metadata'
    video.muted = true
    video.src = url
    await once(video, 'loadedmetadata', 15_000)
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('CAMPUS could not read that video. MP4 and WebM work best.')
    }
    return { duration: video.duration, width: video.videoWidth, height: video.videoHeight }
  } finally {
    URL.revokeObjectURL(url)
    video.removeAttribute('src')
  }
}

function once(element: HTMLVideoElement | MediaRecorder, event: string, timeoutMs?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = timeoutMs ? window.setTimeout(() => {
      cleanup()
      reject(new Error('Video processing timed out. Try a shorter clip.'))
    }, timeoutMs) : undefined
    const onEvent = () => { cleanup(); resolve() }
    const onError = () => { cleanup(); reject(new Error('CAMPUS could not process that video.')) }
    const cleanup = () => {
      element.removeEventListener(event, onEvent)
      element.removeEventListener('error', onError)
      if (timer) window.clearTimeout(timer)
    }
    element.addEventListener(event as never, onEvent as never, { once: true })
    element.addEventListener('error' as never, onError as never, { once: true })
  })
}

function pickRecorderMime(): string {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) return mime
  }
  return ''
}

export type VideoProgress = { phase: 'encoding'; percent: number } | { phase: 'uploading' }

export type CompressOptions = {
  file: File
  /** Start of the selected window, seconds. */
  start: number
  /** Length of the window, seconds — capped at 30. */
  keepSeconds: number
  /** Target for the long edge, pixels. Default 720. */
  maxEdge?: number
  onProgress?: (progress: VideoProgress) => void
}

/**
 * Trim + compress: re-encodes the selected window at reduced resolution with a
 * fixed bitrate. Returns a File ready for upload.
 */
export async function compressVideo(options: CompressOptions): Promise<File> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Your browser cannot compress video. Try Chrome, Edge or Firefox.')
  }
  const mimeType = pickRecorderMime()
  if (!mimeType) throw new Error('Your browser cannot encode video. Try Chrome or Edge.')

  const { file, start, keepSeconds: rawKeep, maxEdge = 720, onProgress } = options
  const keepSeconds = Math.min(rawKeep, REEL_MAX_SECONDS)

  const video = document.createElement('video')
  const url = URL.createObjectURL(file)
  video.src = url
  video.playsInline = true
  video.muted = false
  video.volume = 1

  let audioContext: AudioContext | null = null
  let recorder: MediaRecorder | null = null

  try {
    await once(video, 'loadedmetadata', 20_000)
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth || maxEdge, video.videoHeight || maxEdge))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.floor((video.videoWidth || maxEdge) * scale / 2) * 2)
    canvas.height = Math.max(2, Math.floor((video.videoHeight || maxEdge) * scale / 2) * 2)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('CAMPUS could not encode that video.')

    const canvasStream = canvas.captureStream(30)
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()]

    // Keep the original audio without playing it out loud.
    try {
      audioContext = new AudioContext()
      const source = audioContext.createMediaElementSource(video)
      const destination = audioContext.createMediaStreamDestination()
      source.connect(destination)
      tracks.push(...destination.stream.getAudioTracks())
    } catch {
      audioContext = null // video-only fallback; compression still works
    }

    const stream = new MediaStream(tracks)
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: Math.round(2_200_000 * Math.max(canvas.width, canvas.height) / maxEdge),
      audioBitsPerSecond: 96_000,
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) chunks.push(event.data)
    }
    const stopped = once(recorder, 'stop')

    video.currentTime = start
    await once(video, 'seeked', 15_000)

    recorder.start(250)
    await video.play()

    const target = start + keepSeconds
    await new Promise<void>((resolve, reject) => {
      const finish = () => resolve()
      const draw = () => {
        if (video.currentTime >= target || video.ended) {
          finish()
          return
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        onProgress?.({ phase: 'encoding', percent: Math.min(99, Math.round(((video.currentTime - start) / keepSeconds) * 100)) })
        requestAnimationFrame(draw)
      }
      requestAnimationFrame(draw)
      video.onended = finish
      video.onerror = () => reject(new Error('CAMPUS could not process that video.'))
    })

    video.pause()
    onProgress?.({ phase: 'encoding', percent: 100 })
    recorder.requestData()
    recorder.stop()
    await stopped

    const type = mimeType.split(';')[0]
    const blob = new Blob(chunks, { type })
    if (!blob.size) throw new Error('CAMPUS could not encode that video. Try a different file.')
    const extension = type === 'video/mp4' ? 'mp4' : 'webm'
    return new File([blob], `reel-${Date.now()}.${extension}`, { type })
  } finally {
    video.pause()
    if (audioContext) void audioContext.close().catch(() => undefined)
    URL.revokeObjectURL(url)
    video.removeAttribute('src')
    recorder = null
  }
}

/* -------------------------------------------------------------------------- */
/* Image compression: resize + WebP re-encode via canvas, no dependencies.    */
/* -------------------------------------------------------------------------- */

export type ImageCompressOptions = {
  /** Long-edge cap in pixels. Default 1600 (feed/listing/cover size). */
  maxEdge?: number
  /** WebP quality 0..1. Default 0.82. */
  quality?: number
}

const IMAGE_KEEP_BYTES = 300 * 1024 // already-small files at target size pass through

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    // imageOrientation honors EXIF so rotated phone photos land upright
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  } catch {
    const url = URL.createObjectURL(file)
    const img = new Image()
    try {
      img.src = url
      await img.decode()
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }
    } catch (err) {
      URL.revokeObjectURL(url)
      throw err
    }
  }
}

/**
 * Shrink an image for upload: cap the long edge and re-encode as WebP.
 * GIF/SVG pass through untouched (animation / vector). Already-small files,
 * unsupported encoders and any failure all return the original — compression
 * is best-effort and must never block an upload.
 */
export async function compressImage(file: File, options: ImageCompressOptions = {}): Promise<File> {
  const { maxEdge = 1600, quality = 0.82 } = options
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file
  let decoded: Awaited<ReturnType<typeof decodeImage>> | null = null
  try {
    decoded = await decodeImage(file)
    const { source, width, height } = decoded
    if (!width || !height) return file
    if (Math.max(width, height) <= maxEdge && file.size <= IMAGE_KEEP_BYTES) return file
    const scale = Math.min(1, maxEdge / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return file
    context.drawImage(source, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality))
    if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file
    const name = `${file.name.replace(/\.[^.]+$/, '') || 'image'}.webp`
    return new File([blob], name, { type: 'image/webp', lastModified: Date.now() })
  } catch {
    return file
  } finally {
    decoded?.close()
  }
}

export function formatClipTime(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const m = Math.floor(clamped / 60)
  const s = clamped - m * 60
  return m > 0 ? `${m}m ${s.toFixed(1)}s` : `${s.toFixed(1)}s`
}

export const REEL_WINDOW_SECONDS = REEL_MAX_SECONDS
