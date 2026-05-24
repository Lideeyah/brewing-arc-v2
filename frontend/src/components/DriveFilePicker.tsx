import { useState, useEffect, useRef } from 'react'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
const SCOPE     = 'https://www.googleapis.com/auth/drive.readonly'

// ── Types ─────────────────────────────────────────────────────────────────────

interface DriveFile {
  id:       string
  name:     string
  mimeType: string
}

interface SelectedFile {
  id:      string
  name:    string
  content: string
}

export interface DriveFilePayload {
  name:    string
  content: string
}

interface Props {
  onFilesChange: (files: DriveFilePayload[]) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Google Workspace types need the /export endpoint; everything else uses ?alt=media
const EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/pdf':                          'text/plain',
}

const TYPE_LABEL: Record<string, string> = {
  'application/vnd.google-apps.document':     'Doc',
  'application/vnd.google-apps.spreadsheet':  'Sheet',
  'application/vnd.google-apps.presentation': 'Slides',
  'application/pdf':                          'PDF',
  'text/plain':                               'TXT',
  'text/csv':                                 'CSV',
  'application/json':                         'JSON',
}

function typeLabel(mimeType: string) {
  return TYPE_LABEL[mimeType] ?? 'File'
}

// Anything that can't be read as text — skip silently
const UNSUPPORTED_PREFIXES = ['image/', 'video/', 'audio/']
function isSupported(mimeType: string) {
  if (UNSUPPORTED_PREFIXES.some(p => mimeType.startsWith(p))) return false
  if (mimeType === 'application/vnd.google-apps.folder') return false
  return true
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DriveFilePicker({ onFilesChange }: Props) {
  const [gisReady,    setGisReady]    = useState(false)
  const [token,       setToken]       = useState<string | null>(null)
  const [files,       setFiles]       = useState<DriveFile[]>([])
  const [selected,    setSelected]    = useState<SelectedFile[]>([])
  const [fetchingId,  setFetchingId]  = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenClientRef = useRef<{ requestAccessToken: (o?: { prompt?: string }) => void } | null>(null)

  // Load Google Identity Services script once
  useEffect(() => {
    if (!CLIENT_ID) return
    if (document.getElementById('gsi-script')) { setGisReady(true); return }
    const s = document.createElement('script')
    s.id    = 'gsi-script'
    s.src   = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => setGisReady(true)
    document.head.appendChild(s)
  }, [])

  // Init OAuth token client once GIS is loaded
  useEffect(() => {
    if (!gisReady || !CLIENT_ID) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tokenClientRef.current = (window as any).google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope:     SCOPE,
      callback:  async (resp: { access_token?: string; error?: string }) => {
        if (resp.error || !resp.access_token) {
          setError('Sign-in cancelled or failed')
          return
        }
        setToken(resp.access_token)
        await loadFileList(resp.access_token)
      },
    })
  }, [gisReady])

  const connect = () => {
    setError(null)
    tokenClientRef.current?.requestAccessToken({ prompt: '' })
  }

  const loadFileList = async (accessToken: string) => {
    setListLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        q:        "mimeType!='application/vnd.google-apps.folder' and trashed=false",
        orderBy:  'modifiedTime desc',
        pageSize: '25',
        fields:   'files(id,name,mimeType)',
      })
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error(`Drive API ${res.status}`)
      const data = await res.json()
      setFiles((data.files ?? []).filter((f: DriveFile) => isSupported(f.mimeType)))
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to list Drive files')
    } finally {
      setListLoading(false)
    }
  }

  const fetchContent = async (file: DriveFile, accessToken: string): Promise<string> => {
    const exportMime = EXPORT_MIME[file.mimeType]
    const url = exportMime
      ? `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`Could not read "${file.name}" (${res.status})`)
    const text = await res.text()
    const CAP  = 6000
    return text.length > CAP
      ? `${text.slice(0, CAP)}\n\n[File truncated — ${text.length.toLocaleString()} chars total]`
      : text
  }

  const toggleFile = async (file: DriveFile) => {
    const alreadyOn = selected.find(s => s.id === file.id)

    if (alreadyOn) {
      const next = selected.filter(s => s.id !== file.id)
      setSelected(next)
      onFilesChange(next.map(s => ({ name: s.name, content: s.content })))
      return
    }

    setFetchingId(file.id)
    setError(null)
    try {
      const content = await fetchContent(file, token!)
      const next    = [...selected, { id: file.id, name: file.name, content }]
      setSelected(next)
      onFilesChange(next.map(s => ({ name: s.name, content: s.content })))
    } catch (e: unknown) {
      setError((e as Error).message ?? `Failed to load ${file.name}`)
    } finally {
      setFetchingId(null)
    }
  }

  // ── Render: no client ID configured ──────────────────────────────────────
  if (!CLIENT_ID) {
    return (
      <div className="border border-arc-border rounded-lg px-4 py-3 bg-arc-surface">
        <span className="font-mono text-[11px] text-arc-muted">
          Set <code className="text-arc-amber">VITE_GOOGLE_CLIENT_ID</code> to enable Drive file attachment
        </span>
      </div>
    )
  }

  // ── Render: not yet connected ─────────────────────────────────────────────
  if (!token) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={connect}
          disabled={!gisReady}
          className="flex items-center gap-2 border border-arc-border rounded-lg px-4 py-2.5 font-mono text-xs text-arc-sub hover:border-arc-green hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed w-fit"
        >
          <DriveIcon />
          Connect Google Drive
        </button>
        {error && <span className="font-mono text-[10px] text-red-400">{error}</span>}
      </div>
    )
  }

  // ── Render: connected, show file list ─────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DriveIcon className="text-arc-green" />
          <span className="font-mono text-[11px] text-arc-green font-semibold">Google Drive connected</span>
          {selected.length > 0 && (
            <span className="font-mono text-[10px] text-arc-green border border-arc-green/30 rounded px-1.5 py-0.5">
              {selected.length} file{selected.length !== 1 ? 's' : ''} selected
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => loadFileList(token!)}
          disabled={listLoading}
          className="font-mono text-[10px] text-arc-muted hover:text-white transition-colors"
        >
          {listLoading ? '⟳' : '↺ Refresh'}
        </button>
      </div>

      {/* File list */}
      <div className="border border-arc-border rounded-lg overflow-hidden">
        {listLoading ? (
          <div className="px-4 py-6 text-center font-mono text-xs text-arc-muted">Loading Drive files…</div>
        ) : files.length === 0 ? (
          <div className="px-4 py-6 text-center font-mono text-xs text-arc-muted">No compatible files found</div>
        ) : (
          <div className="divide-y divide-arc-border max-h-52 overflow-y-auto">
            {files.map(file => {
              const isSelected = selected.some(s => s.id === file.id)
              const isFetching = fetchingId === file.id
              const isDisabled = isFetching || (!!fetchingId && !isSelected)

              return (
                <label
                  key={file.id}
                  className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${
                    isDisabled ? 'cursor-wait opacity-60' : 'cursor-pointer'
                  } ${isSelected ? 'bg-arc-green/5' : 'hover:bg-arc-surface'}`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isDisabled}
                    onChange={() => !isDisabled && toggleFile(file)}
                    className="accent-arc-green flex-shrink-0"
                  />
                  <span className="font-mono text-[9px] text-arc-muted border border-arc-border rounded px-1.5 py-0.5 flex-shrink-0 uppercase tracking-wide">
                    {typeLabel(file.mimeType)}
                  </span>
                  <span className="font-mono text-[11px] text-white flex-1 truncate">{file.name}</span>
                  {isFetching && <span className="font-mono text-[10px] text-arc-amber flex-shrink-0 animate-pulse">Reading…</span>}
                  {isSelected && !isFetching && <span className="font-mono text-[10px] text-arc-green flex-shrink-0">✓</span>}
                </label>
              )
            })}
          </div>
        )}
      </div>

      {/* Selected summary */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selected.map(s => (
            <div key={s.id} className="flex items-center gap-1.5 border border-arc-green/20 rounded-full px-2.5 py-1 bg-arc-green/5">
              <span className="font-mono text-[10px] text-arc-green truncate max-w-[160px]">{s.name}</span>
              <button
                type="button"
                onClick={() => toggleFile({ id: s.id, name: s.name, mimeType: '' })}
                className="text-arc-muted hover:text-white transition-colors font-mono text-[10px]"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <span className="font-mono text-[10px] text-red-400">{error}</span>}
    </div>
  )
}

// ── Google Drive icon ─────────────────────────────────────────────────────────

function DriveIcon({ className = 'text-arc-sub' }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 ${className}`} viewBox="0 0 87.3 78" fill="currentColor">
      <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0a15.92 15.92 0 0 0 2.1 8zM43.65 25 29.9 1.2a9.23 9.23 0 0 0-3.3 3.3L2.1 45.4A15.6 15.6 0 0 0 0 53h27.6zM73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25A15.92 15.92 0 0 0 87.3 53H59.7L73.55 76.8zM43.65 25 57.4 1.2C56.05.45 54.5 0 52.85 0H34.45c-1.65 0-3.2.45-4.55 1.2zM59.7 53H27.6L13.85 76.8c1.35.75 2.9 1.2 4.55 1.2h50.5c1.65 0 3.2-.45 4.55-1.2zM59.7 53l13.85-24H87.3a15.6 15.6 0 0 0-2.1-7.6L73.55 3.2a9.23 9.23 0 0 0-3.3-3.3L43.65 25z" />
    </svg>
  )
}
