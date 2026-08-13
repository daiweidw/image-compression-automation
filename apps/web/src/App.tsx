import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleGauge,
  Eye,
  EyeOff,
  FolderInput,
  FolderOutput,
  Image as ImageIcon,
  KeyRound,
  LoaderCircle,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import type { ApplicationStatus, ImageItem, ImageListResponse, ImageStatus, JobView, ScanState, SettingsResponse, ShutdownResponse, UpdateSettingsRequest } from "@ica/contracts";
import { api, ApiError } from "./lib/api";

const statusLabels: Record<ImageStatus, string> = {
  pending: "待压缩",
  queued: "排队中",
  compressing: "压缩中",
  compressed: "已压缩",
  source_changed: "原图已更新",
  output_missing: "结果缺失",
  failed: "压缩失败",
  unsupported: "不支持"
};

const compressibleStatuses = new Set<ImageStatus>(["pending", "source_changed", "output_missing", "failed", "compressed"]);

function formatBytes(value: number | null): string {
  if (value == null) return "-";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; size >= 1024 && index < units.length; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

function formatTime(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function ErrorBanner({ error, onClose }: { error: unknown; onClose: () => void }) {
  const message = error instanceof Error ? error.message : "操作失败";
  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      <button className="icon-button" onClick={onClose} title="关闭"><X size={16} /></button>
    </div>
  );
}

function SettingsPanel({ settings, onClose, onRequestShutdown }: { settings: SettingsResponse; onClose?: () => void; onRequestShutdown: () => void }) {
  const queryClient = useQueryClient();
  const [sourceDir, setSourceDir] = useState(settings.sourceDir);
  const [outputDir, setOutputDir] = useState(settings.outputDir);
  const [recursive, setRecursive] = useState(settings.recursive);
  const [concurrency, setConcurrency] = useState(settings.compressionConcurrency);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [createOutputDir, setCreateOutputDir] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const save = useMutation({
    mutationFn: async () => {
      const body: UpdateSettingsRequest = {
        sourceDir,
        outputDir,
        recursive,
        compressionConcurrency: concurrency,
        createOutputDir,
        apiKeyAction: key.trim() ? "replace" : "keep",
        apiKey: key.trim() || null
      };
      return api<SettingsResponse>("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      setKey("");
      setMessage("设置已保存，正在扫描原图目录");
      await queryClient.invalidateQueries();
      onClose?.();
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === "OUTPUT_DIRECTORY_CREATION_REQUIRED") {
        setCreateOutputDir(true);
        setError(new Error("结果目录不存在。再次保存将创建该目录。"));
      } else setError(failure);
    }
  });
  const test = useMutation({
    mutationFn: () => api<{ valid: boolean; compressionCount: number | null }>("/api/settings/test-tinypng", { method: "POST", body: JSON.stringify(key.trim() ? { candidateKey: key.trim() } : {}) }),
    onSuccess: (result) => {
      setError(null);
      setMessage(result.valid ? `连接成功${result.compressionCount == null ? "" : `，本月已用 ${result.compressionCount} 次`}` : "API Key 无效");
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: setError
  });
  const removeKey = useMutation({
    mutationFn: () => api<{ deleted: boolean }>("/api/settings/tinypng-key", { method: "DELETE" }),
    onSuccess: async () => {
      setMessage("API Key 已删除");
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: setError
  });

  return (
    <div className={onClose ? "modal-backdrop" : "setup-page"}>
      <section className={onClose ? "settings-panel modal-panel" : "settings-panel setup-panel"}>
        <header className="panel-header">
          <div>
            <span className="eyebrow">本地配置</span>
            <h2>{settings.configured ? "设置" : "开始使用"}</h2>
          </div>
          {onClose && <button className="icon-button" onClick={onClose} title="关闭设置"><X size={20} /></button>}
        </header>
        {!settings.configured && <p className="setup-lead">选择原图与结果目录，然后填写你的 TinyPNG API Key。</p>}
        {error !== null && <ErrorBanner error={error} onClose={() => setError(null)} />}
        {message && <div className="success-banner"><Check size={17} />{message}</div>}

        <div className="form-section">
          <div className="form-section-title"><FolderInput size={18} /><span>文件夹</span></div>
          <label>
            <span>原图目录</span>
            <input value={sourceDir} onChange={(event) => setSourceDir(event.target.value)} placeholder="/Users/你的名字/Pictures/source" />
          </label>
          <label>
            <span>压缩结果目录</span>
            <input value={outputDir} onChange={(event) => { setOutputDir(event.target.value); setCreateOutputDir(false); }} placeholder="/Users/你的名字/Pictures/output" />
          </label>
          <div className="inline-settings">
            <label className="check-label"><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /><span>扫描子目录</span></label>
            <label className="compact-field"><span>同时压缩</span><select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} 张</option>)}</select></label>
          </div>
        </div>

        <div className="form-section">
          <div className="form-section-title"><KeyRound size={18} /><span>TinyPNG API Key</span><span className={`key-state ${settings.apiKey.configured ? "configured" : ""}`}>{settings.apiKey.configured ? "已配置" : "未配置"}</span></div>
          <label>
            <span>{settings.apiKey.configured ? "输入新 Key 可更换，留空则保持不变" : "API Key"}</span>
            <div className="password-field">
              <input type={showKey ? "text" : "password"} autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder={settings.apiKey.configured ? "输入新 Key" : "从 TinyPNG API Dashboard 获取"} />
              <button className="icon-button" onClick={() => setShowKey((value) => !value)} title={showKey ? "隐藏 API Key" : "显示 API Key"}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button>
            </div>
          </label>
          <div className="security-note"><ShieldCheck size={16} /><span>Key 仅保存到本机后端，不会返回浏览器。图片压缩时会上传至 TinyPNG。</span></div>
          <div className="key-actions">
            <button className="secondary-button" onClick={() => test.mutate()} disabled={test.isPending || (!key.trim() && !settings.apiKey.configured)}>{test.isPending ? <LoaderCircle className="spin" size={16} /> : <CircleGauge size={16} />}测试连接</button>
            {settings.apiKey.configured && <button className="danger-text-button" onClick={() => window.confirm("确定删除已保存的 API Key？") && removeKey.mutate()} disabled={removeKey.isPending}><Trash2 size={16} />删除 Key</button>}
          </div>
        </div>

        <footer className="panel-footer">
          <button className="danger-text-button panel-exit-button" onClick={onRequestShutdown}><Power size={16} />退出应用</button>
          {onClose && <button className="secondary-button" onClick={onClose}>取消</button>}
          <button className="primary-button" onClick={() => save.mutate()} disabled={save.isPending || !sourceDir.trim() || !outputDir.trim()}>{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{settings.configured ? "保存设置" : "保存并扫描"}</button>
        </footer>
      </section>
    </div>
  );
}

function ShutdownDialog({ status, pending, error, onCancel, onConfirm }: {
  status: ApplicationStatus;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const activeTotal = status.activeJobs.queued + status.activeJobs.running;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => !pending && event.target === event.currentTarget && onCancel()}>
      <section className="shutdown-panel" role="dialog" aria-modal="true" aria-labelledby="shutdown-title">
        <header className="shutdown-heading">
          <div className="shutdown-icon"><Power size={22} /></div>
          <div><h2 id="shutdown-title">退出图片压缩工作台？</h2><p>退出后，需要重新双击启动入口才能继续使用。</p></div>
        </header>
        {activeTotal > 0 && (
          <div className="shutdown-warning">
            <AlertCircle size={18} />
            <div><strong>仍有 {activeTotal} 张图片尚未完成</strong><span>正在压缩 {status.activeJobs.running} 张，排队 {status.activeJobs.queued} 张。退出会中断这些任务，已上传的图片仍可能计入 TinyPNG 次数。</span></div>
          </div>
        )}
        {error !== null && <ErrorBanner error={error} onClose={onCancel} />}
        <footer className="panel-footer">
          <button className="secondary-button" onClick={onCancel} disabled={pending}>继续使用</button>
          <button className="danger-button" onClick={onConfirm} disabled={pending}>{pending ? <LoaderCircle className="spin" size={17} /> : <Power size={17} />}{activeTotal > 0 ? "中断任务并退出" : "退出应用"}</button>
        </footer>
      </section>
    </div>
  );
}

