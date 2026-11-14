/**
 * Lightweight DOM anchor registry so live windows can spring out of a pipeline
 * stage and genie-dock into their destination card without prop drilling.
 */
const anchors = new Map<string, HTMLElement>();
const refCache = new Map<string, (el: HTMLElement | null) => void>();

export function anchorRef(name: string) {
  let fn = refCache.get(name);
  if (!fn) {
    fn = (el: HTMLElement | null) => {
      if (el) anchors.set(name, el);
      else if (anchors.get(name)) anchors.delete(name);
    };
    refCache.set(name, fn);
  }
  return fn;
}

export function anchorCenter(name: string): { x: number; y: number } | null {
  const el = anchors.get(name);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 60) };
}
