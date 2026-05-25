import { useState, useEffect, useRef } from 'react'
import type { DriveFilePayload } from './DriveFilePicker'
import type { GmailThreadPayload } from './GmailPicker'

// ── Shared helpers ────────────────────────────────────────────────────────────

const EXPORT_MIME: Record<string, string> = {
  'application/vnd.google-apps.document':     'text/plain',
  'application/vnd.google-apps.spreadsheet':  'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/pdf':                          'text/plain',
}

const TYPE_LABEL: Record<string, string> = {
  'application/vnd.google-apps.document':     'DOC',
  'application/vnd.google-apps.spreadsheet':  'SHEET',
  'application/vnd.google-apps.presentation': 'SLIDES',
  'application/pdf':                          'PDF',
  'text/plain':                               'TXT',
  'text/csv':                                 'CSV',
}

function decodeBase64(str: string): string {
  try {
    return decodeURIComponent(
      atob(str.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
  } catch { return '' }
}

function extractBody(payload: Record<string, unknown>): string {
  const body = payload.body as { data?: string } | undefined
  if (body?.data) return decodeBase64(body.data)
  const parts = payload.parts as Array<Record<string, unknown>> | undefined
  if (!parts) return ''
  for (const part of parts) {
    if ((part.mimeType as string) === 'text/plain') {
      const pb = part.body as { data?: string } | undefined
      if (pb?.data) return decodeBase64(pb.data)
    }
  }
  for (const part of parts) {
    const nested = extractBody(part)
    if (nested) return nested
  }
  return ''
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Item {
  id:       string
  type:     'drive' | 'gmail'
  title:    string
  subtitle: string
  mimeType: string
}

export interface SearchModalProps {
  isOpen:   boolean
  onClose:  () => void
  onSelect: (drive: DriveFilePayload[], gmail: GmailThreadPayload[]) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SearchModal({ isOpen, onClose, onSelect }: SearchModalProps) {
  const [query,         setQuery]        = useState('')
  const [items,         setItems]        = useState<Item[]>([])
  const [loading,       setLoading]      = useState(false)
  const [selected,      setSelected]     = useState<Set<string>>(new Set())
  const [fetching,      setFetching]     = useState<Set<string>>(new Set())
  const [driveContents, setDriveContents] = useState<Map<string, string>>(new Map())
  const [gmailContents, setGmailContents] = useState<Map<string, GmailThreadPayload>>(new Map())
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset + load on open
  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setSelected(new Set())
    setDriveContents(new Map())
    setGmailContents(new Map())
    setItems([])
    loadItems()
    setTimeout(() => inputRef.current?.focus(), 60)
  }, [isOpen])

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && isOpen) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  const loadItems = async () => {
    setLoading(true)
    const driveToken = localStorage.getItem('drive_token')
    const gmailToken = localStorage.getItem('gmail_token')
    const newItems: Item[] = []

    await Promise.all([
      driveToken && (async () => {
        try {
          const params = new URLSearchParams({
            q:        "mimeType!='application/vnd.google-apps.folder' and trashed=false",
            orderBy:  'modifiedTime desc',
            pageSize: '50',
            fields:   'files(id,name,mimeType)',
          })
          const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
            headers: { Authorization: `Bearer ${driveToken}` },
          })
          if (res.ok) {
            const data = await res.json()
            for (const f of (data.files ?? [])) {
              if (!['image/', 'video/', 'audio/'].some(p => (f.mimeType as string).startsWith(p)) &&
                  f.mimeType !== 'application/vnd.google-apps.folder') {
                newItems.push({ id: f.id, type: 'drive', title: f.name, subtitle: f.mimeType, mimeType: f.mimeType })
              }
            }
          }
        } catch { /* drive unavailable */ }
      })(),

      gmailToken && (async () => {
        try {
          const params = new URLSearchParams({ maxResults: '30', q: 'in:inbox' })
          const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?${params}`, {
            headers: { Authorization: `Bearer ${gmailToken}` },
          })
          if (res.ok) {
            const data = await res.json()
            await Promise.all((data.threads ?? []).slice(0, 20).map(async (t: { id: string }) => {
              try {
                const r = await fetch(
                  `https://gmail.googleapis.com/gmail/v1/users/me/threads/${t.id}?format=metadata&metadataHeaders=Subject`,
                  { headers: { Authorization: `Bearer ${gmailToken}` } }
                )
                if (r.ok) {
                  const d = await r.json()
                  const msgs = d.messages ?? []
                  const firstMsg = msgs[0] ?? {}
                  const headers: Array<{ name: string; value: string }> = firstMsg.payload?.headers ?? []
                  const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? '(no subject)'
                  newItems.push({ id: t.id, type: 'gmail', title: subject, subtitle: firstMsg.snippet ?? '', mimeType: '' })
                }
              } catch { /* skip thread */ }
            }))
          }
        } catch { /* gmail unavailable */ }
      })(),
    ])

    setItems(newItems)
    setLoading(false)
  }

  const filtered = query.trim()
    ? items.filter(i =>
        i.title.toLowerCase().includes(query.toLowerCase()) ||
        i.subtitle.toLowerCase().includes(query.toLowerCase())
      )
    : items

  const fetchContent = async (item: Item) => {
    if (item.type === 'drive') {
      const token = localStorage.getItem('drive_token')
      if (!token) return
      const exportMime = EXPORT_MIME[item.mimeType]
      const url = exportMime
        ? `https://www.googleapis.com/drive/v3/files/${item.id}/export?mimeType=${encodeURIComponent(exportMime)}`
        : `https://www.googleapis.com/drive/v3/files/${item.id}?alt=media`
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) return
      const text = await res.text()
      const CAP = 6000
      const content = text.length > CAP
        ? `${text.slice(0, CAP)}\n\n[Truncated — ${text.length.toLocaleString()} chars total]`
        : text
      setDriveContents(prev => new Map(prev).set(item.id, content))
    } else {
      const token = localStorage.getItem('gmail_token')
      if (!token) return
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${item.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) return
      const data = await res.json()
      const messages = data.messages ?? []
      const parts = messages.slice(0, 5).map((msg: Record<string, unknown>) => {
        const headers = ((msg.payload as Record<string, unknown>)?.headers as Array<{ name: string; value: string }>) ?? []
        const from    = headers.find(h => h.name === 'From')?.value ?? ''
        const date    = headers.find(h => h.name === 'Date')?.value ?? ''
        const body    = extractBody(msg.payload as Record<string, unknown>)
        const CAP     = 800
        const trimmed = body.length > CAP ? body.slice(0, CAP) + '…' : body
        return `From: ${from}\nDate: ${date}\n\n${trimmed}`
      })
      setGmailContents(prev => new Map(prev).set(item.id, { subject: item.title, content: parts.join('\n\n---\n\n') }))
    }
  }

  const fireSelections = (sel: Set<string>, dc: Map<string, string>, gc: Map<string, GmailThreadPayload>) => {
    const drive: DriveFilePayload[] = []
    const gmail: GmailThreadPayload[] = []
    for (const id of sel) {
      const item = items.find(i => i.id === id)
      if (!item) continue
      if (item.type === 'drive' && dc.has(id))  drive.push({ name: item.title, content: dc.get(id)! })
      if (item.type === 'gmail' && gc.has(id))  gmail.push(gc.get(id)!)
    }
    onSelect(drive, gmail)
  }

  const toggle = async (item: Item) => {
    const next = new Set(selected)
    if (next.has(item.id)) {
      next.delete(item.id)
      setSelected(next)
      fireSelections(next, driveContents, gmailContents)
      return
    }
    next.add(item.id)
    setSelected(new Set(next))

    let dc = driveContents
    let gc = gmailContents
    if (!driveContents.has(item.id) && !gmailContents.has(item.id)) {
      setFetching(prev => new Set(prev).add(item.id))
      try {
        await fetchContent(item)
        // capture updated maps after state update
        dc = item.type === 'drive'
          ? new Map(driveContents).set(item.id, driveContents.get(item.id) ?? '')
          : driveContents
        gc = item.type === 'gmail'
          ? new Map(gmailContents).set(item.id, gmailContents.get(item.id) ?? { subject: '', content: '' })
          : gmailContents
      } catch { /* ignore */ }
      setFetching(prev => { const n = new Set(prev); n.delete(item.id); return n })
    }
    // Re-read from state refs after async — handled by useEffect below
  }

  // Fire selections after content maps update
  useEffect(() => {
    if (selected.size > 0) fireSelections(selected, driveContents, gmailContents)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveContents, gmailContents])

  const allFilteredSelected = filtered.length > 0 && filtered.every(i => selected.has(i.id))

  const toggleAll = async () => {
    if (allFilteredSelected) {
      const next = new Set(selected)
      filtered.forEach(i => next.delete(i.id))
      setSelected(next)
      fireSelections(next, driveContents, gmailContents)
      return
    }
    const toAdd = filtered.filter(i => !selected.has(i.id))
    const next  = new Set(selected)
    toAdd.forEach(i => next.add(i.id))
    setSelected(new Set(next))

    setFetching(new Set(toAdd.map(i => i.id)))
    await Promise.all(
      toAdd.map(async item => {
        if (!driveContents.has(item.id) && !gmailContents.has(item.id)) {
          try { await fetchContent(item) } catch { /* skip */ }
        }
        setFetching(prev => { const n = new Set(prev); n.delete(item.id); return n })
      })
    )
  }

  if (!isOpen) return null

  const driveCount = filtered.filter(i => i.type === 'drive').length
  const gmailCount = filtered.filter(i => i.type === 'gmail').length

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-2xl mx-4 bg-arc-surface border border-arc-border rounded-xl shadow-2xl overflow-hidden flex flex-col" style={{ maxHeight: '72vh' }}>

        {/* Search bar */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-arc-border">
          <svg className="w-4 h-4 text-arc-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search Drive files and Gmail threads…"
            className="flex-1 bg-transparent font-mono text-sm text-white placeholder-arc-muted outline-none"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-arc-muted hover:text-white font-mono text-base leading-none">×</button>
          )}
          <kbd className="font-mono text-[9px] text-arc-muted border border-arc-border rounded px-1.5 py-0.5 flex-shrink-0">ESC</kbd>
        </div>

        {/* Stats + Select All row */}
        {!loading && items.length > 0 && (
          <div className="flex items-center gap-3 px-4 py-2 border-b border-arc-border bg-black/20">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                disabled={fetching.size > 0}
                onChange={toggleAll}
                className="accent-arc-green"
              />
              <span className="font-mono text-[10px] text-arc-sub">
                {allFilteredSelected ? 'Deselect all' : 'Select all'}
                {query ? ' results' : ''}
              </span>
              {fetching.size > 0 && (
                <span className="font-mono text-[10px] text-arc-amber animate-pulse">Reading {fetching.size}…</span>
              )}
            </label>
            <div className="flex items-center gap-3 ml-auto font-mono text-[10px] text-arc-muted">
              {driveCount > 0 && <span>{driveCount} Drive</span>}
              {gmailCount > 0 && <span>{gmailCount} Gmail</span>}
              {selected.size > 0 && (
                <span className="text-arc-green font-semibold">{selected.size} selected</span>
              )}
            </div>
          </div>
        )}

        {/* Results list */}
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="px-4 py-16 text-center font-mono text-xs text-arc-muted animate-pulse">
              Loading data sources…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-16 text-center font-mono text-xs text-arc-muted">
              {items.length === 0
                ? 'Connect Google Drive or Gmail to search your context'
                : 'No results match your search'}
            </div>
          ) : (
            filtered.map(item => {
              const isSelected = selected.has(item.id)
              const isFetching = fetching.has(item.id)
              const label = item.type === 'gmail'
                ? 'GMAIL'
                : (TYPE_LABEL[item.mimeType] ?? 'FILE')

              return (
                <label
                  key={item.id}
                  className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors border-b border-arc-border/40 ${
                    isSelected ? 'bg-arc-green/5' : 'hover:bg-black/30'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isFetching}
                    onChange={() => toggle(item)}
                    className="accent-arc-green flex-shrink-0"
                  />
                  <span className={`font-mono text-[9px] border rounded px-1.5 py-0.5 flex-shrink-0 uppercase tracking-wide ${
                    item.type === 'gmail'
                      ? 'text-arc-amber border-arc-amber/30 bg-arc-amber/5'
                      : 'text-arc-muted border-arc-border'
                  }`}>
                    {label}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-[11px] text-white truncate">{item.title}</div>
                    {item.subtitle && (
                      <div className="font-mono text-[10px] text-arc-muted truncate mt-0.5">{item.subtitle}</div>
                    )}
                  </div>
                  {isFetching  && <span className="font-mono text-[10px] text-arc-amber flex-shrink-0 animate-pulse">Reading…</span>}
                  {isSelected && !isFetching && <span className="font-mono text-[10px] text-arc-green flex-shrink-0">✓</span>}
                </label>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-arc-border">
          <span className="font-mono text-[10px] text-arc-muted">
            {selected.size > 0
              ? `${selected.size} item${selected.size !== 1 ? 's' : ''} added to agent context`
              : 'Select files and threads for agents to read'}
          </span>
          <button
            onClick={onClose}
            className="font-mono text-xs font-semibold bg-arc-green text-black px-4 py-1.5 rounded-lg hover:bg-emerald-400 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