function ShutdownState({ stopped }: { stopped: boolean }) {
  return (
    <div className="shutdown-state">
      <div className="shutdown-state-icon">{stopped ? <Check size={28} /> : <LoaderCircle className="spin" size={28} />}</div>
      <h1>{stopped ? "应用已退出" : "正在安全退出"}</h1>
      <p>{stopped ? "本地服务已停止，可以关闭此页面。" : "正在结束任务并保存状态，请稍候。"}</p>
    </div>
  );
}

function StatusPill({ status }: { status: ImageStatus }) {
  return <span className={`status-pill status-${status}`}>{statusLabels[status]}</span>;
}

function PreviewDialog({ image, onClose }: { image: ImageItem; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="preview-panel">
        <header className="panel-header"><div><span className="eyebrow">图片预览</span><h2>{image.filename}</h2></div><button className="icon-button" onClick={onClose} title="关闭预览"><X size={20} /></button></header>
        <div className={`preview-grid ${image.status !== "compressed" ? "single" : ""}`}>
          <figure><div className="preview-image-wrap"><img src={`/api/images/${image.id}/preview?variant=source`} alt={`${image.filename} 原图`} /></div><figcaption><span>原图</span><strong>{formatBytes(image.sourceSize)}</strong></figcaption></figure>
          {image.status === "compressed" && <figure><div className="preview-image-wrap"><img src={`/api/images/${image.id}/preview?variant=output`} alt={`${image.filename} 压缩结果`} /></div><figcaption><span>压缩结果</span><strong>{formatBytes(image.outputSize)}</strong></figcaption></figure>}
        </div>
        <div className="preview-meta"><span>{image.relativePath}</span><span>{image.width && image.height ? `${image.width} × ${image.height}` : "尺寸未知"}</span><StatusPill status={image.status} /></div>
      </section>
    </div>
  );
}

