// «الجديد»: a card on the home page listing what was added since the owner last looked, shown until
// dismissed (remembered on this device).
import { BookMarked, FolderCheck, ListOrdered, Network, Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { idb } from '@/db/idb'
import { Card, IconButton } from './kit'

const KEY = 'news_seen'
const VERSION = '2026-11-14'
const ITEMS = [
  { to: '/dossiers', icon: FolderCheck, title: 'الملفات الجاهزة', text: 'وثائق إجراء واحد في PDF مرتب بغلاف وفهرس وعلامة مائية، ورابط مشاركة تسحبه متى شئت، و«ما الذي ينقصني؟» يفحص أرشيفك.' },
  { to: '/references', icon: BookMarked, title: 'مراجعي', text: 'مرجع كل كتاب ومقال وأطروحة ونص قانوني على قواعد توثيقك، يُنسخ إلى Word بعناوينه المائلة، ولائحة المراجع في ملف Word.' },
  { to: '/references', icon: ListOrdered, title: 'فهرس الفصول', text: 'في صفحة كل نص قانوني: فصوله ومواده، تنتقل إلى أي فصل وتنسخ الإحالة إليه.' },
  { to: '/relations', icon: Network, title: 'خريطة العلاقات', text: 'من يرتبط بمن في وثائقك: الأشخاص والجهات والأماكن، والوثائق التي تجمعهم.' },
]

export function WhatsNew() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    void idb
      .get<string>('kv', KEY)
      .then((v) => setShow(v !== VERSION))
      .catch(() => setShow(false))
  }, [])
  if (!show) return null
  const hide = () => {
    setShow(false)
    void idb.set('kv', KEY, VERSION).catch(() => undefined)
  }
  return (
    <Card className="border-brand-200/70 bg-brand-50/40 p-5 dark:bg-brand-900/20">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-ink">
          <Sparkles className="size-4 text-brass-500" /> الجديد في خزانة
        </h3>
        <IconButton icon={X} label="فهمت" size="sm" onClick={hide} />
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {ITEMS.map((it) => (
          <li key={it.title}>
            <Link to={it.to} className="flex items-start gap-2.5 rounded-xl bg-surface p-3 transition-colors hover:bg-surface-2">
              <it.icon className="mt-0.5 size-4 shrink-0 text-brand-600" />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{it.title}</span>
                <span className="block text-xs leading-relaxed text-muted">{it.text}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}
