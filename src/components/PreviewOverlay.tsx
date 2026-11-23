import { useEffect, useState } from 'react';
import { useSandTable } from '../store/useSandTable';

/**
 * 全屏电影预览的 DOM 覆盖层：遮幅、标题、段落题字、退出提示。
 * 快捷键：P 开始预览，Esc 退出。
 */
export function PreviewOverlay() {
  const active = useSandTable((state) => state.previewActive);
  const caption = useSandTable((state) => state.previewCaption);
  const startPreview = useSandTable((state) => state.startPreview);
  const exitPreview = useSandTable((state) => state.exitPreview);
  const [flash, setFlash] = useState(false);

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
      if (!state.previewActive && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault();
        startPreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startPreview, exitPreview]);

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
      <div className="preview-bar preview-bar-top" />
      <div className="preview-bar preview-bar-bottom" />

      <div className="preview-title">
        <strong>姑苏古城</strong>
        <span>数字沙盘</span>
      </div>

      <div key={caption} className="preview-caption">{caption}</div>
      <div className="preview-exit-hint">Esc 退出预览</div>

      <div className={`preview-flash${flash ? ' on' : ''}`} />
    </div>
  );
}
