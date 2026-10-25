import { useEffect, useRef, useState } from 'react'
import { useBodyScrollLock } from '../lib/scrollLock'
import { X, Play, Pause, Check, Scissors } from 'lucide-react'
import { formatClipTime, probeVideo, REEL_WINDOW_SECONDS } from '../lib/media'
import { attachSheetDismiss } from '../lib/sheetDismiss'

/**
 * Reel trim modal: pick a window of at most 30 seconds from a picked video.
 * Two range thumbs over a filmstrip-style track; playback loops… stops at the
 * end of the selection. Applying the window hands {start, end} back to the
 * composer, which trims + compresses on publish.
 */
export default function ReelTrim({
  file,
  onApply,
  onCancel,
}: {
  file: File
  onApply: (window: { start: number; end: number }) => void
  onCancel: () => void
}) {
  // trim sheet over a dimmed overlay — lock the feed behind it
  useBodyScrollLock()
  // swipe-to-dismiss engages only on the grab zones, so the trimmer's own
  // drags inside the track stay untouched
  const dismissRef = useRef<(() => void) | null>(null)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(Math.min(REEL_WINDOW_SECONDS, duration))
  const [playing, setPlaying] = useState(false)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setVideoUrl(url)
    return () => { URL.revokeObjectURL(url); setVideoUrl(null) }
  }, [file])

  useEffect(() => {
    let alive = true
    void probeVideo(file)
      .then(info => {
        if (!alive) return
        setDuration(info.duration)
        setEnd(Math.min(REEL_WINDOW_SECONDS, info.duration))
        if (info.duration <= 0) setError('This video has no readable length.')
      })
      .catch(err => alive && setError(err.message))
    return () => { alive = false }
  }, [file])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !playing) return
    const onTime = () => {
      if (video.currentTime >= end - 0.02) {
        video.currentTime = video.currentTime >= end ? start : video.currentTime
        video.pause()
        setPlaying(false)
      }
      if (video.currentTime < start - 0.25 && start > 0) video.currentTime = start
    }
    video.addEventListener('timeupdate', onTime)
    return () => video.removeEventListener('timeupdate', onTime)
  }, [playing, start, end])

  const seekTo = (time: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(0, Math.min(time, duration))
  }

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video) return
    if (playing) {
      video.pause()
      setPlaying(false)
      return
    }
    if (video.currentTime < start || video.currentTime >= end - 0.05) video.currentTime = start
    setPlaying(true)
    await video.play().catch(() => setPlaying(false))
  }

  const applySelection = () => {
    onApply({ start, end })
  }

  const windowLength = Math.max(0, end - start)
  const tooLong = windowLength > REEL_WINDOW_SECONDS + 0.05
  const progressPct = duration ? (start / duration) * 100 : 0
  const widthPct = duration ? ((end - start) / duration) * 100 : 100

  return (
    <div className="overlay trim-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}>
      <section className="bottom-sheet trim-sheet" role="dialog" aria-label="Trim reel" ref={el => { dismissRef.current?.(); dismissRef.current = el ? attachSheetDismiss(el, onCancel) : null }}>
        <div className="sheet-handle" />
        <div className="sheet-heading">
          <div>
            <span className="eyebrow">REEL STUDIO</span>
            <h2>Trim your reel</h2>
          </div>
          <button className="icon-button" onClick={onCancel} aria-label="Close trimmer"><X size={20} /></button>
        </div>

        {error ? (
          <div className="form-error" role="alert">{error}</div>
        ) : (
          <>
            <div className="trim-video-wrap" onClick={() => seekTo(start)}>
              {videoUrl && <video ref={videoRef} className="trim-video" src={videoUrl} preload="auto" playsInline />}
              <button className="trim-play" onClick={event => { event.stopPropagation(); void togglePlay() }} aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause size={20} /> : <Play size={20} />}
              </button>
            </div>

            <div className="trim-meta">
              <span>Clip: <b>{formatClipTime(windowLength)}</b> / {REEL_WINDOW_SECONDS}s max</span>
              <span className={tooLong ? 'form-error-inline' : ''}>{tooLong ? 'Make the window shorter' : 'Selection length'}</span>
            </div>

            <div className="trim-track" aria-hidden="true">
              <div className="trim-fill" style={{ left: `${progressPct}%`, width: `${widthPct}%` }} />
            </div>
            <div className="trim-ranges">
              <input
                type="range" aria-label="Clip start"
                min={0} max={Math.max(0.1, duration)} step={0.05}
                value={start}
                onChange={event => {
                  const value = Math.min(Number(event.target.value), end - 0.25)
                  setStart(Math.max(0, value))
                  seekTo(Math.max(0, value))
                }}
              />
              <input
                type="range" aria-label="Clip end"
                min={0} max={Math.max(0.1, duration)} step={0.05}
                value={end}
                onChange={event => {
                  const value = Math.max(Number(event.target.value), start + 0.25)
                  setEnd(Math.min(duration, value, start + REEL_WINDOW_SECONDS))
                }}
              />
            </div>
            <div className="trim-times"><span>{formatClipTime(start)}</span><span>{formatClipTime(end)}</span></div>

            <div className="sheet-actions">
              <button className="secondary-button" onClick={onCancel}>Cancel</button>
              <button className="primary-button" disabled={tooLong || windowLength === 0} onClick={applySelection}>
                <Scissors size={15}/> Use {formatClipTime(windowLength)} clip
              </button>
            </div>
            <p className="trim-hint"><Check size={14}/> Applied to the full {formatClipTime(duration)} video — CAMPUS keeps audio and shrinks the file for faster posting.</p>
          </>
        )}
      </section>
    </div>
  )
}
