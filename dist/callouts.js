const SVG_NS = 'http://www.w3.org/2000/svg';
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mm = value => Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
const REASONS = {
  support: 'Support region',
  vertical: 'Vertical exterior wall',
  standard: 'Standard / slope detail',
  manual: 'Manual override',
};

function colorFor(thicknessUm) {
  const colors = [[50,[116,190,255]],[100,[205,219,214]],[150,[194,247,223]],[200,[255,196,117]]];
  const value = clamp(thicknessUm, 50, 200);
  const i = Math.min(2, Math.floor((value - 50) / 50));
  const ratio = (value - colors[i][0]) / 50;
  return `rgb(${colors[i][1].map((channel, j) => Math.round(channel + (colors[i + 1][1][j] - channel) * ratio)).join(',')})`;
}

/** Group only contiguous layers with the same actual thickness, reason and adjustment status. */
export function calloutRegions(plan) {
  const regions = [];
  for (const layer of plan?.layers || []) {
    const fromMm = layer.zStartMm ?? layer.zMm - layer.thicknessUm / 1000;
    const toMm = layer.zMm;
    if (![fromMm, toMm, layer.thicknessUm].every(Number.isFinite) || toMm <= fromMm) continue;
    const previous = regions.at(-1);
    const adjusted = Boolean(layer.adjusted);
    if (previous && Math.abs(previous.toMm - fromMm) < 1e-7 &&
        previous.thicknessUm === layer.thicknessUm && previous.reason === layer.reason && previous.adjusted === adjusted) {
      previous.toMm = toMm;
      previous.layerCount++;
    } else {
      regions.push({id: regions.length, fromMm, toMm, thicknessUm: layer.thicknessUm,
        reason: layer.reason || 'standard', adjusted, layerCount: 1});
    }
  }
  return regions;
}

/**
 * Owns a pointer-transparent overlay inside a BuildViewer container.
 * setPlan(plan), setView('side'|'3d'|'plate'|'slice'), and destroy() are the main API.
 * onSelect receives {fromMm,toMm,thicknessUm,reason,adjusted,layerCount,id}.
 * Wheel and container resize update projected positions without modifying the viewer.
 */
