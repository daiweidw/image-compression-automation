import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import {
  AlertCircle,
  Check,
  Columns2,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  FolderOutput,
  FolderSearch,
  Image as ImageIcon,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  Maximize2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { TINYPNG_FREE_MONTHLY_LIMIT, type ApplicationStatus, type DesktopCapabilities, type ImageItem, type ImageListResponse, type ImageStatus, type JobListResponse, type JobView, type LocalAppEvent, type ScanState, type SettingsResponse, type ShutdownResponse, type TinyPngKeyListResponse, type TinyPngKeyView, type TinyPngUsage, type UpdateSettingsRequest } from "@ica/contracts";
import { api, ApiError } from "./lib/api";

declare global {
  interface Window {
    icaDesktop?: {
      pathForFile(file: File): string;
    };
  }
}

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
const defaultSelectedStatuses = new Set<ImageStatus>(["pending", "source_changed", "output_missing"]);

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

function SettingsPanel({ settings, capabilities, keys, refreshingKeyId, keyActionError, onRefreshKey, onClearKeyActionError, onClose, onRequestShutdown }: { settings: SettingsResponse; capabilities: DesktopCapabilities; keys: TinyPngKeyListResponse; refreshingKeyId: string | null; keyActionError: unknown; onRefreshKey: (keyId: string) => void; onClearKeyActionError: () => void; onClose?: () => void; onRequestShutdown: () => void }) {
  const queryClient = useQueryClient();
  const [concurrency, setConcurrency] = useState(settings.compressionConcurrency);
  const [keyName, setKeyName] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [renamingKeyId, setRenamingKeyId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const body: UpdateSettingsRequest = {
        outputMode: settings.outputMode,
        outputDir: settings.outputDir,
        recursive: true,
        compressionConcurrency: concurrency,
        conflictStrategy: "suffix",
        createOutputDir: true
      };
      return api<SettingsResponse>("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      setMessage("设置已保存");
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      onClose?.();
    },
    onError: (failure) => {
      setError(failure);
    }
  });
  const addKey = useMutation({
    mutationFn: () => api<TinyPngKeyView>("/api/tinypng/keys", { method: "POST", body: JSON.stringify({ name: keyName.trim(), apiKey: key.trim() }) }),
    onSuccess: async (result) => {
      setKeyName("");
      setKey("");
      setError(null);
      setMessage(`${result.name} 已添加`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tinypng-keys"] }),
        queryClient.invalidateQueries({ queryKey: ["tinypng-usage"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] })
      ]);
    },
    onError: setError
  });
  const activateKey = useMutation({
    mutationFn: (keyId: string) => api<TinyPngKeyView>("/api/tinypng/keys/active", { method: "PUT", body: JSON.stringify({ keyId }) }),
    onSuccess: async (result) => {
      setMessage(`已切换到 ${result.name}`);
      await queryClient.invalidateQueries();
    },
    onError: setError
  });
  const renameKey = useMutation({
    mutationFn: ({ keyId, name }: { keyId: string; name: string }) => api<TinyPngKeyView>(`/api/tinypng/keys/${keyId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: async () => {
      setRenamingKeyId(null);
      setRenameValue("");
      setError(null);
      setMessage("名称已更新");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tinypng-keys"] }),
        queryClient.invalidateQueries({ queryKey: ["tinypng-usage"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] })
      ]);
    },
    onError: setError
  });
  const removeKey = useMutation({
    mutationFn: (keyId: string) => api<{ deleted: boolean }>(`/api/tinypng/keys/${keyId}`, { method: "DELETE" }),
    onSuccess: async () => {
      setMessage("API Key 已删除");
      await queryClient.invalidateQueries();
    },
    onError: setError
  });

  const beginRename = (item: TinyPngKeyView) => {
    setError(null);
    setMessage(null);
    setRenamingKeyId(item.id);
    setRenameValue(item.name);
  };
  const cancelRename = () => {
    if (renameKey.isPending) return;
    setRenamingKeyId(null);
    setRenameValue("");
    setError(null);
  };
  const submitRename = (item: TinyPngKeyView) => {
    const name = renameValue.trim();
    if (!name) {
      setError(new Error("API Key 名称不能为空"));
      return;
    }
    if ([...name].length > 30) {
      setError(new Error("API Key 名称不能超过 30 个字符"));
      return;
    }
    if (name === item.name) {
      cancelRename();
      return;
    }
    renameKey.mutate({ keyId: item.id, name });
  };

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
        {!settings.apiKey.configured && <p className="setup-lead">添加 TinyPNG API Key 后即可开始压缩。</p>}
        {error !== null && <ErrorBanner error={error} onClose={() => setError(null)} />}
        {error === null && keyActionError !== null && <ErrorBanner error={keyActionError} onClose={onClearKeyActionError} />}
        {message && <div className="success-banner"><Check size={17} />{message}</div>}

        <div className="form-section compact-settings-section">
          <div className="form-section-title"><SlidersHorizontal size={18} /><span>压缩设置</span></div>
          <label className="compact-field"><span>同时压缩</span><select value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} 张</option>)}</select></label>
        </div>

        <div className="form-section">
          <div className="form-section-title"><KeyRound size={18} /><span>TinyPNG API Key</span><span className={`key-state ${keys.items.length ? "configured" : ""}`}>{keys.items.length ? `${keys.items.length} 个` : "未配置"}</span></div>
          {keys.items.length > 0 && <div className="key-list">{keys.items.map((item) => {
            const editing = renamingKeyId === item.id;
            const renameCandidate = renameValue.trim();
            const canSubmitRename = Boolean(renameCandidate && [...renameCandidate].length <= 30 && renameCandidate !== item.name);
            return <div className={`key-list-item ${item.active ? "active" : ""}`} key={item.id}>
              <div className="key-list-main"><span className={`key-status-dot usage-${item.lastValidationStatus === "invalid" ? "invalid" : item.status}`} /><div className="key-list-details">{editing
                ? <input className="key-rename-input" aria-label={`重命名 ${item.name}`} value={renameValue} maxLength={30} autoFocus disabled={renameKey.isPending} onFocus={(event) => event.currentTarget.select()} onChange={(event) => { setRenameValue(event.target.value); setError(null); }} onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") { event.preventDefault(); submitRename(item); }
                  if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
                }} />
                : <strong>{item.name}</strong>}<span>{item.lastValidationStatus === "invalid" ? "API Key 无效" : item.used == null ? "额度未知" : `${item.used} / ${item.limit}，剩余 ${item.remaining} 次`}</span></div>{item.active && <span className="active-key-label"><Check size={12} />当前</span>}</div>
              <div className="key-list-actions">{editing ? <>
                <button className="icon-button mini" onClick={() => submitRename(item)} disabled={renameKey.isPending || !canSubmitRename} title="确认重命名" aria-label="确认重命名">{renameKey.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}</button>
                <button className="icon-button mini" onClick={cancelRename} disabled={renameKey.isPending} title="取消重命名" aria-label="取消重命名"><X size={14} /></button>
              </> : <>
                {!item.active && <button className="secondary-button compact-button" onClick={() => activateKey.mutate(item.id)} disabled={activateKey.isPending}>设为当前</button>}
                <button className="icon-button mini" onClick={() => onRefreshKey(item.id)} disabled={refreshingKeyId === item.id} title={`刷新 ${item.name} 额度`}>{refreshingKeyId === item.id ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}</button>
                <button className="icon-button mini" onClick={() => beginRename(item)} disabled={renameKey.isPending} title={`重命名 ${item.name}`}><Pencil size={14} /></button>
                <button className="icon-button mini danger-icon" onClick={() => window.confirm(`确定删除“${item.name}”？`) && removeKey.mutate(item.id)} disabled={removeKey.isPending || (item.active && keys.items.length > 1)} title={item.active && keys.items.length > 1 ? "请先切换到其他 Key" : `删除 ${item.name}`}><Trash2 size={14} /></button>
              </>}</div>
            </div>;
          })}</div>}
          <div className="add-key-form">
            <label><span>名称</span><input autoComplete="off" value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="例如：工作账号" maxLength={30} /></label>
            <label><span>API Key</span>
            <div className="password-field">
              <input type={showKey ? "text" : "password"} autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="从 TinyPNG API Dashboard 获取" />
              <button className="icon-button" onClick={() => setShowKey((value) => !value)} title={showKey ? "隐藏 API Key" : "显示 API Key"}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button>
            </div>
            </label>
            <button className="secondary-button add-key-button" onClick={() => addKey.mutate()} disabled={addKey.isPending || !keyName.trim() || !key.trim()}>{addKey.isPending ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}添加 Key</button>
          </div>
          <div className="security-note"><ShieldCheck size={16} /><span>{capabilities.encryptedSecretStorage ? "Key 已由 macOS 系统安全存储加密，不会返回页面。" : "Key 仅保存到本机后端，不会返回浏览器。"} 图片压缩时会上传至 TinyPNG。</span></div>
        </div>

        <footer className="panel-footer">
          <button className="danger-text-button panel-exit-button" onClick={onRequestShutdown}><Power size={16} />退出应用</button>
          {onClose && <button className="secondary-button" onClick={onClose}>取消</button>}
          <button className="primary-button" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}保存设置</button>
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

function PreviewDialog({ image, capabilities, onClose }: { image: ImageItem; capabilities: DesktopCapabilities; onClose: () => void }) {
  const [mode, setMode] = useState<"slider" | "side-by-side">("slider");
  const [position, setPosition] = useState(50);
  const reveal = useMutation({ mutationFn: (variant: "source" | "output") => api("/api/platform/reveal-image", { method: "POST", body: JSON.stringify({ imageId: image.id, variant }) }) });
  const hasOutput = image.status === "compressed";
  const sourceUrl = `/api/images/${image.id}/preview?variant=source`;
  const outputUrl = `/api/images/${image.id}/preview?variant=output`;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="preview-panel">
        <header className="panel-header"><div><span className="eyebrow">效果对比</span><h2>{image.filename}</h2></div><div className="preview-actions">{hasOutput && <div className="segmented-control"><button className={mode === "slider" ? "active" : ""} onClick={() => setMode("slider")} title="滑块对比"><SlidersHorizontal size={16} /></button><button className={mode === "side-by-side" ? "active" : ""} onClick={() => setMode("side-by-side")} title="并排对比"><Columns2 size={16} /></button></div>}<button className="icon-button" onClick={onClose} title="关闭预览"><X size={20} /></button></div></header>
        <TransformWrapper initialScale={1} minScale={0.5} maxScale={4} centerOnInit wheel={{ step: 0.15 }}>
          {({ zoomIn, zoomOut, resetTransform }) => <>
            <div className="compare-toolbar"><button className="icon-button bordered" onClick={() => zoomOut()} title="缩小"><ZoomOut size={16} /></button><button className="icon-button bordered" onClick={() => zoomIn()} title="放大"><ZoomIn size={16} /></button><button className="icon-button bordered" onClick={() => resetTransform()} title="适应窗口"><Maximize2 size={16} /></button>{capabilities.revealInFinder && <><button className="secondary-button" onClick={() => reveal.mutate("source")}><FolderSearch size={15} />显示原图</button>{hasOutput && <button className="secondary-button" onClick={() => reveal.mutate("output")}><FolderOutput size={15} />显示结果</button>}</>}</div>
            <TransformComponent wrapperClass="compare-transform" contentClass="compare-content">
              {!hasOutput ? <div className="compare-single"><img src={sourceUrl} alt={`${image.filename} 原图`} /></div> : mode === "side-by-side" ? <div className="compare-side"><figure><img src={sourceUrl} alt={`${image.filename} 原图`} /><figcaption>原图</figcaption></figure><figure><img src={outputUrl} alt={`${image.filename} 压缩结果`} /><figcaption>压缩结果</figcaption></figure></div> : <div className="compare-slider"><img className="compare-base" src={sourceUrl} alt={`${image.filename} 原图`} /><div className="compare-overlay" style={{ width: `${position}%` }}><img src={outputUrl} alt={`${image.filename} 压缩结果`} /></div><div className="compare-divider" style={{ left: `${position}%` }} /><span className="compare-label source-label">原图</span><span className="compare-label output-label">压缩结果</span></div>}
            </TransformComponent>
          </>}
        </TransformWrapper>
        {hasOutput && mode === "slider" && <input className="compare-range" aria-label="对比位置" type="range" min="0" max="100" value={position} onChange={(event) => setPosition(Number(event.target.value))} />}
        <div className="preview-meta"><span>{image.relativePath}</span><span>{image.width && image.height ? `${image.width} × ${image.height}` : "尺寸未知"}</span><StatusPill status={image.status} /></div>
        <div className="compare-stats"><div><span>原图</span><strong>{formatBytes(image.sourceSize)}</strong></div><div><span>压缩结果</span><strong>{formatBytes(image.outputSize)}</strong></div><div><span>节省</span><strong>{image.savedRatio == null ? "-" : `${(image.savedRatio * 100).toFixed(1)}%`}</strong></div><div><span>完成时间</span><strong>{formatTime(image.compressedAt)}</strong></div></div>
      </section>
    </div>
  );
}

function UsagePanel({ usage, keys, refreshing, switching, onRefresh, onActivate }: { usage: TinyPngUsage; keys: TinyPngKeyListResponse; refreshing: boolean; switching: boolean; onRefresh: () => void; onActivate: (keyId: string) => void }) {
  const percentage = usage.used == null ? 0 : Math.min(100, (usage.used / usage.limit) * 100);
  const detail = !usage.configured
    ? "尚未配置 API Key"
    : usage.lastValidationStatus === "invalid"
      ? "当前 API Key 无效"
      : usage.lastValidationStatus === "unknown"
        ? "当前 API Key 尚未验证"
        : usage.status === "unknown"
          ? "尚未获取用量"
          : usage.status === "exhausted"
            ? "本月免费额度已用尽"
            : `剩余 ${usage.remaining} 次`;
  const visualStatus = usage.lastValidationStatus === "invalid" ? "exhausted" : usage.status;
  return <section className={`usage-panel usage-${visualStatus}`} aria-label="TinyPNG 本月额度"><header><div><span className="eyebrow">当前 API Key</span><select className="active-key-select" aria-label="切换当前 TinyPNG API Key" value={usage.keyId ?? ""} disabled={switching || keys.items.length === 0} onChange={(event) => onActivate(event.target.value)}><option value="" disabled>未配置</option>{keys.items.map((item) => <option value={item.id} key={item.id}>{item.name}{item.lastValidationStatus === "invalid" ? " · 无效" : item.remaining == null ? " · 额度未知" : ` · 剩余 ${item.remaining}`}</option>)}</select></div><button className="icon-button mini" onClick={onRefresh} disabled={refreshing || !usage.configured} title="刷新当前 Key 额度" aria-label="刷新当前 Key 额度">{refreshing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button></header><div className="usage-count"><span>本月额度</span><strong>{usage.used == null ? `- / ${usage.limit}` : `${usage.used} / ${usage.limit}`}</strong></div><div className="usage-track" role="progressbar" aria-label="TinyPNG 本月额度使用比例" aria-valuemin={0} aria-valuemax={usage.limit} aria-valuenow={usage.used ?? 0}><div style={{ width: `${percentage}%` }} /></div><footer><span>{detail}</span><span>{usage.stale ? "数据待刷新" : usage.updatedAt ? formatTime(usage.updatedAt) : ""}</span></footer></section>;
}

function JobPanel({ jobs, usage, keys, refreshingUsage, switchingKey, onRefreshUsage, onActivateKey }: { jobs: JobView[]; usage: TinyPngUsage; keys: TinyPngKeyListResponse; refreshingUsage: boolean; switchingKey: boolean; onRefreshUsage: () => void; onActivateKey: (keyId: string) => void }) {
  const queryClient = useQueryClient();
  const cancel = useMutation({ mutationFn: (id: string) => api(`/api/jobs/${id}/cancel`, { method: "POST", body: "{}" }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }) });
  const retry = useMutation({ mutationFn: (id: string) => api(`/api/job-items/${id}/retry`, { method: "POST", body: "{}" }), onSuccess: () => queryClient.invalidateQueries() });
  const reveal = useMutation({ mutationFn: (id: string) => api(`/api/jobs/${id}/reveal-output`, { method: "POST", body: "{}" }) });
  const latest = jobs[0];
  if (!latest) return <aside className="job-panel"><UsagePanel usage={usage} keys={keys} refreshing={refreshingUsage} switching={switchingKey} onRefresh={onRefreshUsage} onActivate={onActivateKey} /><div className="empty-jobs"><Sparkles size={22} /><strong>本次还没有压缩任务</strong><span>从待压缩列表中选择图片开始</span></div></aside>;
  const complete = latest.succeeded + latest.failed + latest.cancelled + latest.skipped;
  return (
    <aside className="job-panel">
      <UsagePanel usage={usage} keys={keys} refreshing={refreshingUsage} switching={switchingKey} onRefresh={onRefreshUsage} onActivate={onActivateKey} />
      <div className="job-heading"><div><span className="eyebrow">本批次</span><strong>{latest.status === "running" || latest.status === "queued" ? "正在处理" : "处理结果"}</strong></div><span>{complete}/{latest.total}</span></div>
      <div className="progress-track"><div style={{ width: `${latest.total ? (complete / latest.total) * 100 : 0}%` }} /></div>
      <div className="job-stats"><span className="success-dot">成功 {latest.succeeded}</span><span className="failure-dot">失败 {latest.failed}</span><span>节省 {formatBytes(Math.max(0, latest.inputBytes - latest.outputBytes))}</span></div>
      <div className="job-items">
        {latest.items.slice(0, 8).map((item) => <div className="job-item" key={item.id}><span className={`job-indicator job-${item.status}`}>{item.status === "running" ? <LoaderCircle className="spin" size={14} /> : item.status === "succeeded" ? <Check size={14} /> : item.status === "failed" ? <AlertCircle size={14} /> : <span />}</span><div><strong title={item.relativePath}>{item.filename}</strong><span>{item.status === "failed" ? item.errorMessage : item.status === "succeeded" ? `${formatBytes(item.inputSize)} → ${formatBytes(item.outputSize)}` : item.status === "running" ? "上传并压缩中" : "等待处理"}</span></div>{item.status === "failed" && <button className="secondary-button retry-button" onClick={() => retry.mutate(item.id)} disabled={retry.isPending || !usage.canCompress}><RotateCcw size={14} />重新压缩</button>}</div>)}
      </div>
      <div className="job-output" title={latest.outputDir}><Download size={14} /><span>{latest.outputDir}</span></div>
      <div className="job-controls">{["running", "queued"].includes(latest.status) && <button className="secondary-button" onClick={() => cancel.mutate(latest.id)}>取消剩余</button>}{latest.outputDir && <button className="secondary-button" onClick={() => reveal.mutate(latest.id)}><FolderOpen size={14} />打开结果</button>}</div>
    </aside>
  );
}

function Workspace({ settings, capabilities, usage, keys, refreshingUsage, switchingKey, keyActionError, onRefreshUsage, onActivateKey, onClearKeyActionError, onOpenSettings, onRequestShutdown }: { settings: SettingsResponse; capabilities: DesktopCapabilities; usage: TinyPngUsage; keys: TinyPngKeyListResponse; refreshingUsage: boolean; switchingKey: boolean; keyActionError: unknown; onRefreshUsage: () => void; onActivateKey: (keyId: string) => void; onClearKeyActionError: () => void; onOpenSettings: () => void; onRequestShutdown: () => void }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [format, setFormat] = useState("");
  const [sort, setSort] = useState("filename");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<ImageItem | null>(null);
  const [dragTarget, setDragTarget] = useState<"import" | "list" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const params = new URLSearchParams({ page: "1", pageSize: "5000", sort, order: sort === "filename" ? "asc" : "desc" });
  if (query) params.set("query", query);
  if (status) params.set("status", status);
  if (format) params.set("format", format);

  const imagesQuery = useQuery({ queryKey: ["images", query, status, format, sort], queryFn: () => api<ImageListResponse>(`/api/images?${params}`), refetchInterval: 4000 });
  const scanQuery = useQuery({ queryKey: ["scan"], queryFn: () => api<ScanState>("/api/scans/current"), refetchInterval: (query) => query.state.data?.status === "running" ? 500 : 5000 });
  const jobsQuery = useQuery({ queryKey: ["jobs"], queryFn: () => api<JobListResponse>("/api/jobs?page=1&pageSize=10"), refetchInterval: (query) => query.state.data?.items.some((job) => ["queued", "running"].includes(job.status)) ? 700 : 5000 });
  useEffect(() => {
    if (scanQuery.data?.status === "succeeded") void queryClient.invalidateQueries({ queryKey: ["images"] });
  }, [scanQuery.data?.status, scanQuery.data?.finishedAt, queryClient]);
  useEffect(() => {
    if (jobsQuery.data?.items.some((job) => ["queued", "running"].includes(job.status))) void queryClient.invalidateQueries({ queryKey: ["images"] });
  }, [jobsQuery.data, queryClient]);
  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (message) => {
      let event: LocalAppEvent;
      try {
        event = JSON.parse(message.data) as LocalAppEvent;
      } catch {
        return;
      }
      if (event.type === "image.detected" && event.entityId && event.imageStatus && defaultSelectedStatuses.has(event.imageStatus)) {
        setSelected((current) => new Set(current).add(event.entityId!));
      }
      if (event.type === "auto-job.created" && event.entityId) {
        setSelected((current) => {
          const next = new Set(current);
          next.delete(event.entityId!);
          return next;
        });
      }
      if (event.type === "auto-job.failed") {
        setError(new ApiError(event.errorCode ?? "AUTO_COMPRESS_FAILED", event.errorMessage ?? "自动压缩任务创建失败"));
      }
      if (["connected", "image.detected", "auto-job.created", "auto-job.failed", "job.changed", "images.changed"].includes(event.type)) {
        void queryClient.invalidateQueries({ queryKey: ["images"] });
      }
      if (["connected", "image.detected", "scan.changed"].includes(event.type)) void queryClient.invalidateQueries({ queryKey: ["scan"] });
      if (["connected", "auto-job.created", "job.changed"].includes(event.type)) void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      if (["connected", "settings.changed", "auto-job.created"].includes(event.type)) void queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (["connected", "tinypng.usage.changed", "tinypng.key.changed", "job.changed"].includes(event.type)) void queryClient.invalidateQueries({ queryKey: ["tinypng-usage"] });
      if (["connected", "tinypng.usage.changed", "tinypng.key.changed"].includes(event.type)) void queryClient.invalidateQueries({ queryKey: ["tinypng-keys"] });
    };
    return () => events.close();
  }, [queryClient]);

  const addPaths = useMutation({
    mutationFn: ({ paths, sourceLabel }: { paths: string[]; sourceLabel?: string }) => api<ScanState>("/api/scans", {
      method: "POST",
      body: JSON.stringify({ paths, recursive: true, mode: "incremental", ...(sourceLabel ? { sourceLabel } : {}) })
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["scan"] }),
    onError: setError
  });
  const scanFolder = useMutation({
    mutationFn: async () => {
      const selectedDirectory = await api<{ path: string | null }>("/api/platform/choose-directory", { method: "POST", body: JSON.stringify({ kind: "source", currentPath: "" }) });
      if (!selectedDirectory.path) return null;
      return api<ScanState>("/api/scans", { method: "POST", body: JSON.stringify({ paths: [selectedDirectory.path], recursive: true, mode: "incremental" }) });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["scan"] }),
    onError: setError
  });
  const stopScan = useMutation({ mutationFn: () => api<ScanState>("/api/scans/stop", { method: "POST", body: "{}" }), onSuccess: () => queryClient.invalidateQueries(), onError: setError });
  const removeImages = useMutation({
    mutationFn: (body: { ids: string[] } | { all: true }) => api<{ removed: number }>("/api/images", { method: "DELETE", body: JSON.stringify(body) }),
    onSuccess: async (_result, variables) => {
      setSelected((current) => {
        if ("all" in variables) return new Set();
        const next = new Set(current);
        variables.ids.forEach((id) => next.delete(id));
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["images"] });
    },
    onError: setError
  });
  const retryItem = useMutation({ mutationFn: (id: string) => api<JobView>(`/api/job-items/${id}/retry`, { method: "POST", body: "{}" }), onSuccess: () => queryClient.invalidateQueries(), onError: setError });
  const chooseOutput = useMutation({
    mutationFn: async () => {
      const selectedDirectory = await api<{ path: string | null }>("/api/platform/choose-directory", { method: "POST", body: JSON.stringify({ kind: "output", currentPath: settings.outputDir }) });
      if (!selectedDirectory.path) return null;
      const body: UpdateSettingsRequest = {
        outputMode: "custom",
        outputDir: selectedDirectory.path,
        recursive: true,
        compressionConcurrency: settings.compressionConcurrency,
        conflictStrategy: "suffix",
        createOutputDir: true
      };
      return api<SettingsResponse>("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
    onError: setError
  });
  const restoreDefaultOutput = useMutation({
    mutationFn: () => api<SettingsResponse>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        outputMode: "automatic",
        outputDir: settings.outputDir,
        recursive: true,
        compressionConcurrency: settings.compressionConcurrency,
        conflictStrategy: "suffix",
        createOutputDir: true
      } satisfies UpdateSettingsRequest)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
    onError: setError
  });
  const toggleAutoCompress = useMutation({
    mutationFn: (enabled: boolean) => api<SettingsResponse>("/api/settings/auto-compress", { method: "PATCH", body: JSON.stringify({ enabled }) }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (failure) => {
      setError(failure);
      if (failure instanceof ApiError && failure.code === "API_KEY_REQUIRED") onOpenSettings();
    }
  });
  const compress = useMutation<JobView, Error, boolean>({
    mutationFn: async (confirmRecompress) => api<JobView>("/api/jobs", { method: "POST", body: JSON.stringify({ clientRequestId: crypto.randomUUID(), imageIds: [...selected], confirmRecompress }) }),
    onSuccess: async () => { setSelected(new Set()); setError(null); await queryClient.invalidateQueries(); },
    onError: (failure) => {
      if (failure instanceof ApiError && failure.code === "RECOMPRESS_CONFIRMATION_REQUIRED" && window.confirm("选择中包含已压缩图片，确定重新压缩并生成新结果？")) compress.mutate(true);
      else setError(failure);
    }
  });
  const images = useMemo(() => imagesQuery.data?.items ?? [], [imagesQuery.data?.items]);
  const rowVirtualizer = useVirtualizer({ count: images.length, getScrollElement: () => tableScrollRef.current, estimateSize: () => 64, overscan: 8 });
  const selectable = images.filter((item) => compressibleStatuses.has(item.status));
  useEffect(() => {
    setSelected((current) => {
      const unavailable = images.filter((item) => !compressibleStatuses.has(item.status) && current.has(item.id));
      if (unavailable.length === 0) return current;
      const next = new Set(current);
      unavailable.forEach((item) => next.delete(item.id));
      return next;
    });
  }, [images]);
  const pageAllSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.id));
  const togglePage = () => setSelected((current) => { const next = new Set(current); if (pageAllSelected) selectable.forEach((item) => next.delete(item.id)); else selectable.forEach((item) => next.add(item.id)); return next; });
  const summary = imagesQuery.data?.summary;
  const listTotal = (summary?.pending ?? 0) + (summary?.queued ?? 0) + (summary?.compressing ?? 0) +
    (summary?.compressed ?? 0) + (summary?.source_changed ?? 0) + (summary?.output_missing ?? 0) +
    (summary?.failed ?? 0) + (summary?.unsupported ?? 0);
  const startCompression = () => {
    if (usage.remaining != null && selected.size > usage.remaining && !window.confirm(`当前免费额度只剩 ${usage.remaining} 次，所选图片可能无法全部完成。仍要继续吗？`)) return;
    compress.mutate(false);
  };
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
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragTarget(null);
    if (scanQuery.data?.status === "running") {
      setError(new Error("正在扫描文件夹，请等待当前扫描完成或先停止扫描。"));
      return;
    }
    if (!window.icaDesktop) {
      setError(new Error("当前运行模式不支持读取拖入文件，请使用“扫描文件夹”导入。"));
      return;
    }
    const paths = Array.from(event.dataTransfer.files).map((file) => window.icaDesktop!.pathForFile(file)).filter(Boolean);
    if (paths.length === 0) {
      setError(new Error("没有读取到可导入的文件或文件夹"));
      return;
    }
    const sourceLabel = paths.length === 1 ? event.dataTransfer.files[0]?.name : `拖入 ${paths.length} 个项目`;
    addPaths.mutate({ paths, ...(sourceLabel ? { sourceLabel } : {}) });
  };
  const handleDragEnter = (target: "import" | "list", event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragTarget(target);
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handleDragLeave = (target: "import" | "list", event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDragTarget((current) => current === target ? null : current);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><ImageIcon size={22} /></div><div><strong>图片压缩工作台</strong><span>TinyPNG 本地管理</span></div></div>
        <div className="top-actions"><label className="auto-compress-control"><span>自动压缩</span><input type="checkbox" role="switch" aria-label="识别图片后自动压缩" checked={settings.autoCompressOnImport} disabled={toggleAutoCompress.isPending} onChange={(event) => toggleAutoCompress.mutate(event.target.checked)} /><span className="switch-track" aria-hidden="true"><span /></span></label><button className="secondary-button" onClick={onOpenSettings} title="设置" aria-label="设置"><Settings size={16} />设置</button><button className="secondary-button exit-button" onClick={onRequestShutdown} title="退出应用" aria-label="退出应用"><Power size={16} />退出应用</button></div>
      </header>

      <main className="workspace-layout">
        <section className="library-section">
          {error !== null && <ErrorBanner error={error} onClose={() => setError(null)} />}
          {error === null && keyActionError !== null && <ErrorBanner error={keyActionError} onClose={onClearKeyActionError} />}
          {usage.status === "exhausted" && <div className="quota-alert" role="alert"><AlertCircle size={18} /><div><strong>{usage.keyName ?? "当前 Key"} 本月免费额度已用尽</strong><span>切换到其他可用 Key 后，可手动重新压缩失败项。</span></div><button className="secondary-button" onClick={onOpenSettings}><KeyRound size={15} />切换 Key</button></div>}
          <div
            className={`import-zone ${dragTarget === "import" ? "drag-active" : ""}`}
            onDragEnter={(event) => handleDragEnter("import", event)}
            onDragOver={handleDragOver}
            onDragLeave={(event) => handleDragLeave("import", event)}
            onDrop={handleDrop}
          >
            <div className="import-zone-copy"><div className="import-icon"><Upload size={21} /></div><div><strong>拖入图片或文件夹</strong><span>支持 PNG、JPEG、WebP、AVIF</span></div></div>
            <div className="import-actions"><button className="primary-button" onClick={() => scanFolder.mutate()} disabled={scanFolder.isPending || scanQuery.data?.status === "running"}>{scanFolder.isPending ? <LoaderCircle className="spin" size={16} /> : <FolderSearch size={16} />}扫描文件夹</button>{(imagesQuery.data?.total ?? 0) > 0 && <button className="secondary-button" onClick={() => window.confirm("确定清空本次待压缩列表？原文件不会被删除。") && removeImages.mutate({ all: true })} disabled={removeImages.isPending}>清空列表</button>}</div>
          </div>
          <div className="output-location"><div className="output-location-label"><Download size={16} /><span>保存到</span></div><strong title={settings.sessionOutputDir ?? settings.outputDir}>{settings.sessionOutputDir ?? settings.outputDir}</strong><span className="output-hint">{settings.outputMode === "custom" ? "直接保存到此目录" : settings.sessionOutputDir ? "本次应用打开期间共用此目录" : "首次压缩时创建时间文件夹"}</span>{settings.outputMode === "custom" && <button className="text-button" onClick={() => restoreDefaultOutput.mutate()} disabled={restoreDefaultOutput.isPending}>恢复默认</button>}<button className="secondary-button" onClick={() => chooseOutput.mutate()} disabled={chooseOutput.isPending || restoreDefaultOutput.isPending}>{chooseOutput.isPending ? <LoaderCircle className="spin" size={15} /> : <FolderOpen size={15} />}更改</button></div>
          {scanQuery.data?.status === "running" && <div className="scan-progress" role="status"><LoaderCircle className="spin" size={17} /><div><strong>正在扫描 {scanQuery.data.sourceLabel}</strong><span>已发现 {scanQuery.data.discoveredCount}，已处理 {scanQuery.data.processedCount}{scanQuery.data.warningCount > 0 ? `，跳过 ${scanQuery.data.warningCount}` : ""}</span></div><button className="secondary-button" onClick={() => stopScan.mutate()} disabled={stopScan.isPending}>{stopScan.isPending ? <LoaderCircle className="spin" size={15} /> : <X size={15} />}停止扫描</button></div>}
          {scanQuery.data?.status === "stopped" && <div className="scan-stopped"><Check size={15} /><span>扫描已停止，已经加入的图片保留在列表中。</span></div>}
          <div className="summary-strip">
            <div className="summary-main"><span className="eyebrow">待压缩列表</span><strong>{imagesQuery.data?.total ?? 0}<small> 张图片</small></strong></div>
            <div className="summary-cell"><span>待处理</span><strong>{(summary?.pending ?? 0) + (summary?.source_changed ?? 0) + (summary?.output_missing ?? 0) + (summary?.failed ?? 0)}</strong></div>
            <div className="summary-cell success"><span>已压缩</span><strong>{summary?.compressed ?? 0}</strong></div>
            <div className="summary-cell"><span>原图大小</span><strong>{formatBytes(summary?.sourceBytes ?? 0)}</strong></div>
            <div className="summary-cell saved"><span>累计节省</span><strong>{formatBytes(summary?.savedBytes ?? 0)}</strong></div>
            <div className="scan-state"><ImagePlus size={16} /><span>本次会话</span></div>
          </div>

          <div className="list-toolbar">
            <div className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名或路径" /></div>
            <select aria-label="状态筛选" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
            <select aria-label="格式筛选" value={format} onChange={(event) => setFormat(event.target.value)}><option value="">全部格式</option><option value="png">PNG</option><option value="jpg,jpeg">JPEG</option><option value="webp">WebP</option><option value="avif">AVIF</option></select>
            <select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="filename">文件名</option><option value="sourceSize">文件大小</option><option value="sourceMtime">更新时间</option><option value="compressedAt">压缩时间</option><option value="savedRatio">节省比例</option></select>
          </div>

          {(selected.size > 0 || selectable.length > 0) && <div className="selection-bar"><span>已选择 <strong>{selected.size}</strong> 张</span><button className="text-button" onClick={() => void selectAllFiltered()}>选择全部筛选结果</button>{selected.size > 0 && <><button className="text-button" onClick={() => setSelected(new Set())}>取消选择</button><button className="danger-text-button" onClick={() => removeImages.mutate({ ids: [...selected] })} disabled={removeImages.isPending}><Trash2 size={14} />移出列表</button></>}<button className="primary-button" onClick={startCompression} disabled={selected.size === 0 || compress.isPending || !usage.canCompress}>{compress.isPending ? <LoaderCircle className="spin" size={16} /> : !usage.canCompress ? <AlertCircle size={16} /> : <Sparkles size={16} />}{!usage.configured ? "先配置 API Key" : usage.status === "exhausted" ? "切换 API Key" : !usage.canCompress ? "当前 Key 不可用" : "开始压缩"}</button></div>}

          <div
            className={`table-wrap virtual-table-wrap ${dragTarget === "list" ? "drag-active" : ""}`}
            ref={tableScrollRef}
            onDragEnter={(event) => handleDragEnter("list", event)}
            onDragOver={handleDragOver}
            onDragLeave={(event) => handleDragLeave("list", event)}
            onDrop={handleDrop}
          >
            <table className="image-table">
              <thead><tr><th className="select-column"><input type="checkbox" checked={pageAllSelected} onChange={togglePage} aria-label="选择当前页可压缩图片" /></th><th>图片</th><th>状态</th><th>原图</th><th>压缩结果</th><th>节省</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                {imagesQuery.isLoading && <tr><td colSpan={8} className="empty-table"><LoaderCircle className="spin" size={24} />正在读取图片</td></tr>}
                {!imagesQuery.isLoading && images.length === 0 && <tr><td colSpan={8} className="empty-table"><ImageIcon size={28} /><strong>待压缩列表为空</strong><span>拖入图片，或扫描电脑中的文件夹</span></td></tr>}
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                  const image = images[virtualRow.index]!;
                  const canSelect = compressibleStatuses.has(image.status);
                  const canRemove = !["queued", "compressing"].includes(image.status);
                  return <tr key={image.id} data-index={virtualRow.index} style={{ transform: `translateY(${virtualRow.start}px)` }} className={selected.has(image.id) ? "selected-row" : ""}><td><input type="checkbox" aria-label={`选择 ${image.filename}`} disabled={!canSelect} checked={selected.has(image.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(image.id)) next.delete(image.id); else next.add(image.id); return next; })} /></td><td><button className="image-cell" onClick={() => setPreview(image)}><img src={`/api/images/${image.id}/thumbnail`} alt="" loading="lazy" /><span><strong title={image.filename}>{image.filename}</strong><small title={image.sourceDirectory}>{image.relativePath}</small></span></button></td><td><StatusPill status={image.status} />{image.errorMessage && <span className="row-error" title={image.errorMessage}><AlertCircle size={14} /></span>}</td><td><strong>{formatBytes(image.sourceSize)}</strong><small>{image.width && image.height ? `${image.width} × ${image.height}` : image.extension.toUpperCase()}</small></td><td><strong>{formatBytes(image.outputSize)}</strong><small>{formatTime(image.compressedAt)}</small></td><td>{image.savedRatio == null ? <span className="muted">-</span> : <strong className="saved-value">-{(image.savedRatio * 100).toFixed(1)}%</strong>}</td><td><span className="muted">{formatTime(image.sourceMtime)}</span></td><td><div className="row-actions">{image.retryItemId && <button className="secondary-button retry-button" onClick={() => retryItem.mutate(image.retryItemId!)} disabled={retryItem.isPending || !usage.canCompress}><RotateCcw size={13} />重新压缩</button>}<button className="icon-button mini" onClick={() => removeImages.mutate({ ids: [image.id] })} disabled={!canRemove || removeImages.isPending} title="移出待压缩列表"><Trash2 size={14} /></button></div></td></tr>;
                })}
              </tbody>
            </table>
          </div>
          <footer className="list-progress-summary" aria-label="当前待压缩列表进度">
            <div className="list-progress-stat stat-total"><span>总数</span><strong>{listTotal}</strong></div>
            <div className="list-progress-stat stat-queued"><span>排队中</span><strong>{summary?.queued ?? 0}</strong></div>
            <div className="list-progress-stat stat-compressing"><span>压缩中</span><strong>{summary?.compressing ?? 0}</strong></div>
            <div className="list-progress-stat stat-success"><span>成功</span><strong>{summary?.compressed ?? 0}</strong></div>
            <div className="list-progress-stat stat-failed"><span>失败</span><strong>{summary?.failed ?? 0}</strong></div>
          </footer>
        </section>
        <JobPanel jobs={jobsQuery.data?.items ?? []} usage={usage} keys={keys} refreshingUsage={refreshingUsage} switchingKey={switchingKey} onRefreshUsage={onRefreshUsage} onActivateKey={onActivateKey} />
      </main>
      {preview && <PreviewDialog image={preview} capabilities={capabilities} onClose={() => setPreview(null)} />}
    </div>
  );
}

export function App() {
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/api/settings") });
  const capabilitiesQuery = useQuery({ queryKey: ["capabilities"], queryFn: () => api<DesktopCapabilities>("/api/platform/capabilities"), staleTime: Infinity });
  const keysQuery = useQuery({ queryKey: ["tinypng-keys"], queryFn: () => api<TinyPngKeyListResponse>("/api/tinypng/keys") });
  const usageQuery = useQuery({ queryKey: ["tinypng-usage"], queryFn: () => api<TinyPngUsage>("/api/tinypng/usage"), refetchInterval: 60_000 });
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shutdownStatus, setShutdownStatus] = useState<ApplicationStatus | null>(null);
  const [shutdownPhase, setShutdownPhase] = useState<"idle" | "stopping" | "stopped">("idle");
  const [keyActionError, setKeyActionError] = useState<unknown>(null);
  const usageRefresh = useMutation({
    mutationFn: () => api<TinyPngUsage>("/api/tinypng/usage/refresh", { method: "POST", body: "{}" }),
    onMutate: () => setKeyActionError(null),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tinypng-usage"] }),
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] })
      ]);
    },
    onError: setKeyActionError
  });
  const keyRefresh = useMutation({
    mutationFn: (keyId: string) => api<TinyPngUsage>(`/api/tinypng/keys/${keyId}/refresh`, { method: "POST", body: "{}" }),
    onMutate: () => setKeyActionError(null),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tinypng-keys"] }),
        queryClient.invalidateQueries({ queryKey: ["tinypng-usage"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] })
      ]);
    },
    onError: setKeyActionError
  });
  const activateKey = useMutation({
    mutationFn: (keyId: string) => api<TinyPngKeyView>("/api/tinypng/keys/active", { method: "PUT", body: JSON.stringify({ keyId }) }),
    onMutate: () => setKeyActionError(null),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tinypng-keys"] }),
        queryClient.invalidateQueries({ queryKey: ["tinypng-usage"] }),
        queryClient.invalidateQueries({ queryKey: ["settings"] })
      ]);
      if (result.stale) keyRefresh.mutate(result.id);
    },
    onError: setKeyActionError
  });
  const autoRefreshKey = useRef<string | null>(null);
  useEffect(() => {
    if (!usageQuery.data?.configured || !usageQuery.data.stale) return;
    const key = `${usageQuery.data.used ?? "unknown"}:${usageQuery.data.updatedAt ?? "never"}`;
    if (autoRefreshKey.current === key) return;
    autoRefreshKey.current = key;
    usageRefresh.mutate();
  }, [usageQuery.data, usageRefresh]);
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
  if (settingsQuery.isLoading || capabilitiesQuery.isLoading || keysQuery.isLoading) return <div className="full-loading"><div className="brand-mark"><ImageIcon size={24} /></div><LoaderCircle className="spin" size={22} /><span>正在启动本地工作台</span></div>;
  if (settingsQuery.error || !settingsQuery.data) return <div className="fatal-state"><AlertCircle size={30} /><h1>无法连接本地服务</h1><p>{settingsQuery.error instanceof Error ? settingsQuery.error.message : "请重新启动应用"}</p></div>;
  const keys = keysQuery.data ?? { items: [], activeKeyId: null };
  const usage = usageQuery.data ?? { keyId: settingsQuery.data.apiKey.activeKeyId, keyName: settingsQuery.data.apiKey.activeKeyName, configured: settingsQuery.data.apiKey.configured, used: null, limit: TINYPNG_FREE_MONTHLY_LIMIT, remaining: null, status: "unknown", canCompress: settingsQuery.data.apiKey.canCompress, lastValidationStatus: settingsQuery.data.apiKey.lastValidationStatus, updatedAt: null, stale: true, source: null };
  return <>
    {!settingsQuery.data.configured
      ? <SettingsPanel settings={settingsQuery.data} capabilities={capabilitiesQuery.data!} keys={keys} refreshingKeyId={keyRefresh.isPending ? keyRefresh.variables ?? null : null} keyActionError={keyActionError} onRefreshKey={(keyId) => keyRefresh.mutate(keyId)} onClearKeyActionError={() => setKeyActionError(null)} onRequestShutdown={requestShutdown} />
      : <><Workspace settings={settingsQuery.data} capabilities={capabilitiesQuery.data!} usage={usage} keys={keys} refreshingUsage={usageRefresh.isPending} switchingKey={activateKey.isPending} keyActionError={keyActionError} onRefreshUsage={() => usageRefresh.mutate()} onActivateKey={(keyId) => activateKey.mutate(keyId)} onClearKeyActionError={() => setKeyActionError(null)} onOpenSettings={() => setSettingsOpen(true)} onRequestShutdown={requestShutdown} />{settingsOpen && <SettingsPanel settings={settingsQuery.data} capabilities={capabilitiesQuery.data!} keys={keys} refreshingKeyId={keyRefresh.isPending ? keyRefresh.variables ?? null : null} keyActionError={keyActionError} onRefreshKey={(keyId) => keyRefresh.mutate(keyId)} onClearKeyActionError={() => setKeyActionError(null)} onClose={() => setSettingsOpen(false)} onRequestShutdown={requestShutdown} />}</>}
    {shutdownStatus && <ShutdownDialog
      status={shutdownStatus}
      pending={shutdownMutation.isPending}
      error={shutdownMutation.error}
      onCancel={() => setShutdownStatus(null)}
      onConfirm={() => shutdownMutation.mutate(shutdownStatus.activeJobs.queued + shutdownStatus.activeJobs.running > 0)}
    />}
  </>;
}
