// «اسأل خزانتك» — a conversation with Claude about the owner's own documents, with the source of
// every fact (a chip that opens the document at its page). The conversation lives in memory only:
// it holds document text, so it is gone when the page is closed.
import { FileText, Lock, MessagesSquare, RotateCcw, Send } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ask } from '@/ai/ask'
import { citedIds, splitCitations } from '@/ai/ask-format'
import type { ChatMessage } from '@/ai/transport'
import { MODE } from '@/lib/config'
import { fmtUsd } from '@/lib/cost'
import { useAiMode } from '@/lib/queries'
import { PageHeader } from '@/ui/bits'
import { Button, Card, Spinner, Textarea, cn } from '@/ui/kit'
import { useVault, vault } from '@/ui/vault'

type Turn = { role: 'user' | 'assistant'; text: string; cost?: number; error?: string; note?: string }

// kept across page changes (open a cited document, come back), never saved
const chat = { messages: [] as ChatMessage[], turns: [] as Turn[], docs: {} as Record<string, string> }

const STARTERS = [
  'ما الوثائق التي تنتهي صلاحيتها خلال السنة القادمة؟',
  'لخّص لي عقد الإيجار: المدة والثمن وشروط الفسخ',
  'ماذا تطلب مني آخر رسالة وصلتني من إدارة؟',
  'أين الأصل الورقي لشهادتي الجامعية؟',
]

const BULLET = /^\s*(?:[-•*]|\d+[.)])\s+/

function Bold({ text }: { text: string }) {
  const parts = text.split(/\*\*([^*]+)\*\*/)
  return <>{parts.map((s, i) => (i % 2 ? <strong key={i} className="font-semibold text-ink">{s}</strong> : s))}</>
}

function Cite({ id, page, title }: { id: string; page: number | null; title: string }) {
  return (
    <Link
      to={`/doc/${id}${page ? `?page=${page}` : ''}`}
      title={title}
      className="mx-0.5 inline-flex max-w-[13rem] items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 align-middle text-[11px] leading-4 text-brand-700 hover:underline dark:bg-brand-900/40 dark:text-brand-200"
    >
      <FileText className="size-3 shrink-0" />
      <span className="truncate">
        {title}
        {page ? ` · ص ${page}` : ''}
      </span>
    </Link>
  )
}

function Inline({ text, docs }: { text: string; docs: Record<string, string> }) {
  return (
    <>
      {splitCitations(text).map((p, i) =>
        p.kind === 'cite' ? docs[p.id] ? <Cite key={i} id={p.id} page={p.page} title={docs[p.id]} /> : null : <Bold key={i} text={p.text} />,
      )}
    </>
  )
}

