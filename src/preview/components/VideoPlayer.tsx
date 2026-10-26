import Hls from 'hls.js';
import { useEffect, useRef, useState } from 'react';
import type { TaskAnalysis } from '../../shared/types';

const FALLBACK_COVER = chrome.runtime.getURL('assets/cover-placeholder.svg');

interface VideoPlayerProps {
  analysis?: TaskAnalysis;
  coverUrl?: string;
  title: string;
  loading: boolean;
}

export function VideoPlayer({ analysis, coverUrl, title, loading }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [previewError, setPreviewError] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const cover = !coverFailed && coverUrl ? coverUrl : FALLBACK_COVER;
  const mode = analysis?.preview.mode ?? 'none';
  const previewUrl = analysis?.preview.url;

  useEffect(() => {
    setPreviewError(false);
  }, [previewUrl, mode]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || mode !== 'hls' || !previewUrl) return;
    if (!Hls.isSupported()) {
      setPreviewError(true);
      return;
    }
    const hls = new Hls({
      enableWorker: false,
      lowLatencyMode: false,
      backBufferLength: 30,
      maxBufferLength: 20,
    });
    let destroyed = false;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        setPreviewError(true);
        hls.destroy();
      }
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (!destroyed) setPreviewError(false);
    });
    hls.loadSource(previewUrl);
    hls.attachMedia(video);
    return () => {
      destroyed = true;
      hls.destroy();
    };
  }, [mode, previewUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || mode !== 'direct' || !previewUrl) return;
    video.src = previewUrl;
    video.load();
    return () => {
      video.removeAttribute('src');
      video.load();
    };
  }, [mode, previewUrl]);

  const showVideo = (mode === 'direct' || mode === 'hls') && Boolean(previewUrl) && !previewError;
  const showCover = !showVideo;
  const fallbackText =
    mode === 'none'
      ? analysis?.preview.note ?? '该媒体格式暂不支持浏览器内预览，下载后将转换为 MP4。'
      : '预览加载失败，可能是防盗链或跨域限制；这不影响下载 MP4。';

  return (
    <div className="player" aria-label="视频预览区域">
      <div className="player__stage">
        {showVideo ? (
          <video
            ref={videoRef}
            className="player__video"
            controls
            preload="metadata"
            playsInline
            poster={cover}
            aria-label={`视频预览：${title}`}
            onError={() => setPreviewError(true)}
          />
        ) : null}
        {!showVideo && showCover ? (
          <div className="player__placeholder">
            <img
              className="player__cover"
              src={cover}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setCoverFailed(true)}
            />
            <div className="player__veil" />
            {loading && !analysis ? (
              <div className="player__notice player__notice--loading">
                <span className="spinner" aria-hidden="true" />
                <span>正在准备视频预览…</span>
              </div>
            ) : (
              <div className="player__notice">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3.4" y="5.2" width="17.2" height="13.6" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M8.2 9.2h7.6M8.2 12.3h5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M8.2 15.4h3.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span>{fallbackText}</span>
              </div>
            )}
          </div>
        ) : null}
        {showVideo ? <span className="player__badge">预览</span> : null}
      </div>
      {analysis?.preview.note && showVideo ? (
        <p className="player__hint">{analysis.preview.note}</p>
      ) : null}
    </div>
  );
}
