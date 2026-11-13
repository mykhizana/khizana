// The «approximate» brain used while no Claude key is connected: simple rules on the text and the
// file name. It lets the whole app work (search, shelves, duplicates) — Claude replaces it when added.
import { isStop, norm, personKey } from '@/lib/norm'
import type { AiCard, Category } from '@/lib/types'

// a few frequent subjects: enough to show how a new shelf is proposed while Claude is not connected
const SUBJECTS: { re: RegExp; parent: string; ar: string; fr: string; es: string; en: string }[] = [
  { re: /القانون الاداري|droit administratif|derecho administrativo/, parent: 'الدراسة والبحث العلمي', ar: 'القانون الإداري', fr: 'Droit administratif', es: 'Derecho administrativo', en: 'Administrative law' },
  { re: /القانون الدستوري|droit constitutionnel|derecho constitucional/, parent: 'الدراسة والبحث العلمي', ar: 'القانون الدستوري', fr: 'Droit constitutionnel', es: 'Derecho constitucional', en: 'Constitutional law' },
  { re: /الجهويه المتقدمه|اللامركزيه|الجماعات الترابيه|regionalisation avancee|decentralisation/, parent: 'الدراسة والبحث العلمي', ar: 'الجهوية واللامركزية', fr: 'Régionalisation et décentralisation', es: 'Regionalización y descentralización', en: 'Regionalisation & decentralisation' },
  { re: /الماليه العامه|finances publiques|hacienda publica/, parent: 'الدراسة والبحث العلمي', ar: 'المالية العامة', fr: 'Finances publiques', es: 'Hacienda pública', en: 'Public finance' },
  { re: /الذكاء الاصطناعي|السياده الرقميه|intelligence artificielle|souverainete numerique|inteligencia artificial/, parent: 'الدراسة والبحث العلمي', ar: 'القانون الرقمي والذكاء الاصطناعي', fr: 'Droit du numérique et IA', es: 'Derecho digital e IA', en: 'Digital law & AI' },
  { re: /seguro de salud|assurance maladie|health insurance|التامين الصحي|sanitas|mutuelle/, parent: 'الصحة', ar: 'التأمين الصحي', fr: 'Assurance maladie', es: 'Seguro de salud', en: 'Health insurance' },
]

const TYPE_RULES: [string, RegExp][] = [
  ['certificate', /(certificado de afiliacion|attestation d.affiliation|certificate of insurance|شهاده التامين|seguro de salud)/],
  ['id_document', /(passeport|pasaporte|passport|جواز السفر|جواز|بطاقه التعريف|carte nationale|cnie|\bdni\b|carte de sejour|بطاقه الاقامه)/],
  ['civil_record', /(عقد الازدياد|رسم الولاده|عقد الزواج|acte de naissance|acte de mariage|partida de nacimiento|etat civil|الحاله المدنيه)/],
  ['diploma', /(diplome|دبلوم|شهاده الاجازه|الماستر|master|licence|titulo|baccalaureat|البكالوريا)/],
  ['transcript', /(releve de notes|كشف النقط|expediente academico|bulletin de notes)/],
  ['legal_text', /(ظهير شريف|القانون رقم|مرسوم رقم|dahir|loi n|decret n|ley organica|real decreto|bulletin officiel|الجريده الرسميه)/],
  ['court_ruling', /(حكم|قرار عدد|المحكمه|jugement|arret|tribunal|sentencia|juzgado)/],
  ['thesis', /(اطروحه|رساله لنيل|بحث لنيل|these|tesis doctoral|memoire|doctorat|دكتوراه)/],
  ['lecture', /(محاضره|محاضرات|cours de|clase|lecture|درس|المقرر|السداسي|semestre)/],
  ['article', /(مقال|مجله|revue|article|articulo|journal of)/],
  ['book', /(isbn|كتاب|edition|editorial|الطبعه|دار النشر)/],
  ['exam', /(امتحان|examen|exam|الدوره العاديه|session ordinaire)/],
  ['invoice', /(facture|factura|فاتوره|invoice|montant ttc|iva)/],
  ['receipt', /(recu|recibo|وصل|ايصال|receipt)/],
  ['statement', /(releve bancaire|extracto|كشف الحساب|statement|solde)/],
  ['contract', /(contrat|contrato|عقد كراء|عقد عمل|عقد البيع|agreement|bail)/],
  ['prescription', /(ordonnance|receta|وصفه طبيه)/],
  ['medical', /(medical|medico|طبي|تحاليل|radiologie|analyses|hospital|مستشفى|clinique|diagnostic)/],
  ['certificate', /(attestation|certificat|certificado|شهاده|اشهاد)/],
  ['letter', /(objet|asunto|الموضوع|monsieur|madame|estimado|السيد المحترم|تحيه طيبه)/],
  ['report', /(rapport|informe|تقرير|report)/],
  ['form', /(formulaire|formulario|استماره|solicitud|demande)/],
]

