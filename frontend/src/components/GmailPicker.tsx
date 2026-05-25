import { useState, useEffect, useRef } from 'react'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
const SCOPE     = 'https://www.googleapis.com/auth/gmail.readonly'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GmailThread {
  id:      string
  snippet: string
  subject: string
}

export interface GmailThreadPayload {
  subject: string
  content: string
}

interface Props {
  onThreadsChange: (threads: GmailThreadPayload[]) => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodeBase64(str: string): string {
  try {
    return decodeURIComponent(
      atob(str.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
  } catch {
    return ''
  }
}

function extractBody(payload: Record<string, unknown>): string {
  // Try direct body first
  const body = payload.body as { data?: string } | undefined
  if (body?.data) return decodeBase64(body.data)

  // Walk parts
  const parts = payload.parts as Array<Record<string, unknown>> | undefined
  if (!parts) return ''

  for (const part of parts) {
    const mimeType = part.mimeType as string
    if (mimeType === 'text/plain') {
      const partBody = part.body as { data?: string } | undefined
      if (partBody?.data) return decodeBase64(partBody.data)
    }
  }
  // Recurse into multipart
  for (const part of parts) {
    const nested = extractBody(part)
    if (nested) return nested
  }
  return ''
}

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function GmailPicker({ onThreadsChange }: Props) {
  const [gisReady,     setGisReady]     = useState(false)
  const [token,        setToken]        = useState<string | null>(() => localStorage.getItem('gmail_token'))
  const [threads,      setThreads]      = useState<GmailThread[]>([])
  const [selected,     setSelected]     = useState<Map<string, GmailThreadPayload>>(new Map())
  const [fetchingId,   setFetchingId]   = useState<string | null>(null)
  const [listLoading,  setListLoading]  = useState(false)
  const [selectingAll, setSelectingAll] = useState(false)
  const [error,        setError]        = useState<string | null>(null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenClientRef = useRef<{ requestAccessToken: (o?: { prompt?: string }) => void } | null>(null)

  // Load GIS script once
  useEffect(() => {
    if (!CLIENT_ID) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).google?.accounts) { setGisReady(true); return }
    const existing = document.getElementById('gsi-script')
    if (existing) { existing.addEventListener('load', () => setGisReady(true)); return }
    const s = document.createElement('script')
    s.id    = 'gsi-script'
    s.src   = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => setGisReady(true)
    document.head.appendChild(s)
  }, [])

  // Init token client once GIS ready
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
        localStorage.setItem('gmail_token', resp.access_token)
        setToken(resp.access_token)
        await loadThreadList(resp.access_token)
      },
    })
  }, [gisReady])

  // Auto-load threads when token is restored from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('gmail_token')
    if (saved && threads.length === 0) {
      loadThreadList(saved).catch(() => {
        localStorage.removeItem('gmail_token')
        setToken(null)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const connect = () => {
    setError(null)
    tokenClientRef.current?.requestAccessToken({ prompt: '' })
  }

  const loadThreadList = async (accessToken: string) => {
    setListLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        maxResults: '30',
        q:          'in:inbox',
      })
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem('gmail_token')
          setToken(null)
          tokenClientRef.current?.requestAccessToken({ prompt: '' })
        }
        throw new Error(`Gmail API ${res.status}`)
      }
      const data = await res.json()
      const rawThreads = data.threads ?? []

      // Fetch snippet + subject for each thread (lightweight)
      const enriched: GmailThread[] = await Promise.all(
        rawThreads.slice(0, 20).map(async (t: { id: string }) => {
          try {
            const r = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            )
            if (!r.ok) return { id: t.id, snippet: '', subject: t.id }
            const d = await r.json()
            const msgs = d.messages ?? []
            const firstMsg = msgs[0] ?? {}
            const headers = firstMsg.payload?.headers ?? []
            return {
              id:      t.id,
              snippet: firstMsg.snippet ?? '',
              subject: getHeader(headers, 'Subject') || '(no subject)',
            }
          } catch {
            return { id: t.id, snippet: '', subject: t.id }
          }
        })
      )
      setThreads(enriched)
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to load Gmail threads')
    } finally {
      setListLoading(false)
    }
  }

  const fetchThreadContent = async (threadId: string, accessToken: string): Promise<string> => {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (!res.ok) throw new Error(`Could not read thread (${res.status})`)
    const data = await res.json()
    const messages = data.messages ?? []

    const parts = messages.slice(0, 5).map((msg: Record<string, unknown>) => {
      const headers = (msg.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }> ?? []
      const from    = getHeader(headers, 'From')
      const date    = getHeader(headers, 'Date')
      const body    = extractBody(msg.payload as Record<string, unknown>)
      const CAP     = 800
      const trimmed = body.length > CAP ? body.slice(0, CAP) + '…' : body
      return `From: ${from}\nDate: ${date}\n\n${trimmed}`
    })
    return parts.join('\n\n---\n\n')
  }

  const allSelected = threads.length > 0 && threads.every(t => selected.has(t.id))

  const toggleSelectAll = async () => {
    if (allSelected) {
      setSelected(new Map())
      onThreadsChange([])
      return
    }
    const unselected = threads.filter(t => !selected.has(t.id))
    setSelectingAll(true)
    setError(null)
    try {
      const results = await Promise.all(
        unselected.map(async t => {
          try {
            const content = await fetchThreadContent(t.id, token!)
            return { id: t.id, payload: { subject: t.subject, content } }
          } catch {
            return null
          }
        })
      )
      const next = new Map(selected)
      for (const r of results) {
        if (r) next.set(r.id, r.payload)
      }
      setSelected(next)
      onThreadsChange(Array.from(next.values()))
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to select all threads')
    } finally {
      setSelectingAll(false)
    }
  }

  const toggleThread = async (thread: GmailThread) => {
    if (selected.has(thread.id)) {
      const next = new Map(selected)
      next.delete(thread.id)
      setSelected(next)
      onThreadsChange(Array.from(next.values()))
      return
    }

    setFetchingId(thread.id)
    setError(null)
    try {
      const content = await fetchThreadContent(thread.id, token!)
      const next = new Map(selected)
      next.set(thread.id, { subject: thread.subject, content })
      setSelected(next)
      onThreadsChange(Array.from(next.values()))
    } catch (e: unknown) {
      setError((e as Error).message ?? `Failed to load thread`)
    } finally {
      setFetchingId(null)
    }
  }

  // ── No client ID ─────────────────────────────────────────────────────────
  if (!CLIENT_ID) {
    return (
      <div className="border border-arc-border rounded-lg px-4 py-3 bg-arc-surface">
        <span className="font-mono text-[11px] text-arc-muted">
          Set <code className="text-arc-amber">VITE_GOOGLE_CLIENT_ID</code> to enable Gmail
        </span>
      </div>
    )
  }

  // ── Not connected ─────────────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={connect}
          disabled={!gisReady}
          className="flex items-center gap-2 border border-arc-border rounded-lg px-4 py-2.5 font-mono text-xs text-arc-sub hover:border-arc-green hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed w-fit"
        >
          <GmailIcon />
          Connect Gmail
        </button>
        {error && <span className="font-mono text-[10px] text-red-400">{error}</span>}
      </div>
    )
  }

  // ── Connected ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GmailIcon className="text-arc-green" />
          <span className="font-mono text-[11px] text-arc-green font-semibold">Gmail connected</span>
          {selected.size > 0 && (
            <span className="font-mono text-[10px] text-arc-green border border-arc-green/30 rounded px-1.5 py-0.5">
              {selected.size} thread{selected.size !== 1 ? 's' : ''} selected
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => loadThreadList(token!)}
          disabled={listLoading}
          className="font-mono text-[10px] text-arc-muted hover:text-white transition-colors"
        >
          {listLoading ? '⟳' : '↺ Refresh'}
        </button>
      </div>

      {/* Thread list */}
      <div className="border border-arc-border rounded-lg overflow-hidden">
        {listLoading ? (
          <div className="px-4 py-6 text-center font-mono text-xs text-arc-muted">Loading threads…</div>
        ) : threads.length === 0 ? (
          <div className="px-4 py-6 text-center font-mono text-xs text-arc-muted">No threads found</div>
        ) : (
          <>
            {/* Select all row */}
            <label className="flex items-center gap-3 px-4 py-2 bg-arc-surface border-b border-arc-border cursor-pointer hover:bg-black/20 transition-colors">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={selectingAll || !!fetchingId}
                onChange={toggleSelectAll}
                className="accent-arc-green flex-shrink-0"
              />
              <span className="font-mono text-[10px] text-arc-sub flex-1">
                {allSelected ? 'Deselect all' : 'Select all'}
              </span>
              {selectingAll && <span className="font-mono text-[10px] text-arc-amber animate-pulse">Reading all…</span>}
            </label>
          <div className="divide-y divide-arc-border max-h-52 overflow-y-auto">
            {threads.map(thread => {
              const isSelected  = selected.has(thread.id)
              const isFetching  = fetchingId === thread.id
              const isDisabled  = selectingAll || isFetching || (!!fetchingId && !isSelected)

              return (
                <label
                  key={thread.id}
                  className={`flex items-start gap-3 px-4 py-2.5 transition-colors ${
                    isDisabled ? 'cursor-wait opacity-60' : 'cursor-pointer'
                  } ${isSelected ? 'bg-arc-green/5' : 'hover:bg-arc-surface'}`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isDisabled}
                    onChange={() => !isDisabled && toggleThread(thread)}
                    className="accent-arc-green flex-shrink-0 mt-0.5"
                  />
                  <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <span className="font-mono text-[11px] text-white truncate">{thread.subject}</span>
                    <span className="font-mono text-[10px] text-arc-muted truncate">{thread.snippet}</span>
                  </div>
                  {isFetching  && <span className="font-mono text-[10px] text-arc-amber flex-shrink-0 animate-pulse">Reading…</span>}
                  {isSelected && !isFetching && <span className="font-mono text-[10px] text-arc-green flex-shrink-0">✓</span>}
                </label>
              )
            })}
          </div>
          </>
        )}
      </div>

      {/* Selected chips */}
      {selected.size > 0 && (
        <div className="flex flex-wrap gap-2">
          {Array.from(selected.entries()).map(([id, t]) => (
            <div key={id} className="flex items-center gap-1.5 border border-arc-green/20 rounded-full px-2.5 py-1 bg-arc-green/5">
              <span className="font-mono text-[10px] text-arc-green truncate max-w-[160px]">{t.subject}</span>
              <button
                type="button"
                onClick={() => toggleThread({ id, snippet: '', subject: t.subject })}
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

// ── Gmail icon ────────────────────────────────────────────────────────────────

function GmailIcon({ className = 'text-arc-sub' }: { className?: string }) {
  return (
    <svg className={`w-4 h-4 ${className}`} viewBox="0 0 24 24" fill="currentColor">
      <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
    </svg>
  )
}
