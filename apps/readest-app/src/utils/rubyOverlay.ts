/**
 * Ruby Overlay for Classic Mode (古籍模式).
 *
 * In classic mode, rt elements are hidden via CSS (`display: none`) so they
 * don't affect line width. After the page stabilizes, this module traverses
 * visible <ruby> elements and creates absolutely positioned overlay spans.
 */

const OVERLAY_CLASS = 'ruby-overlay-rt';
const OVERLAY_STYLE_ID = 'ruby-overlay-style';

function ensureOverlayStyle(doc: Document): void {
  if (doc.getElementById(OVERLAY_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = OVERLAY_STYLE_ID;
  style.textContent = `.${OVERLAY_CLASS}{position:absolute;pointer-events:none;writing-mode:vertical-rl;font-size:0.5em;line-height:1;white-space:nowrap;color:inherit;opacity:0.85}`;
  doc.head.appendChild(style);
}

export function layoutRubyOverlay(doc: Document): void {
  removeRubyOverlay(doc);

  const rubies = doc.querySelectorAll('ruby');
  if (!rubies.length) return;

  const win = doc.defaultView;
  if (!win) return;

  ensureOverlayStyle(doc);

  // Use clientWidth/clientHeight of the documentElement — in column-paginated
  // mode this reflects the actual visible page size, not the full document.
  const vw = doc.documentElement.clientWidth;
  const vh = doc.documentElement.clientHeight;
  const scrollX = win.scrollX;
  const scrollY = win.scrollY;

  // Batch-read phase
  const entries: { rtText: string; top: number; left: number }[] = [];
  for (let i = 0; i < rubies.length; i++) {
    const ruby = rubies[i]!;
    const rect = ruby.getBoundingClientRect();

    // Skip invisible
    if (rect.width === 0 && rect.height === 0) continue;
    // Must be within viewport
    if (rect.right < 0 || rect.left > vw || rect.bottom < 0 || rect.top > vh) continue;

    const rtElements = ruby.querySelectorAll('rt');
    if (!rtElements.length) continue;

    let rtText = '';
    for (let j = 0; j < rtElements.length; j++) {
      rtText += rtElements[j]!.textContent || '';
    }
    if (!rtText) continue;

    entries.push({
      rtText,
      top: rect.top + scrollY,
      left: rect.right + scrollX,
    });
  }

  if (!entries.length) return;

  // Batch-write phase using innerHTML for maximum speed
  const container = doc.createElement('div');
  container.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none';
  let html = '';
  for (const { rtText, top, left } of entries) {
    html += `<span class="${OVERLAY_CLASS}" style="top:${top}px;left:${left}px">${escapeHtml(rtText)}</span>`;
  }
  container.innerHTML = html;
  doc.body.appendChild(container);
}

export function removeRubyOverlay(doc: Document): void {
  // Remove the container div (faster than querying individual spans)
  const containers = doc.querySelectorAll(`div:has(> .${OVERLAY_CLASS})`);
  for (const el of Array.from(containers)) {
    el.remove();
  }
  // Fallback: remove any stray overlays
  const strays = doc.querySelectorAll(`.${OVERLAY_CLASS}`);
  for (const el of Array.from(strays)) {
    el.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