const TYPE_TO_SHELF: Record<string, string> = {
  id_document: 'الهوية والحالة المدنية',
  civil_record: 'الهوية والحالة المدنية',
  diploma: 'الشهادات والدبلومات',
  transcript: 'الشهادات والدبلومات',
  certificate: 'الشهادات والدبلومات',
  legal_text: 'الدراسة والبحث العلمي',
  court_ruling: 'الدراسة والبحث العلمي',
  thesis: 'الدراسة والبحث العلمي',
  lecture: 'الدراسة والبحث العلمي',
  article: 'الدراسة والبحث العلمي',
  book: 'الدراسة والبحث العلمي',
  exam: 'الدراسة والبحث العلمي',
  notes: 'الدراسة والبحث العلمي',
  invoice: 'المال والبنوك والضرائب',
  receipt: 'المال والبنوك والضرائب',
  statement: 'المال والبنوك والضرائب',
  medical: 'الصحة',
  prescription: 'الصحة',
  letter: 'المراسلات الإدارية',
  form: 'المراسلات الإدارية',
}

function detectLanguages(t: string): AiCard['languages'] {
  const ar = (t.match(/[؀-ۿ]/g) ?? []).length
  const lat = (t.match(/[A-Za-zÀ-ÿ]/g) ?? []).length
  const out: AiCard['languages'] = []
  if (ar > 20) out.push('ar')
  if (lat > 20) {
    const w = norm(t).split(' ')
    const fr = w.filter((x) => ['le', 'les', 'des', 'du', 'et', 'est', 'pour', 'avec', 'dans'].includes(x)).length
    const es = w.filter((x) => ['el', 'los', 'las', 'del', 'y', 'para', 'con', 'por', 'una'].includes(x)).length
    const en = w.filter((x) => ['the', 'and', 'of', 'with', 'for', 'is', 'are'].includes(x)).length
    const best = Math.max(fr, es, en)
    out.push(best === 0 ? 'other' : best === fr ? 'fr' : best === es ? 'es' : 'en')
  }
  return out.length ? out : ['other']
}

function findPeople(t: string): AiCard['people'] {
  const out = new Map<string, AiCard['people'][number]>()
  const ar = /(?:الدكتور(?:ة)?|د\.|الأستاذ(?:ة)?|الاستاذ(?:ة)?|ذ\.)\s*([ء-ي]{2,}(?:\s+[ء-ي]{2,})?)/g
  const la = /\b(?:Dr|Pr|Prof|Docteur|Doctor|Professeur)\.?\s+([A-Z][A-Za-zÀ-ÿ'-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'-]+)?)/g
  for (const m of t.matchAll(ar)) {
    const name = m[1].trim()
    const key = personKey(name)
    if (key && !out.has(key)) out.set(key, { name_ar: name, name_latin: '', honorific: m[0].replace(m[1], '').trim() || null, role: 'professor', as_written: m[0].trim() })
  }
  for (const m of t.matchAll(la)) {
    const name = m[1].trim()
    const key = personKey(name)
    if (key && !out.has(key)) out.set(key, { name_ar: '', name_latin: name, honorific: m[0].replace(m[1], '').trim() || null, role: 'professor', as_written: m[0].trim() })
  }
  return [...out.values()].slice(0, 6)
}

function findDate(t: string): { date: string | null; precision: 'day' | 'year' | null; ay: string | null } {
  const ay = /(20\d\d|19\d\d)\s*[/-]\s*(20\d\d|19\d\d)/.exec(t)
  const dmy = /\b(\d{1,2})[/.-](\d{1,2})[/.-]((?:19|20)\d\d)\b/.exec(t)
  if (dmy) {
    const [, d, m, y] = dmy
    if (+m >= 1 && +m <= 12 && +d >= 1 && +d <= 31) return { date: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, precision: 'day', ay: ay ? `${ay[1]}/${ay[2]}` : null }
  }
  const iso = /\b((?:19|20)\d\d)-(\d{2})-(\d{2})\b/.exec(t)
  if (iso) return { date: iso[0], precision: 'day', ay: ay ? `${ay[1]}/${ay[2]}` : null }
  const y = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(t)
  return { date: y ? `${y[1]}-01-01` : null, precision: y ? 'year' : null, ay: ay ? `${ay[1]}/${ay[2]}` : null }
}