export class LayerCallouts {
  constructor(viewer, {container = viewer.container, onSelect, maxLabels = 4} = {}) {
    if (!container?.appendChild) throw new TypeError('LayerCallouts requires a viewer container.');
    this.viewer = viewer;
    this.container = container;
    this.onSelect = onSelect;
    this.maxLabels = clamp(Math.floor(Number(maxLabels) || 4), 1, 4);
    this.mode = viewer.mode || 'side';
    this.regions = [];
    this.nodes = new Map();
    this.selection = null;
    this.frame = null;
    this.disposed = false;
    this.root = document.createElement('div');
    this.root.className = 'layer-callouts';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Major layer sections. Select a section to edit its thickness.');
    this.root.hidden = true;
    this.lines = document.createElementNS(SVG_NS, 'svg');
    this.lines.classList.add('layer-callout-lines');
    this.lines.setAttribute('aria-hidden', 'true');
    this.boundaries = document.createElementNS(SVG_NS, 'g');
    this.boundaries.classList.add('layer-boundaries');
    this.lines.appendChild(this.boundaries);
    this.root.appendChild(this.lines);
    container.appendChild(this.root);
    this._queue = () => this.refresh();
    this.canvas = viewer.canvas;
    this.canvas?.addEventListener('wheel', this._queue, {passive: true});
    this.canvas?.addEventListener('viewchange', this._queue);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(this._queue);
      this.observer.observe(container);
    } else {
      window.addEventListener('resize', this._queue);
    }
  }

  setPlan(plan) {
    this.regions = calloutRegions(plan).sort((a, b) =>
      (b.toMm - b.fromMm) - (a.toMm - a.fromMm) || a.fromMm - b.fromMm);
    this.nodes.forEach(node => { node.button.remove(); node.line.remove(); node.dot.remove(); });
    this.nodes.clear();
    this.root.hidden = !this.regions.length || this.mode !== 'side';
    this.refresh();
  }

  setView(mode) {
    this.mode = mode;
    this.root.hidden = mode !== 'side' || !this.regions.length;
    this.refresh();
  }

  setSelection(fromMm, toMm) {
    this.selection = Number.isFinite(fromMm) && Number.isFinite(toMm) ? {fromMm, toMm} : null;
    this.refresh();
  }

  refresh() {
    if (this.disposed || this.frame !== null) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this._layout(); });
  }

  _makeNode(region) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layer-callout';
    button.style.setProperty('--callout-color', colorFor(region.thicknessUm));
    const thickness = document.createElement('strong');
    thickness.className = 'layer-callout-thickness';
    thickness.textContent = `${region.thicknessUm} µm`;
    const range = document.createElement('span');
    range.className = 'layer-callout-range';
    range.textContent = `Z ${mm(region.fromMm)}–${mm(region.toMm)} mm`;
    const reason = document.createElement('span');
    reason.className = 'layer-callout-reason';
    reason.textContent = region.adjusted ? 'Section-end adjustment' : REASONS[region.reason] || region.reason;
    const description = `${range.textContent}, ${thickness.textContent}, ${REASONS[region.reason] || region.reason}${region.adjusted ? ', section-end adjustment' : ''}`;
    button.setAttribute('aria-label', `${description}. Select this interval for editing.`);
    button.title = `${description}. Click to select this height interval.`;
    button.append(thickness, range, reason);
    button.addEventListener('pointerdown', event => event.stopPropagation());
    button.addEventListener('click', event => { event.stopPropagation(); this.onSelect?.({...region}); });
    const line = document.createElementNS(SVG_NS, 'path');
    const dot = document.createElementNS(SVG_NS, 'circle');
    line.setAttribute('stroke', colorFor(region.thicknessUm));
    dot.setAttribute('fill', colorFor(region.thicknessUm));
    dot.setAttribute('r', '2.5');
    this.lines.append(line, dot);
    this.root.appendChild(button);
    const node = {button, line, dot};
    this.nodes.set(region.id, node);
    return node;
  }

  _layout() {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (this.mode !== 'side' || this.viewer.failed || !this.regions.length || width < 240 || height < 160) {
      this.root.hidden = true;
      return;
    }
    const top = 58, bottom = height - 51, labelHeight = 65, gap = 9;
    const capacity = Math.min(this.maxLabels, Math.floor((bottom - top + gap) / (labelHeight + gap)));
    const visible = [];
    for (const region of this.regions) {
      if (visible.length >= capacity) break;
      const a = this.viewer.heightToScreen(region.fromMm), b = this.viewer.heightToScreen(region.toMm);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const low = Math.max(top, Math.min(a, b)), high = Math.min(bottom, Math.max(a, b));
      if (high < low) continue;
      visible.push({region, anchorY: clamp((a + b) / 2, low, high)});
    }
    visible.sort((a, b) => a.anchorY - b.anchorY);
    this.root.hidden = !visible.length;
    const wanted = new Set(visible.map(({region}) => region.id));
    for (const [id, node] of this.nodes) {
      if (!wanted.has(id)) { node.button.remove(); node.line.remove(); node.dot.remove(); this.nodes.delete(id); }
    }
    if (!visible.length) return;
    this.lines.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const labelWidth = clamp(width * .28, 133, 181), left = 14;
    const labelRight = left + labelWidth;
    const anchorX = Math.min(width - 64, Math.max(labelRight + 34, width * .51));
    this.boundaries.replaceChildren();
    // Region transitions, not individual print layers; keep nearby lines legible.
    const elevations=[...new Set(this.regions.flatMap(r=>[r.fromMm,r.toMm]))].sort((a,b)=>b-a);
    let previousY=-Infinity;
    for(const z of elevations){
      const y=this.viewer.heightToScreen(z);
      if(!Number.isFinite(y)||y<top||y>bottom||y-previousY<9)continue;
      previousY=y;
      const line=document.createElementNS(SVG_NS,'path');
      line.setAttribute('d',`M ${labelRight+18} ${y} H ${width-56}`);
      const label=document.createElementNS(SVG_NS,'text');
      label.setAttribute('x',width-61);label.setAttribute('y',y-5);label.setAttribute('text-anchor','end');
      label.textContent=`${mm(z)} mm`;
      this.boundaries.append(line,label);
    }
    const minCenter = top + labelHeight / 2, maxCenter = bottom - labelHeight / 2;
    const centers = visible.map(({anchorY}) => clamp(anchorY, minCenter, maxCenter));
    for (let i = 1; i < centers.length; i++) centers[i] = Math.max(centers[i], centers[i - 1] + labelHeight + gap);
    centers[centers.length - 1] = Math.min(centers.at(-1), maxCenter);
    for (let i = centers.length - 2; i >= 0; i--) centers[i] = Math.min(centers[i], centers[i + 1] - labelHeight - gap);
    visible.forEach(({region, anchorY}, i) => {
      const node = this.nodes.get(region.id) || this._makeNode(region);
      Object.assign(node.button.style, {left: `${left}px`, top: `${centers[i] - labelHeight / 2}px`, width: `${labelWidth}px`, height: `${labelHeight}px`});
      const selected = this.selection && Math.abs(this.selection.fromMm - region.fromMm) < .001 && Math.abs(this.selection.toMm - region.toMm) < .001;
      node.button.classList.toggle('is-selected', Boolean(selected));
      node.button.setAttribute('aria-pressed', String(Boolean(selected)));
      node.line.setAttribute('d', `M ${labelRight} ${centers[i]} L ${labelRight + 12} ${centers[i]} L ${anchorX} ${anchorY}`);
      node.dot.setAttribute('cx', anchorX);
      node.dot.setAttribute('cy', anchorY);
    });
  }

  destroy() {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    window.removeEventListener('resize', this._queue);
    this.canvas?.removeEventListener('wheel', this._queue);
    this.canvas?.removeEventListener('viewchange', this._queue);
    this.root.remove();
    this.nodes.clear();
  }
}