function JobPanel({ jobs }: { jobs: JobView[] }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({ mutationFn: (id: string) => api(`/api/jobs/${id}/cancel`, { method: "POST", body: "{}" }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }) });
  const retry = useMutation({ mutationFn: (id: string) => api(`/api/job-items/${id}/retry`, { method: "POST", body: "{}" }), onSuccess: () => queryClient.invalidateQueries() });
  const latest = jobs[0];
  if (!latest) return <aside className="job-panel empty-jobs"><Sparkles size={22} /><strong>暂无压缩任务</strong><span>选择图片后开始压缩</span></aside>;
  const complete = latest.succeeded + latest.failed + latest.cancelled + latest.skipped;
  return (
    <aside className="job-panel">
      <div className="job-heading"><div><span className="eyebrow">最近任务</span><strong>{latest.status === "running" || latest.status === "queued" ? "正在处理" : "处理结果"}</strong></div><span>{complete}/{latest.total}</span></div>
      <div className="progress-track"><div style={{ width: `${latest.total ? (complete / latest.total) * 100 : 0}%` }} /></div>
      <div className="job-stats"><span className="success-dot">成功 {latest.succeeded}</span><span className="failure-dot">失败 {latest.failed}</span><span>节省 {formatBytes(Math.max(0, latest.inputBytes - latest.outputBytes))}</span></div>
      <div className="job-items">
        {latest.items.slice(0, 6).map((item) => <div className="job-item" key={item.id}><span className={`job-indicator job-${item.status}`}>{item.status === "running" ? <LoaderCircle className="spin" size={14} /> : item.status === "succeeded" ? <Check size={14} /> : item.status === "failed" ? <AlertCircle size={14} /> : <span />}</span><div><strong title={item.relativePath}>{item.filename}</strong><span>{item.status === "failed" ? item.errorMessage : item.status === "succeeded" ? `${formatBytes(item.inputSize)} → ${formatBytes(item.outputSize)}` : item.status === "running" ? "上传并压缩中" : "等待处理"}</span></div>{item.status === "failed" && <button className="icon-button mini" onClick={() => retry.mutate(item.id)} title="重试"><RotateCcw size={14} /></button>}</div>)}
      </div>
      {(latest.status === "running" || latest.status === "queued") && <button className="secondary-button full" onClick={() => cancel.mutate(latest.id)}>取消排队任务</button>}
    </aside>
  );
}

