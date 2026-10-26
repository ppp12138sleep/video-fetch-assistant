import Hls from 'hls.js';

const wrap = document.getElementById('player-wrap');
const statusNode = document.getElementById('status');
const modeLabel = document.getElementById('mode-label');
const routeName = document.getElementById('route-name');
const hostCount = document.getElementById('host-count');
const adVideo = document.getElementById('ad-video');
let player = document.getElementById('player');
let hls = null;
let mode = 'mp4';

function setStatus(message) {
  statusNode.textContent = message;
}

function destroyHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function createPlayer() {
  const video = document.createElement('video');
  video.id = 'player';
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.poster = './media/poster.jpg';
  video.src = './media/sample.mp4';
  return video;
}

function ensurePlayer() {
  if (!player || !player.isConnected) {
    player = createPlayer();
    wrap.insertBefore(player, wrap.querySelector('.player-corner'));
  }
  return player;
}

function useMp4() {
  destroyHls();
  mode = 'mp4';
  modeLabel.textContent = '直链 MP4';
  const video = ensurePlayer();
  video.src = './media/sample.mp4';
  video.load();
  setStatus('已切换到直链 MP4。');
}

function useHls() {
  destroyHls();
  mode = 'hls';
  modeLabel.textContent = 'HLS · hls.js';
  const video = ensurePlayer();
  if (!Hls.isSupported()) {
    setStatus('当前浏览器不支持 MediaSource，无法播放 HLS 测试流。');
    return;
  }
  hls = new Hls({ enableWorker: false });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) setStatus(`HLS 播放错误：${data.type} / ${data.details}`);
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    setStatus('已加载本地 HLS 主清单（master.m3u8）。点击「获取视频」验证 HLS 转封装。');
  });
  hls.loadSource('./media/hls/master.m3u8');
  hls.attachMedia(video);
}

function switchFullscreen(target) {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  void target.requestFullscreen().catch((error) => {
    setStatus(`无法进入全屏：${error.message}`);
  });
}

function useDash() {
  destroyHls();
  mode = 'dash';
  modeLabel.textContent = 'DASH · manifest.mpd';
  const video = ensurePlayer();
  video.src = './media/dash/manifest.mpd';
  video.load();
  setStatus('已切换到本地 DASH 清单。Chromium 不原生播放 DASH，但扩展仍应能解析并下载为 MP4。');
}

function useWebm() {
  destroyHls();
  mode = 'webm';
  modeLabel.textContent = 'WebM · VP9/Opus';
  const video = ensurePlayer();
  video.src = './media/sample.webm';
  video.load();
  setStatus('已切换到 WebM（VP9/Opus）。扩展应将其转封装，必要时转码为兼容 MP4。');
}

document.getElementById('use-mp4').addEventListener('click', useMp4);
document.getElementById('use-hls').addEventListener('click', useHls);
document.getElementById('use-dash').addEventListener('click', useDash);
document.getElementById('use-webm').addEventListener('click', useWebm);
document.getElementById('fullscreen-custom').addEventListener('click', () => switchFullscreen(wrap));
document.getElementById('fullscreen-native').addEventListener('click', () => {
  if (mode === 'hls') {
    setStatus('原生 video 全屏建议在直链 MP4 模式下测试。');
  }
  switchFullscreen(player);
});
document.getElementById('remove-video').addEventListener('click', () => {
  destroyHls();
  player?.remove();
  adVideo?.remove();
  setStatus('已移除页面中的所有视频元素，按钮应消失。');
});
document.getElementById('restore-video').addEventListener('click', () => {
  const video = ensurePlayer();
  video.src = './media/sample.mp4';
  if (!adVideo.isConnected) wrap.after(adVideo);
  setStatus('视频已恢复，按钮应重新出现。');
});

for (const button of document.querySelectorAll('.route')) {
  button.addEventListener('click', () => {
    const route = button.dataset.route ?? 'home';
    history.pushState({ route }, '', `?route=${encodeURIComponent(route)}`);
    routeName.textContent = route;
    setStatus(`SPA 路由已切换到 ${route}，页面未刷新。按钮宿主数量应保持为 1。`);
  });
}

window.addEventListener('popstate', () => {
  const route = new URLSearchParams(location.search).get('route') ?? 'home';
  routeName.textContent = route;
});

window.setInterval(() => {
  hostCount.textContent = String(document.querySelectorAll('[data-vva-ui="true"]').length);
}, 500);

const initialRoute = new URLSearchParams(location.search).get('route');
if (initialRoute) routeName.textContent = initialRoute;
