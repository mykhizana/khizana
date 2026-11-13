// node scripts/make-fixtures.mjs — sample documents for testing the app (test-fixtures/, never deployed)
import { mkdirSync, writeFileSync } from 'node:fs'

const DIR = 'test-fixtures'
mkdirSync(DIR, { recursive: true })

const lecture = `كلية العلوم القانونية والاقتصادية والاجتماعية - تطوان
مسلك القانون العام - السنة الجامعية 2018/2019
محاضرات في القانون الإداري
الدكتور محمد بنعلي

المحور الأول: مفهوم القانون الإداري ومصادره
يُعرَّف القانون الإداري بأنه مجموعة القواعد القانونية التي تنظم نشاط الإدارة العمومية وعلاقتها بالأفراد، وتحدد تنظيم المرافق العامة وطرق تسييرها.
ومن أهم مصادره: الدستور، والتشريع، والاجتهاد القضائي الإداري، والمبادئ العامة للقانون.

المحور الثاني: التنظيم الإداري بالمغرب
يقوم التنظيم الإداري على المركزية واللامركزية الإدارية، وقد عرف المغرب مع دستور 2011 ورشاً كبيراً هو الجهوية المتقدمة، التي تجعل من الجهة شريكاً للدولة في التنمية.
وينظم القانون التنظيمي رقم 111.14 المتعلق بالجهات اختصاصات مجالس الجهات ومواردها وطرق تدبيرها.

المحور الثالث: القرار الإداري
القرار الإداري عمل قانوني صادر بالإرادة المنفردة للإدارة، من شأنه إحداث أثر قانوني. ويخضع لرقابة القضاء الإداري عن طريق دعوى الإلغاء بسبب تجاوز السلطة.
`
writeFileSync(`${DIR}/محاضرات-القانون-الاداري-2018.txt`, lecture)
// the very same bytes, renamed: must be refused before upload
writeFileSync(`${DIR}/copie-cours-droit-admin.txt`, lecture)
// a revised version: same lecture with a new section and a few edits
writeFileSync(
  `${DIR}/محاضرات-القانون-الاداري-النسخة-المحينة.txt`,
  lecture.replace('2018/2019', '2019/2020').replace('دعوى الإلغاء بسبب تجاوز السلطة.', 'دعوى الإلغاء بسبب تجاوز السلطة، ودعوى القضاء الشامل.') +
    `\nالمحور الرابع: العقود الإدارية\nتبرم الإدارة عقوداً إدارية كالصفقات العمومية وعقود التدبير المفوض، وتخضع لنظام قانوني متميز.\n`,
)

const notes = `ملخص شخصي: الجهوية المتقدمة واللامركزية
- الجهة جماعة ترابية خاضعة للقانون العام
- القانون التنظيمي 111.14 المتعلق بالجهات
- مبدأ التدبير الحر ومبدأ التفريع
- دور الوالي في المراقبة الإدارية
`
writeFileSync(`${DIR}/ملخص-الجهوية-المتقدمة.txt`, notes)

// ---------------------------------------------------------------- a small text PDF (Spanish, WinAnsi)
function pdf(lines) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  let y = 760
  const body = lines
    .map(([size, text]) => {
      const s = `BT /F1 ${size} Tf 64 ${y} Td (${esc(text)}) Tj ET`
      y -= size + 12
      return s
    })
    .join('\n')
  const stream = Buffer.from(body, 'latin1')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = []
  let pos = parts[0].length
  objs.forEach((o, i) => {
    const b = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
    offsets.push(pos)
    parts.push(b)
    pos += b.length
  })
  const s5 = Buffer.concat([Buffer.from(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream\nendobj\n', 'latin1')])
  offsets.push(pos)
  parts.push(s5)
  pos += s5.length
  const xref = ['xref', `0 ${offsets.length + 1}`, '0000000000 65535 f ', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `), 'trailer', `<< /Size ${offsets.length + 1} /Root 1 0 R >>`, 'startxref', String(pos), '%%EOF'].join('\n')
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

writeFileSync(
  `${DIR}/certificado-sanitas.pdf`,
  pdf([
    [20, 'SANITAS SEGUROS'],
    [15, 'Certificado de afiliación al seguro de salud'],
    [11, 'Titular: Karim El Amrani'],
    [11, 'NIE: X1234567Z'],
    [11, 'Póliza n.º 99887766'],
    [11, 'Fecha de emisión: 15/03/2026'],
    [11, 'Válido hasta: 31/12/2026'],
    [11, 'Este certificado acredita la cobertura sanitaria privada requerida para la tarjeta de residencia (TIE).'],
    [11, 'Madrid, España'],
  ]),
)
console.log('fixtures written to', DIR)
