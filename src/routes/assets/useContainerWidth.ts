import { useLayoutEffect, useState, type RefObject } from "react";

/** The content-box width of a scroll container (its `clientWidth` minus
 *  horizontal padding). Tracked live via a `ResizeObserver` for gradual changes
 *  (window resize), and re-measured *synchronously* whenever `watch` changes —
 *  e.g. the side panel opening/closing, which resizes the container in the same
 *  commit. The synchronous re-measure (a layout effect, before paint) keeps the
 *  computed column count from lagging the container's new width by a frame,
 *  which would otherwise flash mis-sized tiles. */
export function useContainerWidth(
  ref: RefObject<HTMLElement | null>,
  horizontalPad: number,
  watch: unknown
): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(0, el.clientWidth - horizontalPad));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, horizontalPad]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setWidth(Math.max(0, el.clientWidth - horizontalPad));
  }, [ref, horizontalPad, watch]);
  return width;
}
