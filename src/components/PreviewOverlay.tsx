import { useCallback, useEffect, useRef, useState } from 'react';
import { useSandTable } from '../store/useSandTable';

/** 优先直出 MP4（Chrome 126+ 的 MediaRecorder 支持 H.264），不支持时退回 WebM */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm',
];

const VIDEO_W = 1920;
const VIDEO_H = 1080;
const BITRATE = 12_000_000;

const pickMime = (): string | null =>
  typeof MediaRecorder === 'undefined'
    ? null
    : MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;

/**
 * 全屏电影预览的 DOM 覆盖层：标题、段落题字、退出提示，以及 MP4 导出。
 * 录制时把 WebGL 帧与标题/题字合成到 1920×1080 画布再编码，成片与预览观感一致。
 * 快捷键：P 预览，R 预览并导出，Esc 退出。
 */
export function PreviewOverlay() {
  const active = useSandTable((state) => state.previewActive);
  const caption = useSandTable((state) => state.previewCaption);
  const startPreview = useSandTable((state) => state.startPreview);
  const exitPreview = useSandTable((state) => state.exitPreview);
  const [flash, setFlash] = useState(false);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const compositeRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const startedAtRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);

  const drawComposite = useCallback(() => {
    const ctx = compositeRef.current?.getContext('2d');
    if (!ctx) return;
    const source = document.querySelector<HTMLCanvasElement>('.viewport canvas');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
    if (source && source.width > 0) {
      // cover 裁切：预览窗口比例随侧栏收放变化，成片固定 16:9
      const scale = Math.max(VIDEO_W / source.width, VIDEO_H / source.height);
      const w = source.width * scale;
      const h = source.height * scale;
      ctx.drawImage(source, (VIDEO_W - w) / 2, (VIDEO_H - h) / 2, w, h);
    }

    // 上下轻压暗，保证题字可读
    const top = ctx.createLinearGradient(0, 0, 0, VIDEO_H * 0.22);
    top.addColorStop(0, 'rgba(0,0,0,0.62)');
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, VIDEO_W, VIDEO_H * 0.22);

    const elapsed = (performance.now() - startedAtRef.current) / 1000;
    // 标题：1.2s 淡入，5s 后淡出，与预览层一致
    const titleAlpha = elapsed < 1.2 ? elapsed / 1.2 : elapsed < 5 ? 1 : Math.max(0, 1 - (elapsed - 5) / 1.2);
    if (titleAlpha > 0) {
      ctx.globalAlpha = titleAlpha;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f3e9d2';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 24;
      ctx.font = '600 34px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText('姑 苏 古 城', VIDEO_W / 2, 82);
      ctx.font = '400 18px "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(232,224,204,0.72)';
      ctx.fillText('数 字 沙 盘', VIDEO_W / 2, 118);
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }

    const text = useSandTable.getState().previewCaption;
    if (text) {
      const bottom = ctx.createLinearGradient(0, VIDEO_H * 0.72, 0, VIDEO_H);
      bottom.addColorStop(0, 'rgba(0,0,0,0)');
      bottom.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = bottom;
      ctx.fillRect(0, VIDEO_H * 0.72, VIDEO_W, VIDEO_H * 0.28);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#eee5d2';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 16;
      ctx.font = '400 40px "PingFang SC", "Microsoft YaHei", serif';
      ctx.fillText(text, VIDEO_W / 2, VIDEO_H - 108);
      ctx.shadowBlur = 0;
    }
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    cancelAnimationFrame(rafRef.current);
  }, []);

  const beginRecording = useCallback(() => {
    if (recorderRef.current) return;
    const mime = pickMime();
    if (!mime) {
      setNotice('当前浏览器不支持视频录制，请使用最新版 Chrome');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = VIDEO_W;
    canvas.height = VIDEO_H;
    compositeRef.current = canvas;
    // 有 requestFrame 时手动推帧，帧率与绘制同步；否则退回按 30fps 自动采集
    const manual = typeof CanvasCaptureMediaStreamTrack !== 'undefined';
    const stream = canvas.captureStream(manual ? 0 : 30);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
    const pushFrame = () => (manual ? track?.requestFrame() : undefined);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
    recorderRef.current = recorder;
    chunksRef.current = [];
    startedAtRef.current = performance.now();
    setNotice(mime.startsWith('video/mp4') ? '' : '当前浏览器不支持 MP4，将导出 WebM');

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mime });
      const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
      console.info(`[预览导出] ${ext} · ${(blob.size / 1048576).toFixed(1)}MB`);
      recorderRef.current = null;
      compositeRef.current = null;
      cancelAnimationFrame(rafRef.current);
      setRecording(false);
      if (blob.size === 0) {
        setNotice('录制失败：没有采集到画面，请重试');
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `姑苏古城.${ext}`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    };

    drawComposite();
    pushFrame();
    recorder.start(1000);
    setRecording(true);
    const tick = () => {
      drawComposite();
      pushFrame();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [drawComposite]);

  // 预览结束（Esc 或播完）自动收尾并下载
  useEffect(() => {
    if (!active) stopRecording();
  }, [active, stopRecording]);

  useEffect(() => () => stopRecording(), [stopRecording]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      const state = useSandTable.getState();
      if (event.key === 'Escape' && state.previewActive) {
        event.preventDefault();
        exitPreview();
        return;
      }
      if (state.previewActive) return;
      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        startPreview();
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        startPreview();
        window.setTimeout(beginRecording, 320);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startPreview, exitPreview, beginRecording]);

  useEffect(() => {
    const onExport = () => {
      const state = useSandTable.getState();
      if (!state.previewActive) {
        startPreview();
        window.setTimeout(beginRecording, 320);
      } else {
        beginRecording();
      }
    };
    window.addEventListener('preview:export', onExport);
    return () => window.removeEventListener('preview:export', onExport);
  }, [startPreview, beginRecording]);

  useEffect(() => {
    const onDusk = () => {
      setFlash(true);
      window.setTimeout(() => setFlash(false), 1200);
    };
    window.addEventListener('tour:dusk', onDusk);
    return () => window.removeEventListener('tour:dusk', onDusk);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('is-preview', active);
    return () => document.body.classList.remove('is-preview');
  }, [active]);

  if (!active) return null;

  return (
    <div className="preview-overlay">
      <div className="preview-title">
        <strong>姑苏古城</strong>
        <span>数字沙盘</span>
      </div>

      <div key={caption} className="preview-caption">{caption}</div>
      <div className="preview-exit-hint">Esc 退出预览</div>
      {recording && <div className="preview-rec"><i />REC</div>}
      {notice && <div className="preview-notice">{notice}</div>}

      <div className={`preview-flash${flash ? ' on' : ''}`} />
    </div>
  );
}
