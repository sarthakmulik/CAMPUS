import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'

/**
 * CAMPUS reel player: replaces the bare <video controls> with an in-brand
 * player — big play affordance, tap-to-pause, thin scrubber, mute toggle and
 * time readout over a gradient bar.
 */
export default function ReelPlayer({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTime = () => setCurrent(video.currentTime)
    const onMeta = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0)
    const onEnd = () => setPlaying(false)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('ended', onEnd)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('ended', onEnd)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const toggleMute = (event: React.MouseEvent) => {
    event.stopPropagation()
    const video = videoRef.current
    if (!video) return
    video.muted = !video.muted
    setMuted(video.muted)
  }

  const seek = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
    const video = videoRef.current
    if (!video || !duration) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    video.currentTime = ratio * duration
  }

  const fmt = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds - m * 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const pct = duration ? Math.min(100, (current / duration) * 100) : 0

  return (
    <div className="reel-player" onClick={togglePlay} role="button" aria-label={playing ? 'Pause reel' : 'Play reel'} tabIndex={0}
      onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); togglePlay() } }}>
      <video ref={videoRef} className="reel-video" src={src} preload="metadata" playsInline muted={muted} />
      {!playing && (
        <span className="reel-big-play" aria-hidden="true"><Play size={26} /></span>
      )}
      <div className="reel-bar" onClick={event => event.stopPropagation()}>
        <button className="reel-bar-button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <div className="reel-progress" onClick={seek} role="slider" aria-label="Seek" aria-valuemin={0}
          aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(current)}>
          <span className="reel-track"><i style={{ width: `${pct}%` }} /></span>
        </div>
        <span className="reel-time">{fmt(current)} / {fmt(duration)}</span>
        <button className="reel-bar-button" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </button>
      </div>
    </div>
  )
}
