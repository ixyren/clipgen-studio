import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
}

interface Coords {
  top: number;
  left: number;
  effectiveSide: "top" | "bottom" | "left" | "right";
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = "top",
  delay = 180,
  className = "inline-flex",
}) => {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<Coords>({
    top: -9999,
    left: -9999,
    effectiveSide: side,
  });
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tip = tooltipRef.current;
    if (!trigger || !tip) return;

    const rect = trigger.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const gap = 8;
    const margin = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let effectiveSide = side;
    if (side === "top" && rect.top - tipRect.height - gap < margin) {
      effectiveSide = "bottom";
    } else if (side === "bottom" && rect.bottom + tipRect.height + gap > vh - margin) {
      effectiveSide = "top";
    } else if (side === "left" && rect.left - tipRect.width - gap < margin) {
      effectiveSide = "right";
    } else if (side === "right" && rect.right + tipRect.width + gap > vw - margin) {
      effectiveSide = "left";
    }

    let top = 0;
    let left = 0;

    switch (effectiveSide) {
      case "bottom":
        top = rect.bottom + gap;
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        break;
      case "left":
        top = rect.top + rect.height / 2 - tipRect.height / 2;
        left = rect.left - tipRect.width - gap;
        break;
      case "right":
        top = rect.top + rect.height / 2 - tipRect.height / 2;
        left = rect.right + gap;
        break;
      case "top":
      default:
        top = rect.top - tipRect.height - gap;
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        break;
    }

    const maxLeft = Math.max(margin, vw - tipRect.width - margin);
    const maxTop = Math.max(margin, vh - tipRect.height - margin);

    setCoords({
      top: Math.max(margin, Math.min(maxTop, top)),
      left: Math.max(margin, Math.min(maxLeft, left)),
      effectiveSide,
    });
  }, [side]);

  const show = () => {
    if (!content) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setVisible(true);
    }, delay);
  };

  const hide = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  };

  const handleFocus = (e: React.FocusEvent<HTMLSpanElement>) => {
    try {
      const target = e.target as HTMLElement | null;
      if (target && target.matches(":focus-visible")) {
        show();
      }
    } catch {
      // Ignore selector error on non-standard nodes
    }
  };

  useLayoutEffect(() => {
    if (visible) {
      updatePosition();
    }
  }, [visible, content, updatePosition]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handleDismiss = () => setVisible(false);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVisible(false);
    };
    window.addEventListener("scroll", handleDismiss, true);
    window.addEventListener("resize", handleDismiss);
    window.addEventListener("blur", handleDismiss);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("scroll", handleDismiss, true);
      window.removeEventListener("resize", handleDismiss);
      window.removeEventListener("blur", handleDismiss);
      window.removeEventListener("keydown", handleKey);
    };
  }, [visible]);

  const initialOffset =
    coords.effectiveSide === "bottom"
      ? { opacity: 0, y: -4, scale: 0.96 }
      : coords.effectiveSide === "left"
      ? { opacity: 0, x: 4, scale: 0.96 }
      : coords.effectiveSide === "right"
      ? { opacity: 0, x: -4, scale: 0.96 }
      : { opacity: 0, y: 4, scale: 0.96 };

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onPointerDown={hide}
        onFocus={handleFocus}
        onBlur={hide}
        className={className}
      >
        {children}
      </span>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {visible && content && (
              <div
                ref={tooltipRef}
                style={{
                  position: "fixed",
                  top: coords.top,
                  left: coords.left,
                }}
                className="pointer-events-none z-[120]"
              >
                <motion.div
                  initial={initialOffset}
                  animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.13, ease: "easeOut" }}
                  className="glass-tooltip max-w-[260px] rounded-lg px-2.5 py-1.5 text-[11px] font-medium leading-snug text-slate-200 shadow-2xl"
                >
                  {content}
                </motion.div>
              </div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </>
  );
};
