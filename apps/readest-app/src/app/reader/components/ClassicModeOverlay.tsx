import React, { useEffect, useState, useRef } from 'react';
import { Insets } from '@/types/misc';
import { useReaderStore } from '@/store/readerStore';
import { FoliateView } from '@/types/view';

interface ClassicModeOverlayProps {
  bookKey: string;
  borderColor: string;
  ruleWidth: number;
  insets: Insets;
  showHeader: boolean;
  showFooter: boolean;
}

const paddingPx = 10;
const fishtailH = 30;
// Distance between upper and lower fishtail (from center)
const fishtailOffset = 20;
// Ratio of the narrow end of the trapezoid to the full width (0 = triangle, 1 = rectangle)
const fishtailNarrowRatio = 0.35;

interface RuleMetrics {
  ruleXPositions: number[];
  gridCellWidth: number;
  lineStep: number;
}

const computeRuleMetrics = (bookKey: string, view: FoliateView): RuleMetrics | null => {
  const gridCell = document.getElementById(`gridcell-${bookKey}`);
  if (!gridCell) return null;

  const contents = view.renderer.getContents();
  const primary = contents.find((c) => c.index === view.renderer.primaryIndex);
  const doc = primary?.doc;
  if (!doc?.defaultView) return null;

  const sampleEl = doc.querySelector('p') || doc.body;
  const style = doc.defaultView.getComputedStyle(sampleEl);
  const fontSize = parseFloat(style.fontSize) || 16;
  const lineHeightRaw = parseFloat(style.lineHeight);
  const lineStep = isNaN(lineHeightRaw) ? fontSize * 1.5 : lineHeightRaw;
  if (lineStep <= 2) return null;

  const foliate = gridCell.querySelector('foliate-view');
  if (!foliate?.shadowRoot) return null;
  const paginator = foliate.shadowRoot.querySelector('foliate-paginator');
  if (!paginator?.shadowRoot) return null;
  const container = paginator.shadowRoot.getElementById('container') as HTMLElement | null;
  if (!container) return null;

  const gridRect = gridCell.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  if (containerRect.width === 0 || containerRect.height === 0) return null;

  // Read page margins from CSS variables set by the paginator on the
  // document's root element.  These define the gap between the container
  // edge and the actual text area.
  const rootStyle = doc.defaultView.getComputedStyle(doc.documentElement);
  const pageMarginLeft = parseFloat(rootStyle.getPropertyValue('--page-margin-left')) || 0;
  const pageMarginRight = parseFloat(rootStyle.getPropertyValue('--page-margin-right')) || 0;

  // Text area within the container, relative to gridCell
  const contentLeft = containerRect.left - gridRect.left + pageMarginLeft;
  const contentRight = containerRect.left - gridRect.left + containerRect.width - pageMarginRight;

  const ruleXPositions: number[] = [];
  for (let i = 1; ; i++) {
    const x = contentRight - i * lineStep + lineStep * 0.15;
    if (x <= contentLeft + lineStep * 0.3) break;
    ruleXPositions.push(x);
  }

  return { ruleXPositions, gridCellWidth: gridRect.width, lineStep };
};

/**
 * Half-fishtail: trapezoid with the straight (right-angle) edge
 * flush against the 版心 border line.
 * Wide end faces away from center, narrow end faces center.
 *
 * spineOnLeft=true → straight edge on RIGHT (touching left 版心 line)
 * upper=true → wide at top, narrow at bottom (pointing toward center)
 */
const HalfFishtail: React.FC<{
  color: string;
  spineOnLeft: boolean;
  upper: boolean;
  width: number;
}> = ({ color, spineOnLeft, upper, width }) => {
  const w = width;
  const h = fishtailH;
  const nw = w * fishtailNarrowRatio; // narrow end width
  let points: string;
  if (spineOnLeft && upper) {
    // straight edge on right; wide top, narrow bottom
    // clockwise: top-left → top-right → bottom-right → bottom-left
    points = `0,0 ${w},0 ${w},${h} ${w - nw},${h}`;
  } else if (spineOnLeft && !upper) {
    // straight edge on right; narrow top, wide bottom
    // clockwise: top-left → top-right → bottom-right → bottom-left
    points = `${w - nw},0 ${w},0 ${w},${h} 0,${h}`;
  } else if (!spineOnLeft && upper) {
    // straight edge on left; wide top, narrow bottom
    // clockwise: top-left → top-right → bottom-right → bottom-left
    points = `0,0 ${w},0 ${nw},${h} 0,${h}`;
  } else {
    // straight edge on left; narrow top, wide bottom
    // clockwise: top-left → top-right → bottom-right → bottom-left
    points = `0,0 ${nw},0 ${w},${h} 0,${h}`;
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polygon points={points} fill={color} />
    </svg>
  );
};

