// Arabic labels for the values stored in the database
import {
  Award,
  BookOpen,
  Briefcase,
  CalendarClock,
  ClipboardList,
  FileBadge,
  FileCheck2,
  FileHeart,
  FileSignature,
  FileText,
  Gavel,
  GraduationCap,
  HeartPulse,
  Home,
  IdCard,
  Image,
  Landmark,
  Mail,
  Microscope,
  NotebookPen,
  Pill,
  Plane,
  Presentation,
  Receipt,
  ReceiptText,
  Scale,
  ScrollText,
  Users,
  Folder,
  type LucideIcon,
} from 'lucide-react'

export const DOC_TYPES: { key: string; ar: string; icon: LucideIcon }[] = [
  { key: 'lecture', ar: 'محاضرة / درس', icon: Presentation },
  { key: 'article', ar: 'مقال', icon: ScrollText },
  { key: 'book', ar: 'كتاب / فصل', icon: BookOpen },
  { key: 'thesis', ar: 'أطروحة / رسالة / بحث', icon: GraduationCap },
  { key: 'exam', ar: 'امتحان', icon: ClipboardList },
  { key: 'legal_text', ar: 'نص قانوني', icon: Scale },
  { key: 'court_ruling', ar: 'حكم / قرار قضائي', icon: Gavel },
  { key: 'report', ar: 'تقرير', icon: Microscope },
  { key: 'presentation', ar: 'عرض', icon: Presentation },
  { key: 'notes', ar: 'ملاحظات / مذكرة', icon: NotebookPen },
  { key: 'diploma', ar: 'دبلوم / شهادة جامعية', icon: Award },
  { key: 'transcript', ar: 'كشف نقط', icon: FileCheck2 },
  { key: 'certificate', ar: 'شهادة / إشهاد', icon: FileBadge },
  { key: 'id_document', ar: 'وثيقة هوية', icon: IdCard },
  { key: 'civil_record', ar: 'حالة مدنية', icon: Users },
  { key: 'contract', ar: 'عقد', icon: FileSignature },
  { key: 'invoice', ar: 'فاتورة', icon: ReceiptText },
  { key: 'receipt', ar: 'وصل', icon: Receipt },
  { key: 'statement', ar: 'كشف / بيان', icon: Landmark },
  { key: 'medical', ar: 'ملف طبي', icon: FileHeart },
  { key: 'prescription', ar: 'وصفة طبية', icon: Pill },
  { key: 'letter', ar: 'رسالة / مراسلة', icon: Mail },
  { key: 'form', ar: 'استمارة', icon: ClipboardList },
  { key: 'photo', ar: 'صورة', icon: Image },
  { key: 'other', ar: 'أخرى', icon: FileText },
]
export const DOC_TYPE_KEYS = DOC_TYPES.map((t) => t.key)
export const typeLabel = (k: string | null | undefined) => DOC_TYPES.find((t) => t.key === k)?.ar ?? 'وثيقة'
export const typeIcon = (k: string | null | undefined): LucideIcon => DOC_TYPES.find((t) => t.key === k)?.icon ?? FileText

export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  'graduation-cap': GraduationCap,
  'id-card': IdCard,
  plane: Plane,
  award: Award,
  'heart-pulse': HeartPulse,
  briefcase: Briefcase,
  landmark: Landmark,
  home: Home,
  mail: Mail,
  users: Users,
  calendar: CalendarClock,
}
export const categoryIcon = (k: string | null | undefined): LucideIcon => (k && CATEGORY_ICONS[k]) || Folder

export const ROLES: Record<string, string> = {
  author: 'مؤلف',
  professor: 'أستاذ',
  supervisor: 'مشرف',
  student: 'طالب',
  physician: 'طبيب',
  patient: 'مريض',
  signatory: 'موقّع',
  sender: 'مرسِل',
  recipient: 'مرسَل إليه',
  holder: 'صاحب الوثيقة',
  mentioned: 'مذكور',
  organization: 'جهة',
  issue_place: 'مكان الإصدار',
  subject: 'موضوع',
}
export const roleLabel = (r: string | null | undefined) => (r && ROLES[r]) || r || ''

export const PERSON_ROLES = ['author', 'professor', 'supervisor', 'student', 'physician', 'patient', 'signatory', 'sender', 'recipient', 'holder', 'mentioned']
export const ORG_KINDS = ['university', 'faculty', 'school', 'hospital', 'clinic', 'ministry', 'administration', 'court', 'consulate', 'embassy', 'bank', 'insurance', 'company', 'municipality', 'publisher', 'other']
export const ID_KINDS = ['passport_no', 'id_no', 'residence_no', 'certificate_no', 'case_no', 'law_no', 'decree_no', 'invoice_no', 'account_no', 'student_no', 'isbn', 'reference', 'other']
export const ID_LABELS: Record<string, string> = {
  passport_no: 'رقم الجواز',
  id_no: 'رقم البطاقة',
  residence_no: 'رقم الإقامة',
  certificate_no: 'رقم الشهادة',
  case_no: 'رقم الملف',
  law_no: 'رقم القانون',
  decree_no: 'رقم المرسوم',
  invoice_no: 'رقم الفاتورة',
  account_no: 'رقم الحساب',
  student_no: 'رقم الطالب',
  isbn: 'ISBN',
  reference: 'مرجع',
  other: 'رقم',
}

export const LANGS: Record<string, string> = { ar: 'العربية', fr: 'الفرنسية', es: 'الإسبانية', en: 'الإنجليزية', other: 'لغة أخرى' }
export const langLabel = (k: string | number) => LANGS[String(k)] ?? String(k)

export const STATE_LABEL: Record<string, string> = {
  new: 'في الطابور',
  reading: 'يقرأ الصفحات',
  understanding: 'يفهم الوثيقة',
  checking: 'يفحص التكرار',
  ready: 'جاهزة',
  review: 'تنتظر مراجعتك',
  error: 'تعذّرت المعالجة',
  waiting: 'متوقفة مؤقتاً',
}

export const RELATION_LABEL: Record<string, string> = {
  same: 'نفس الوثيقة',
  better_copy: 'نسخة أوضح',
  version: 'إصدار آخر',
  translation: 'ترجمة',
  part: 'جزء من',
  annotated: 'نسخة عليها تعليقات',
  related: 'ذات صلة',
  attachment: 'مرفق',
  different: 'ليست نفس الوثيقة',
}

export const METHOD_LABEL: Record<string, string> = {
  sha256: 'البصمة الرقمية',
  text: 'بصمة النص',
  phash: 'البصمة البصرية',
  minhash: 'تشابه النص',
  pages: 'تطابق الصفحات',
  identity: 'نفس الأرقام المرجعية',
  ai: 'الذكاء الاصطناعي',
  owner: 'أنت',
  demo: 'تقدير تقريبي',
}

export const SENSITIVITY_LABEL: Record<string, string> = { normal: 'عادية', private: 'خاصة', vault: 'في الخزنة' }

export const LOCATION_KINDS: Record<string, string> = {
  box: 'صندوق',
  folder: 'ملف / حافظة',
  shelf: 'رف / خزانة',
  place: 'مكان',
  person: 'عند شخص',
  with_me: 'معي',
  other: 'أخرى',
}
