import React, { useState } from "react";
import {
  Activity,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FolderOpen,
  Loader2,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import type { JobState } from "../types";

interface JobQueueDrawerProps {
  jobs: JobState[];
  onOpenFolder: (path: string) => void;
  onCancelJob: (jobId: string) => void;
  onClearFinished: () => void;
}

export const JobQueueDrawer: React.FC<JobQueueDrawerProps> = ({
  jobs,
  onOpenFolder,
  onCancelJob,
  onClearFinished,
}) => {
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);

  if (jobs.length === 0) {
    return null;
  }

  const toggleLogs = (id: string) => {
    setExpandedLogs((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyJobLogs = (jobId: string, logs: string[]) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(logs.join("\n"));
      setCopiedJobId(jobId);
      setTimeout(() => setCopiedJobId(null), 2000);
    }
  };

  const hasFinished = jobs.some(
    (j) =>
      j.status === "completed" ||
      j.status === "error" ||
      j.status === "cancelled"
  );

  return (
    <section className="studio-panel rounded-2xl p-4 sm:p-5 space-y-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Activity className="h-4 w-4 text-cyan-400" />
          <h3 className="text-sm font-semibold text-white">
            Cola de Descargas y Procesamiento ({jobs.length})
          </h3>
        </div>
        {hasFinished && (
          <button
            type="button"
            onClick={onClearFinished}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.08]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Limpiar finalizados</span>
          </button>
        )}
      </div>

      <div className="space-y-3">
        {jobs.map((job) => {
          const isCompleted = job.status === "completed";
          const isError = job.status === "error";
          const isCancelled = job.status === "cancelled";
          const isActive = !isCompleted && !isError && !isCancelled;
          const showLog = Boolean(expandedLogs[job.job_id]);
          const firstFile = job.output_files[0] ?? "";
          const parentDir = firstFile.replace(/[/\\][^/\\]+$/, "");

          const totalPct = Math.min(100, Math.max(0, job.percent));
          const clipPct = Math.min(
            100,
            Math.max(0, job.clip_percent ?? job.percent)
          );
          const clipRemaining = Math.max(0, 100 - clipPct);
          const clipTitle =
            job.clip_index != null && job.clip_total != null
              ? `Clip ${job.clip_index}/${job.clip_total}${
                  job.clip_name ? `: "${job.clip_name}"` : ""
                }`
              : job.clip_name || "Archivo / Clip actual";

          return (
            <div
              key={job.job_id}
              className="rounded-xl border border-white/10 bg-[#090A0F]/85 p-3.5 space-y-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  {isCompleted ? (
                    <CheckCircle2 className="h-4.5 w-4.5 shrink-0 text-emerald-400" />
                  ) : isCancelled ? (
                    <Ban className="h-4.5 w-4.5 shrink-0 text-amber-400" />
                  ) : isError ? (
                    <XCircle className="h-4.5 w-4.5 shrink-0 text-rose-400" />
                  ) : (
                    <Loader2 className="h-4.5 w-4.5 shrink-0 animate-spin text-violet-400" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-xs font-semibold text-white">
                        {job.title}
                      </p>
                      {isCancelled && (
                        <span className="shrink-0 rounded-full border border-amber-500/35 bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-200">
                          Cancelado
                        </span>
                      )}
                    </div>
                    <p className="truncate text-[11px] text-slate-400">
                      {job.current_step}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {isActive && (
                    <span className="font-mono text-[11px] text-slate-300">
                      {job.speed !== "--" ? `${job.speed} • ` : ""}
                      {job.eta !== "--" ? `ETA ${job.eta} • ` : ""}
                      {totalPct.toFixed(1)}%
                    </span>
                  )}

                  {isActive && (
                    <button
                      type="button"
                      onClick={() => onCancelJob(job.job_id)}
                      className="flex items-center gap-1 rounded-lg border border-rose-500/35 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-200 transition hover:bg-rose-500/25"
                      title="Cancelar descarga en proceso"
                    >
                      <Ban className="h-3.5 w-3.5" />
                      <span>Cancelar</span>
                    </button>
                  )}

                  {(isCompleted || (isCancelled && job.output_files.length > 0)) &&
                    job.output_files.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onOpenFolder(firstFile)}
                          className="flex items-center gap-1.5 rounded-lg border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25"
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                          <span>Mostrar en carpeta</span>
                        </button>
                        {parentDir && (
                          <button
                            type="button"
                            onClick={() => onOpenFolder(parentDir)}
                            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-white/[0.08]"
                          >
                            <FolderOpen className="h-3.5 w-3.5 text-cyan-400" />
                            <span>Abrir carpeta</span>
                          </button>
                        )}
                      </div>
                    )}

                  <button
                    type="button"
                    onClick={() => toggleLogs(job.job_id)}
                    className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-slate-300 hover:bg-white/[0.08]"
                  >
                    <Terminal className="h-3 w-3" />
                    <span>Logs</span>
                    {showLog ? (
                      <ChevronUp className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </div>

              {/* Overall Progress Bar */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span>Progreso Total</span>
                  <span className="font-mono text-slate-300">
                    {isError
                      ? "Error"
                      : isCancelled
                      ? `Cancelado en ${totalPct.toFixed(1)}%`
                      : `${totalPct.toFixed(1)}%`}
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      isError
                        ? "bg-rose-500"
                        : isCancelled
                        ? "bg-amber-500/80"
                        : isCompleted
                        ? "bg-emerald-500"
                        : "bg-gradient-to-r from-violet-500 to-cyan-400"
                    }`}
                    style={{
                      width: `${isError ? 100 : Math.min(100, Math.max(2, totalPct))}%`,
                    }}
                  />
                </div>
              </div>

              {/* Second Progress Bar: Specific Current Clip Progress */}
              {isActive && (
                <div className="space-y-1 rounded-lg border border-cyan-500/15 bg-cyan-500/[0.03] px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2 text-[10px]">
                    <span className="truncate font-medium text-cyan-200">
                      {clipTitle}
                    </span>
                    <span className="shrink-0 font-mono text-cyan-300">
                      {clipPct.toFixed(1)}% • Falta {clipRemaining.toFixed(1)}%
                      {job.eta !== "--" ? ` (${job.eta})` : ""}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.max(2, clipPct))}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Generated Files List */}
              {(isCompleted || (isCancelled && job.output_files.length > 0)) &&
                job.output_files.length > 0 && (
                  <div className="space-y-1.5 pt-0.5">
                    <div className="flex flex-wrap gap-1.5">
                      {job.output_files.map((file) => {
                        const base = file.split(/[/\\]/).pop() ?? file;
                        return (
                          <button
                            key={file}
                            type="button"
                            onClick={() => onOpenFolder(file)}
                            title={file}
                            className="rounded-md border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[11px] text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200"
                          >
                            {base}
                          </button>
                        );
                      })}
                    </div>
                    <p
                      className="truncate font-mono text-[10px] text-slate-500"
                      title={firstFile}
                    >
                      Ubicación: {firstFile}
                    </p>
                  </div>
                )}

              {/* Console Output */}
              {showLog && (
                <div className="space-y-1.5 rounded-xl border border-white/10 bg-black/80 p-3 font-mono text-[11px] leading-relaxed">
                  <div className="flex items-center justify-between border-b border-white/10 pb-1.5 text-[10px] text-slate-400">
                    <span>Registro de ejecución en tiempo real</span>
                    <button
                      type="button"
                      onClick={() => copyJobLogs(job.job_id, job.logs)}
                      className="flex items-center gap-1 rounded bg-white/[0.06] px-2 py-0.5 text-slate-300 hover:bg-white/[0.12] hover:text-white"
                    >
                      {copiedJobId === job.job_id ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          <span className="text-emerald-300">Copiado</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          <span>Copiar log</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
                    {job.logs.length === 0 ? (
                      <span className="text-slate-500">Iniciando proceso...</span>
                    ) : (
                      job.logs.map((line, i) => {
                        const isSuccess = line.startsWith("✓");
                        const isErrorLine =
                          line.includes("ERROR") || line.includes("error");
                        const isCancelLine = line.startsWith("⛔");
                        const isProgress =
                          line.startsWith("⬇") || line.startsWith("[download]");
                        const isStep =
                          line.startsWith("▶") ||
                          line.startsWith("⚙") ||
                          line.startsWith("🔗");

                        const colorClass = isSuccess
                          ? "text-emerald-300 font-semibold"
                          : isCancelLine
                          ? "text-amber-300 font-semibold"
                          : isErrorLine
                          ? "text-rose-400 font-semibold"
                          : isProgress
                          ? "text-cyan-300"
                          : isStep
                          ? "text-violet-300 font-medium"
                          : "text-slate-300";

                        return (
                          <div
                            key={i}
                            className={`whitespace-pre-wrap break-all ${colorClass}`}
                          >
                            {line}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