const ClassicModeOverlay: React.FC<ClassicModeOverlayProps> = ({
  bookKey,
  borderColor,
  ruleWidth,
  insets,
}) => {
  const { getView } = useReaderStore();
  const [metrics, setMetrics] = useState<RuleMetrics | null>(null);
  const [physicalPage, setPhysicalPage] = useState(0);
  const scheduleRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let delayTimers: ReturnType<typeof setTimeout>[] = [];
    let resizeObserver: ResizeObserver | undefined;
    let eventCleanup: (() => void) | undefined;

    const update = () => {
      if (cancelled) return;
      const view = getView(bookKey);
      if (!view?.renderer) return;
      const m = computeRuleMetrics(bookKey, view);
      if (m && m.ruleXPositions.length > 0) setMetrics(m);
      // Read the physical page number from the paginator for odd/even fishtail placement
      const page = (view.renderer as unknown as { page: number }).page ?? 0;
      setPhysicalPage(page);
    };

    const schedule = () => {
      if (scheduleRef.current) cancelAnimationFrame(scheduleRef.current);
      scheduleRef.current = requestAnimationFrame(update);
    };

    const trySetup = () => {
      if (cancelled) return;
      const view = getView(bookKey);
      if (!view?.renderer) {
        retryTimer = setTimeout(trySetup, 200);
        return;
      }

      update();
      delayTimers.push(setTimeout(update, 300));
      delayTimers.push(setTimeout(update, 600));
      delayTimers.push(setTimeout(update, 1200));

      view.renderer.addEventListener('stabilized', schedule);
      view.addEventListener('relocate', schedule);
      const gridCell = document.getElementById(`gridcell-${bookKey}`);
      if (gridCell) {
        resizeObserver = new ResizeObserver(schedule);
        resizeObserver.observe(gridCell);
      }
      eventCleanup = () => {
        view.renderer.removeEventListener('stabilized', schedule);
        view.removeEventListener('relocate', schedule);
      };
    };

    trySetup();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      delayTimers.forEach(clearTimeout);
      if (scheduleRef.current) cancelAnimationFrame(scheduleRef.current);
      eventCleanup?.();
      resizeObserver?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  const frameTop = insets.top - paddingPx;
  const frameLeft = insets.left - paddingPx;
  const frameRight = insets.right - paddingPx;
  const frameHeightExpr = `(100% - ${insets.top + insets.bottom}px + ${paddingPx * 2}px)`;

  const isOddPage = (physicalPage + 1) % 2 === 1;
  const spineOnLeft = isOddPage;

  // Fishtail width = distance from window edge to 版心 line on the spine side
  const ftW = spineOnLeft ? insets.left : insets.right;

  return (
    <div>
      {/* === Non-spine side: full vertical thick border === */}
      <div
        className='pointer-events-none absolute'
        style={{
          top: `${frameTop}px`,
          height: `calc(${frameHeightExpr})`,
          ...(spineOnLeft
            ? { right: `${frameRight}px`, width: '0px', borderRight: `3px solid ${borderColor}` }
            : { left: `${frameLeft}px`, width: '0px', borderLeft: `3px solid ${borderColor}` }),
          opacity: 0.75,
        }}
      />

      {/* Spine side: NO thick vertical border — fishtails touch the 版心 line directly */}

      {/* Top horizontal line — extends to spine edge of window */}
      <div
        className='pointer-events-none absolute'
        style={{
          borderTop: `3px solid ${borderColor}`,
          top: `${frameTop}px`,
          left: spineOnLeft ? '0px' : `${frameLeft}px`,
          right: spineOnLeft ? `${frameRight}px` : '0px',
          height: '0px',
          opacity: 0.75,
        }}
      />
      {/* Bottom horizontal line — extends to spine edge of window */}
      <div
        className='pointer-events-none absolute'
        style={{
          borderTop: `3px solid ${borderColor}`,
          bottom: `${insets.bottom - paddingPx}px`,
          left: spineOnLeft ? '0px' : `${frameLeft}px`,
          right: spineOnLeft ? `${frameRight}px` : '0px',
          height: '0px',
          opacity: 0.75,
        }}
      />

      {/* 版心框 */}
      <div
        className='pointer-events-none absolute'
        style={{
          border: `${ruleWidth}px solid ${borderColor}`,
          height: `calc(100% - ${insets.top + insets.bottom}px)`,
          top: `${insets.top}px`,
          left: `${insets.left}px`,
          right: `${insets.right}px`,
          opacity: 0.75,
        }}
      />

      {/* 界栏 — only between lines, not at the edges */}
      {metrics &&
        metrics.ruleXPositions
          .filter(
            (x) =>
              x > insets.left + metrics.lineStep * 0.8 &&
              x < metrics.gridCellWidth - insets.right - metrics.lineStep * 0.8,
          )
          .map((x, i) => (
            <div
              key={`rule-${i}`}
              className='pointer-events-none absolute'
              style={{
                left: `${x}px`,
                top: `${insets.top}px`,
                height: `calc(100% - ${insets.top + insets.bottom}px)`,
                width: '0px',
                borderLeft: `${ruleWidth}px solid ${borderColor}`,
                opacity: 0.75,
              }}
            />
          ))}

      {/* === 鱼尾 — centered on frame height, one above center, one below === */}
      {/* Upper fishtail: center - offset - fishtailH to center - offset */}
      <div
        className='pointer-events-none absolute'
        style={{
          top: `calc(${frameTop}px + ${frameHeightExpr} * 0.5 - ${fishtailOffset + fishtailH}px)`,
          height: `${fishtailH}px`,
          ...(spineOnLeft
            ? { left: '0px', width: `${ftW}px` }
            : { right: '0px', width: `${ftW}px` }),
        }}
      >
        <HalfFishtail color={borderColor} spineOnLeft={spineOnLeft} upper width={ftW} />
      </div>
      {/* Lower fishtail: center + offset to center + offset + fishtailH */}
      <div
        className='pointer-events-none absolute'
        style={{
          top: `calc(${frameTop}px + ${frameHeightExpr} * 0.5 + ${fishtailOffset}px)`,
          height: `${fishtailH}px`,
          ...(spineOnLeft
            ? { left: '0px', width: `${ftW}px` }
            : { right: '0px', width: `${ftW}px` }),
        }}
      >
        <HalfFishtail color={borderColor} spineOnLeft={spineOnLeft} upper={false} width={ftW} />
      </div>
    </div>
  );
};

export default ClassicModeOverlay;
