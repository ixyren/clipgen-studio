import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileJson,
  X,
  Layers,
  ArrowRight,
  Plus,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import type { ParsedClip } from "../utils/jsonParser";
import { formatTimeShort } from "../utils/time";
import { Tooltip } from "./Tooltip";

interface PasteConfirmModalProps {
  isOpen: boolean;
  streamUrl: string | null;
  clips: ParsedClip[];
  onConfirm: (replace: boolean) => void;
  onClose: () => void;
}

export const PasteConfirmModal: React.FC<PasteConfirmModalProps> = ({
  isOpen,
  streamUrl,
  clips,
  onConfirm,
  onClose,
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 select-none">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/80 backdrop-blur-sm"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-indigo-500/30 bg-[#111114] shadow-2xl shadow-indigo-500/10 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 bg-[#18181C]/80 px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                  <FileJson className="h-4 w-4" />
                </div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">
                    JSON Detectado
                  </h3>
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/30">
                    {clips.length} {clips.length === 1 ? "clip" : "clips"}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1 text-slate-400 hover:bg-white/10 hover:text-white smooth-btn"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3.5 custom-scrollbar text-xs">
              {streamUrl && (
                <Tooltip
                  className="block w-full"
                  content="Se vinculará a estos clips y se cargará en el visor automáticamente"
                >
                  <div className="flex flex-col gap-1 rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-3">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-indigo-300">
                      <ExternalLink className="h-3.5 w-3.5 text-indigo-400" />
                      <span>URL detectada</span>
                    </div>
                    <div className="font-mono text-[11px] text-slate-300 break-all select-text bg-black/40 px-2.5 py-1.5 rounded-lg border border-white/5">
                      {streamUrl}
                    </div>
                  </div>
                </Tooltip>
              )}

              {/* Clips preview summary */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="flex items-center gap-1 font-semibold text-slate-300">
                    <Layers className="h-3.5 w-3.5 text-indigo-400" />
                    Clips a importar
                  </span>
                  <span className="tabular-nums font-mono text-slate-500">
                    Total: {clips.length}
                  </span>
                </div>

                <div className="max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-[#09090B] p-2 space-y-1 custom-scrollbar">
                  {clips.map((c, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-[11px] border border-white/5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[10px] text-slate-500 shrink-0">
                          #{String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="font-medium text-slate-200 truncate">
                          {c.title}
                        </span>
                      </div>

                      <div className="flex items-center gap-1 shrink-0 font-mono text-[10px] tabular-nums text-indigo-300 bg-indigo-500/15 border border-indigo-500/25 px-1.5 py-0.5 rounded">
                        <span>{formatTimeShort(c.start)}</span>
                        <ArrowRight className="h-2.5 w-2.5 text-slate-400" />
                        <span>{formatTimeShort(c.end)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Action Footer */}
            <div className="border-t border-white/10 bg-[#18181C]/90 p-4 flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2.5">
                <Tooltip className="flex" content="Borra los clips actuales en la cola y carga solo estos">
                  <button
                    type="button"
                    onClick={() => onConfirm(true)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-4 py-2.5 text-xs font-semibold text-white shadow-lg shadow-indigo-500/25 hover:from-indigo-400 hover:to-violet-500 smooth-btn"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>Reemplazar Lista</span>
                  </button>
                </Tooltip>

                <Tooltip className="flex" content="Conserva tu cola actual y agrega estos al final">
                  <button
                    type="button"
                    onClick={() => onConfirm(false)}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/10 hover:text-white smooth-btn"
                  >
                    <Plus className="h-3.5 w-3.5 text-emerald-400" />
                    <span>Añadir a la Cola</span>
                  </button>
                </Tooltip>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="text-center text-[11px] text-slate-400 hover:text-slate-200 py-1 smooth-btn"
              >
                Cancelar
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