function Workspace({ settings, onOpenSettings, onRequestShutdown }: { settings: SettingsResponse; onOpenSettings: () => void; onRequestShutdown: () => void }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [format, setFormat] = useState("");
  const [sort, setSort] = useState("filename");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ImageItem | null>(null);
  const [error, setError] = useState<unknown>(null);
  const params = new URLSearchParams({ page: String(page), pageSize: "50", sort, order: sort === "filename" ? "asc" : "desc" });
  if (query) params.set("query", query);
  if (status) params.set("status", status);
  if (format) params.set("format", format);

  const imagesQuery = useQuery({ queryKey: ["images", page, query, status, format, sort], queryFn: () => api<ImageListResponse>(`/api/images?${params}`), refetchInterval: 4000 });
  const scanQuery = useQuery({ queryKey: ["scan"], queryFn: () => api<ScanState>("/api/scans/current"), refetchInterval: (query) => query.state.data?.status === "running" ? 500 : 5000 });
  const jobsQuery = useQuery({ queryKey: ["jobs"], queryFn: () => api<JobView[]>("/api/jobs"), refetchInterval: (query) => query.state.data?.some((job) => ["queued", "running"].includes(job.status)) ? 700 : 5000 });
  useEffect(() => {
    if (scanQuery.data?.status === "succeeded") void queryClient.invalidateQueries({ queryKey: ["images"] });
  }, [scanQuery.data?.status, scanQuery.data?.finishedAt, queryClient]);
  useEffect(() => {
    if (jobsQuery.data?.some((job) => ["queued", "running"].includes(job.status))) void queryClient.invalidateQueries({ queryKey: ["images"] });
  }, [jobsQuery.data, queryClient]);
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = () => {
      void queryClient.invalidateQueries({ queryKey: ["scan"] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      void queryClient.invalidateQueries({ queryKey: ["images"] });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    };
    return () => events.close();
  }, [queryClient]);

  const scan = useMutation({ mutationFn: () => api<ScanState>("/api/scans", { method: "POST", body: JSON.stringify({ mode: "incremental" }) }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["scan"] }), onError: setError });
  const compress = useMutation<JobView, Error, boolean>({
    mutationFn: async (confirmRecompress) => api<JobView>("/api/jobs", { method: "POST", body: JSON.stringify({ clientRequestId: crypto.randomUUID(), imageIds: [...selected], confirmRecompress }) }),
    onSuccess: async () => { setSelected(new Set()); setError(null); await queryClient.invalidateQueries(); },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === "RECOMPRESS_CONFIRMATION_REQUIRED" && window.confirm("选择中包含已压缩图片，确定重新压缩并覆盖旧结果？")) compress.mutate(true);
      else setError(failure);
    }
  });
  const images = imagesQuery.data?.items ?? [];
  const selectable = images.filter((item) => compressibleStatuses.has(item.status));
  const pageAllSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id));
  const togglePage = () => setSelected((current) => { const next = new Set(current); if (pageAllSelected) selectable.forEach((item) => next.delete(item.id)); else selectable.forEach((item) => next.add(item.id)); return next; });
  const totalPages = Math.max(1, Math.ceil((imagesQuery.data?.total ?? 0) / 50));
  const summary = imagesQuery.data?.summary;
  const selectAllFiltered = async () => {
    try {
      const selectionParams = new URLSearchParams();
      if (query) selectionParams.set("query", query);
      if (status) selectionParams.set("status", status);
      if (format) selectionParams.set("format", format);
      const result = await api<{ ids: string[] }>(`/api/images/selectable?${selectionParams}`);
      setSelected(new Set(result.ids));
    } catch (failure) {
      setError(failure);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><ImageIcon size={22} /></div><div><strong>图片压缩工作台</strong><span>TinyPNG 本地管理</span></div></div>
        <div className="directory-context"><FolderInput size={16} /><span title={settings.sourceDir}>{settings.sourceDir}</span><span className="path-arrow">→</span><FolderOutput size={16} /><span title={settings.outputDir}>{settings.outputDir}</span></div>
        <div className="top-actions"><button className="secondary-button" onClick={() => scan.mutate()} disabled={scan.isPending || scanQuery.data?.status === "running"}>{scanQuery.data?.status === "running" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}重新扫描</button><button className="icon-button bordered" onClick={onOpenSettings} title="设置" aria-label="设置"><Settings size={19} /></button><button className="icon-button bordered exit-button" onClick={onRequestShutdown} title="退出应用" aria-label="退出应用"><Power size={19} /></button></div>
      </header>

      <main className="workspace-layout">
        <section className="library-section">
          {error !== null && <ErrorBanner error={error} onClose={() => setError(null)} />}
          <div className="summary-strip">
            <div className="summary-main"><span className="eyebrow">图片总览</span><strong>{imagesQuery.data?.total ?? 0}<small> 张图片</small></strong></div>
            <div className="summary-cell"><span>待处理</span><strong>{(summary?.pending ?? 0) + (summary?.source_changed ?? 0) + (summary?.output_missing ?? 0) + (summary?.failed ?? 0)}</strong></div>
            <div className="summary-cell success"><span>已压缩</span><strong>{summary?.compressed ?? 0}</strong></div>
            <div className="summary-cell"><span>原图大小</span><strong>{formatBytes(summary?.sourceBytes ?? 0)}</strong></div>
            <div className="summary-cell saved"><span>累计节省</span><strong>{formatBytes(summary?.savedBytes ?? 0)}</strong></div>
            <div className={`scan-state ${scanQuery.data?.status === "running" ? "active" : ""}`}>{scanQuery.data?.status === "running" ? <><LoaderCircle className="spin" size={16} /><span>扫描 {scanQuery.data.processedCount}</span></> : <><Check size={16} /><span>已同步</span></>}</div>
          </div>

          <div className="list-toolbar">
            <div className="search-field"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索文件名或路径" /></div>
            <select aria-label="状态筛选" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <select aria-label="格式筛选" value={format} onChange={(event) => { setFormat(event.target.value); setPage(1); }}><option value="">全部格式</option><option value="png">PNG</option><option value="jpg,jpeg">JPEG</option><option value="webp">WebP</option><option value="avif">AVIF</option></select>
            <select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="filename">文件名</option><option value="sourceSize">文件大小</option><option value="sourceMtime">更新时间</option><option value="compressedAt">压缩时间</option><option value="savedRatio">节省比例</option></select>
          </div>

          {(selected.size > 0 || selectable.length > 0) && <div className="selection-bar"><span>已选择 <strong>{selected.size}</strong> 张</span><button className="text-button" onClick={() => void selectAllFiltered()}>选择全部筛选结果</button>{selected.size > 0 && <button className="text-button" onClick={() => setSelected(new Set())}>清空</button>}<button className="primary-button" onClick={() => compress.mutate(false)} disabled={selected.size === 0 || compress.isPending || !settings.apiKey.configured}>{compress.isPending ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}压缩所选图片</button></div>}

          <div className="table-wrap">
            <table className="image-table">
              <thead><tr><th className="select-column"><input type="checkbox" checked={pageAllSelected} onChange={togglePage} aria-label="选择当前页可压缩图片" /></th><th>图片</th><th>状态</th><th>原图</th><th>压缩结果</th><th>节省</th><th>更新时间</th></tr></thead>
              <tbody>
                {imagesQuery.isLoading && <tr><td colSpan={7} className="empty-table"><LoaderCircle className="spin" size={24} />正在读取图片</td></tr>}
                {!imagesQuery.isLoading && images.length === 0 && <tr><td colSpan={7} className="empty-table"><ImageIcon size={28} /><strong>目录中没有可显示的图片</strong><span>放入 PNG、JPEG、WebP 或 AVIF 后重新扫描</span></td></tr>}
                {images.map((image) => {
                  const canSelect = compressibleStatuses.has(image.status);
                  return <tr key={image.id} className={selected.has(image.id) ? "selected-row" : ""}><td><input type="checkbox" aria-label={`选择 ${image.filename}`} disabled={!canSelect} checked={selected.has(image.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(image.id)) next.delete(image.id); else next.add(image.id); return next; })} /></td><td><button className="image-cell" onClick={() => setPreview(image)}><img src={`/api/images/${image.id}/thumbnail`} alt="" loading="lazy" /><span><strong title={image.filename}>{image.filename}</strong><small title={image.relativePath}>{image.relativePath}</small></span></button></td><td><StatusPill status={image.status} />{image.errorMessage && <span className="row-error" title={image.errorMessage}><AlertCircle size={14} /></span>}</td><td><strong>{formatBytes(image.sourceSize)}</strong><small>{image.width && image.height ? `${image.width} × ${image.height}` : image.extension.toUpperCase()}</small></td><td><strong>{formatBytes(image.outputSize)}</strong><small>{formatTime(image.compressedAt)}</small></td><td>{image.savedRatio == null ? <span className="muted">-</span> : <strong className="saved-value">-{(image.savedRatio * 100).toFixed(1)}%</strong>}</td><td><span className="muted">{formatTime(image.sourceMtime)}</span></td></tr>;
                })}
              </tbody>
            </table>
          </div>
          <footer className="pagination"><span>共 {imagesQuery.data?.total ?? 0} 张</span><div><button className="icon-button bordered" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} title="上一页"><ChevronLeft size={17} /></button><span>{page} / {totalPages}</span><button className="icon-button bordered" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} title="下一页"><ChevronRight size={17} /></button></div></footer>
        </section>
        <JobPanel jobs={jobsQuery.data ?? []} />
      </main>
      {preview && <PreviewDialog image={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

export function App() {
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/api/settings") });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shutdownStatus, setShutdownStatus] = useState<ApplicationStatus | null>(null);
  const [shutdownPhase, setShutdownPhase] = useState<"idle" | "stopping" | "stopped">("idle");
  const shutdownStatusMutation = useMutation({
    mutationFn: () => api<ApplicationStatus>("/api/application/status"),
    onSuccess: setShutdownStatus
  });
  const shutdownMutation = useMutation({
    mutationFn: (confirmActiveJobs: boolean) => api<ShutdownResponse>("/api/application/shutdown", { method: "POST", body: JSON.stringify({ confirmActiveJobs }) }),
    onSuccess: async () => {
      setShutdownStatus(null);
      setSettingsOpen(false);
      setShutdownPhase("stopping");
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        try {
          await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(1000) });
        } catch {
          setShutdownPhase("stopped");
          return;
        }
      }
    },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === "ACTIVE_JOBS_CONFIRMATION_REQUIRED") shutdownStatusMutation.mutate();
    }
  });
  const requestShutdown = () => shutdownStatusMutation.mutate();
  if (shutdownPhase !== "idle") return <ShutdownState stopped={shutdownPhase === "stopped"} />;
  if (settingsQuery.isLoading) return <div className="full-loading"><div className="brand-mark"><ImageIcon size={24} /></div><LoaderCircle className="spin" size={22} /><span>正在启动本地工作台</span></div>;
  if (settingsQuery.error || !settingsQuery.data) return <div className="fatal-state"><AlertCircle size={30} /><h1>无法连接本地服务</h1><p>{settingsQuery.error instanceof Error ? settingsQuery.error.message : "请重新启动应用"}</p></div>;
  return <>
    {!settingsQuery.data.configured
      ? <SettingsPanel settings={settingsQuery.data} onRequestShutdown={requestShutdown} />
      : <><Workspace settings={settingsQuery.data} onOpenSettings={() => setSettingsOpen(true)} onRequestShutdown={requestShutdown} />{settingsOpen && <SettingsPanel settings={settingsQuery.data} onClose={() => setSettingsOpen(false)} onRequestShutdown={requestShutdown} />}</>}
    {shutdownStatus && <ShutdownDialog
      status={shutdownStatus}
      pending={shutdownMutation.isPending}
      error={shutdownMutation.error}
      onCancel={() => setShutdownStatus(null)}
      onConfirm={() => shutdownMutation.mutate(shutdownStatus.activeJobs.queued + shutdownStatus.activeJobs.running > 0)}
    />}
  </>;
}