export function demoUnderstand(o: { fileName: string; hint: string; pageTexts: string[]; categories: Category[] }): AiCard {
  const text = o.pageTexts.join('\n')
  const hay = norm(`${o.fileName} ${o.hint} ${text.slice(0, 20000)}`)
  const docType = TYPE_RULES.find(([, re]) => re.test(hay))?.[0] ?? (text.trim() ? 'other' : 'photo')
  // title: among the first lines, the one that names the document (a line with a type word wins)
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 6 && l.length <= 110)
    .slice(0, 8)
  const titleWord = /(محاضر|درس|مقال|شهاد|عقد|تقرير|ملخص|اطروح|رسال|cours|certificad|certificat|attestation|contrat|contrato|informe|rapport)/
  const firstLine = lines.find((l) => titleWord.test(norm(l))) ?? lines[0] ?? ''
  const title = firstLine || o.fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ')
  // shelf: the existing category whose words appear the most, else the shelf of the type
  let best: Category | null = null
  let bestScore = 0
  for (const c of o.categories) {
    if (c.archived) continue
    const words = [...new Set([c.name_ar, c.name_fr, c.name_es, c.name_en, ...c.aliases].flatMap((x) => norm(x).split(' ')))].filter((w) => w.length >= 4 && !isStop(w))
    const score = words.filter((w) => hay.includes(w)).length + (c.parent_id ? 0.5 : 0)
    if (score > bestScore + 0.4) {
      best = c
      bestScore = score
    }
  }
  if (!best || bestScore < 1.5) best = o.categories.find((c) => c.name_ar === TYPE_TO_SHELF[docType]) ?? null
  // a known subject: use its shelf if it exists, otherwise propose it (the owner decides)
  let proposal: AiCard['category']['proposal'] = null
  const subject = SUBJECTS.find((s) => s.re.test(hay))
  if (subject) {
    const existing = o.categories.find((c) => !c.archived && (norm(c.name_ar) === norm(subject.ar) || c.aliases.includes(norm(subject.ar))))
    const parent = o.categories.find((c) => c.name_ar === subject.parent)
    if (existing) best = existing
    else if (parent) {
      best = parent
      proposal = { parent_id: parent.id, name_ar: subject.ar, name_fr: subject.fr, name_es: subject.es, name_en: subject.en, reason_ar: `الوثيقة تتناول «${subject.ar}» ولا يوجد رف لهذا الموضوع بعد.` }
    }
  }
  const d = findDate(text || o.fileName)
  // «Válido hasta: 31/12/2026», «valable jusqu'au …», «صالحة إلى …»
  const flat = text.normalize('NFD').replace(/[̀-ًͯ-ٰٟ]/g, '').toLowerCase()
  const expiry = /(valido hasta|valable jusqu|date d.expiration|expire le|expiry date|valid until|صالحة الى|صالح الى|تاريخ الانتهاء|ينتهي)[^0-9]{0,25}(\d{1,2})[/.-](\d{1,2})[/.-]((?:19|20)\d\d)/.exec(flat)
  const expiryDate = expiry ? `${expiry[4]}-${expiry[3].padStart(2, '0')}-${expiry[2].padStart(2, '0')}` : null
  const nie = /\b([XYZ]-?\d{7}-?[A-Z])\b/.exec(text)
  const words = norm(text)
    .split(' ')
    .filter((w) => w.length >= 4 && !isStop(w) && !/^\d+$/.test(w))
  const freq = new Map<string, number>()
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([w]) => w)
  const idNo = /\b([A-Z]{1,2}\s?\d{5,8})\b/.exec(text)
  return {
    doc_type: docType,
    title,
    title_ar: /[؀-ۿ]/.test(title) ? title : '',
    summary_ar: text.trim() ? text.replace(/\s+/g, ' ').trim().slice(0, 260) + (text.length > 260 ? '…' : '') : 'لم يُستخرج نص بعد (يقرؤه Claude عند ربطه).',
    languages: detectLanguages(text),
    category: { existing_id: best?.id ?? null, proposal, confidence: best ? 0.6 : 0.3 },
    people: findPeople(text),
    organizations: [],
    places: [],
    dates: { document_date: d.date, precision: d.precision, academic_year: d.ay, period_start: null, period_end: null, expiry_date: expiryDate },
    identifiers: [
      ...(idNo && ['id_document', 'civil_record'].includes(docType) ? [{ kind: docType === 'id_document' ? 'id_no' : 'certificate_no', value: idNo[1] }] : []),
      ...(nie ? [{ kind: 'residence_no', value: nie[1] }] : []),
    ],
    status: { is_copy: false, certified_copy: /(مصادق|certifiee conforme|copia compulsada)/.test(hay), apostille: /apostill/.test(hay), sworn_translation: /(traduccion jurada|ترجمه محلفه|traducteur assermente)/.test(hay), translated_from: null },
    sensitivity: ['id_document', 'medical', 'prescription', 'statement'].includes(docType) ? 'vault' : 'normal',
    keywords: { ar: top.filter((w) => /[ء-ي]/.test(w)), fr: top.filter((w) => /^[a-z]+$/.test(w)), es: [], en: [] },
    visual_features: '',
    deadlines: [],
    reason_ar: 'تصنيف تقريبي بقواعد بسيطة (Claude غير مربوط بعد).',
    confidence: 0.6,
  }
}