/** a light reading of the answer: paragraphs, lists, **bold**, headings, citations */
function Answer({ text, docs }: { text: string; docs: Record<string, string> }) {
  const blocks = text.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  return (
    <div dir="auto" className="space-y-2.5 text-[15px] leading-relaxed text-text">
      {blocks.map((block, bi) => {
        const groups: { list: boolean; lines: string[] }[] = []
        for (const line of block.split('\n').filter((l) => l.trim())) {
          const list = BULLET.test(line)
          const last = groups[groups.length - 1]
          if (last && last.list === list) last.lines.push(line)
          else groups.push({ list, lines: [line] })
        }
        return groups.map((g, gi) =>
          g.list ? (
            <ul key={`${bi}-${gi}`} className="list-disc space-y-1 ps-5">
              {g.lines.map((l, li) => (
                <li key={li}>
                  <Inline text={l.replace(BULLET, '')} docs={docs} />
                </li>
              ))}
            </ul>
          ) : (
            <p key={`${bi}-${gi}`}>
              {g.lines.map((l, li) => {
                const heading = /^#{1,4}\s+/.test(l)
                return (
                  <span key={li} className={cn(heading && 'font-semibold text-ink')}>
                    {li > 0 && <br />}
                    <Inline text={l.replace(/^#{1,4}\s+/, '')} docs={docs} />
                  </span>
                )
              })}
            </p>
          ),
        )
      })}
    </div>
  )
}

function AnswerCard({ turn, docs }: { turn: Turn; docs: Record<string, string> }) {
  if (turn.error)
    return (
      <Card dir="auto" className="border-danger/30 bg-danger-bg p-4 text-sm leading-relaxed text-danger">
        {turn.error}
      </Card>
    )
  const ids = citedIds(turn.text).filter((id) => docs[id])
  return (
    <Card className="p-4 sm:p-5">
      {turn.text && <Answer text={turn.text} docs={docs} />}
      {turn.note && <p className="mt-2 text-sm text-warning">{turn.note}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {ids.length > 0 && <span className="text-xs text-muted">المصادر:</span>}
        {ids.map((id) => (
          <Link key={id} to={`/doc/${id}`} className="inline-flex max-w-[16rem] items-center gap-1 rounded-lg bg-surface-2 px-2 py-1 text-xs text-brand-700 hover:underline dark:text-brand-200">
            <FileText className="size-3.5 shrink-0" />
            <span className="truncate">{docs[id]}</span>
          </Link>
        ))}
        {turn.cost != null && <span className="num ms-auto text-[11px] text-muted">{fmtUsd(turn.cost)}</span>}
      </div>
    </Card>
  )
}

export default function AskPage() {
  const ai = useAiMode().data
  const v = useVault()
  const [turns, setTurns] = useState<Turn[]>(chat.turns)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const ready = ai === 'claude'

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length, live, status])

  const save = (t: Turn[]) => {
    chat.turns = t
    setTurns(t)
  }

  const send = async (q: string) => {
    const question = q.trim()
    if (!question || busy || !ready) return
    setInput('')
    setBusy(true)
    setLive('')
    setStatus('يفكّر…')
    const withQuestion: Turn[] = [...chat.turns, { role: 'user', text: question }]
    save(withQuestion)
    try {
      const r = await ask(
        chat.messages,
        question,
        (e) => {
          if (e.kind === 'round') setLive('')
          else if (e.kind === 'text') {
            setLive((t) => t + e.delta)
            setStatus(null)
          } else if (e.kind === 'search') setStatus(e.query ? `يبحث في أرشيفك: «${e.query}»` : 'يتصفح أرشيفك')
          else setStatus(`يقرأ: ${e.title}`)
        },
        chat.docs,
      )
      chat.messages = r.messages
      chat.docs = r.docs
      const note =
        r.stopped === 'max_tokens'
          ? 'الجواب طويل فقُطع: اطلب البقية.'
          : r.stopped === 'refusal'
            ? 'امتنع Claude عن الإجابة عن هذا السؤال.'
            : r.stopped === 'rounds'
              ? 'بحث طويلاً دون أن يكمل الجواب: جرّب سؤالاً أدق.'
              : undefined
      save([...withQuestion, { role: 'assistant', text: r.answer || (note ? '' : 'لم أجد ما أجيب به.'), cost: r.costUsd, note }])
    } catch (e) {
      // the question is not kept in the conversation sent to Claude: ask again when ready
      save([...withQuestion, { role: 'assistant', text: '', error: (e as Error)?.message || String(e) }])
    } finally {
      setBusy(false)
      setLive('')
      setStatus(null)
    }
  }

  const reset = () => {
    chat.messages = []
    chat.docs = {}
    save([])
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="اسأل خزانتك"
        icon={MessagesSquare}
        subtitle="اسأل عن وثائقك بلغتك: يبحث Claude في أرشيفك ويجيبك، ويذكر مصدر كل معلومة."
        actions={
          turns.length > 0 ? (
            <Button variant="ghost" size="sm" icon={RotateCcw} onClick={reset} disabled={busy}>
              محادثة جديدة
            </Button>
          ) : null
        }
      />

      {ai && !ready && (
        <Card className="mb-4 p-4 text-sm leading-relaxed">
          المساعد يحتاج Claude. أضف مفتاحك في{' '}
          <Link to="/settings#ai" className="font-medium text-brand-600 underline">
            الإعدادات
          </Link>
          .
        </Card>
      )}
      {MODE === 'local' && v.configured && !v.open && (
        <Card className="mb-4 flex flex-wrap items-center gap-3 border-brass-400/50 bg-brass-100/50 p-4 text-sm">
          <Lock className="size-5 shrink-0 text-brass-600" />
          <span className="min-w-0 flex-1 leading-relaxed">الخزنة مقفلة: لا يرى المساعد وثائق الهوية والجواز والإقامة والطبية والبنكية حتى تفتحها.</span>
          <Button size="sm" variant="brass" onClick={() => void vault.open()}>
            افتح الخزنة
          </Button>
        </Card>
      )}

      <div className="space-y-4">
        {turns.length === 0 && (
          <Card className="p-5">
            <p className="text-sm text-muted">جرّب مثلاً:</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={busy || !ready}
                  onClick={() => void send(s)}
                  className="rounded-full border border-line bg-surface-2 px-3 py-1.5 text-start text-sm text-text hover:border-brand-500 disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </Card>
        )}

        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div dir="auto" className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-brand-700 px-4 py-2.5 text-sm leading-relaxed text-white">
                {t.text}
              </div>
            </div>
          ) : (
            <AnswerCard key={i} turn={t} docs={chat.docs} />
          ),
        )}

        {busy && (
          <Card className="p-4 sm:p-5">
            {live && <Answer text={live} docs={chat.docs} />}
            {status && (
              <div className={cn('flex items-center gap-2 text-sm text-muted', live && 'mt-2')}>
                <Spinner className="size-4" /> {status}
              </div>
            )}
          </Card>
        )}
        <div ref={end} />
      </div>

      <form
        className="sticky bottom-24 mt-4 lg:bottom-4"
        onSubmit={(e) => {
          e.preventDefault()
          void send(input)
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface p-2 shadow-card">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(input)
              }
            }}
            rows={2}
            dir="auto"
            placeholder="اكتب سؤالك… مثلاً: متى ينتهي جواز سفري؟"
            className="min-h-[44px] flex-1 resize-none border-0 bg-transparent shadow-none focus:ring-0"
            disabled={!ready}
          />
          <Button type="submit" icon={Send} loading={busy} disabled={!input.trim() || !ready}>
            أرسل
          </Button>
        </div>
        <p className="mt-2 px-1 text-xs leading-relaxed text-muted">
          يجيب من وثائقك وحدها ويذكر مصدر كل معلومة. المحادثة لا تُحفظ: تختفي حين تُغلق الصفحة. كل سؤال يكلف بضعة سنتات من رصيدك.
        </p>
      </form>
    </div>
  )
}
