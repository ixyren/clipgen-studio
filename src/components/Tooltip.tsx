import React, { useState, useRef, useEffect, useCallback } from "react";
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
  transform: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = "top",
  delay = 180,
  className = "inline-flex",
}) => {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);

  const computeCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let effectiveSide = side;
    if (side === "top" && rect.top < 44) effectiveSide = "bottom";
    if (side === "bottom" && vh - rect.bottom < 44) effectiveSide = "top";

    const centerX = Math.max(16, Math.min(vw - 16, rect.left + rect.width / 2));
    const centerY = Math.max(16, Math.min(vh - 16, rect.top + rect.height / 2));

    switch (effectiveSide) {
      case "bottom":
        setCoords({
          top: rect.bottom + gap,
          left: centerX,
          transform: "translate(-50%, 0%)",
        });
        break;
      case "left":
        setCoords({
          top: centerY,
          left: Math.max(8, rect.left - gap),
          transform: "translate(-100%, -50%)",
        });
        break;
      case "right":
        setCoords({
          top: centerY,
          left: Math.min(vw - 8, rect.right + gap),
          transform: "translate(0%, -50%)",
        });
        break;
      case "top":
      default:
        setCoords({
          top: rect.top - gap,
          left: centerX,
          transform: "translate(-50%, -100%)",
        });
        break;
    }
  }, [side]);

  const show = () => {
    if (!content) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      computeCoords();
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

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handleDismiss = () => setVisible(false);
    window.addEventListener("scroll", handleDismiss, true);
    window.addEventListener("blur", handleDismiss);
    return () => {
      window.removeEventListener("scroll", handleDismiss, true);
      window.removeEventListener("blur", handleDismiss);
    };
  }, [visible]);

  const initialOffset =
    side === "bottom"
      ? { opacity: 0, y: -4, scale: 0.96 }
      : side === "left"
      ? { opacity: 0, x: 4, scale: 0.96 }
      : side === "right"
      ? { opacity: 0, x: -4, scale: 0.96 }
      : { opacity: 0, y: 4, scale: 0.96 };

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={hide}
        onPointerDown={hide}
        onFocus={show}
        onBlur={hide}
        className={className}
      >
        {children}
      </span>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {visible && content && coords && (
              <div
                style={{
                  position: "fixed",
                  top: coords.top,
                  left: coords.left,
                  transform: coords.transform,
                }}
                className="pointer-events-none z-[120]"
              >
                <motion.div
                  initial={initialOffset}
                  animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.14, ease: "easeOut" }}
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
