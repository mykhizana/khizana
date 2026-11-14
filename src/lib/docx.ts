// A small Word document (.docx) written here, for the bibliography: right-to-left paragraphs for Arabic,
// italic runs kept (also for Arabic script: <w:iCs/>), A4, Traditional Arabic / Times New Roman.
// Pure (fflate only): the tests open what it writes.
import { strToU8, zipSync } from 'fflate'
import type { Seg } from './bib'

export type DocxPara = { segs: Seg[]; style?: 'Title' | 'Heading1' | 'Heading2'; rtl: boolean }

const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/
// characters XML forbids (a stray form feed copied from a PDF) would make Word refuse the file
const allowed = (c: string) => {
  const n = c.codePointAt(0) ?? 0
  return n >= 32 ? n !== 0xfffe && n !== 0xffff : n === 9 || n === 10 || n === 13
}
const esc = (s: string) =>
  Array.from(s)
    .filter(allowed)
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

function run(s: Seg): string {
  const props = [ARABIC.test(s.t) ? '<w:rtl/>' : '', s.i ? '<w:i/><w:iCs/>' : ''].join('')
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(s.t)}</w:t></w:r>`
}

function para(p: DocxPara): string {
  const ppr = [p.style ? `<w:pStyle w:val="${p.style}"/>` : '', p.rtl ? '<w:bidi/>' : '', p.style ? '' : '<w:jc w:val="both"/>'].join('')
  return `<w:p><w:pPr>${ppr}</w:pPr>${p.segs.filter((s) => s.t).map(run).join('')}</w:p>`
}

const STYLES = `${XML}<w:styles ${NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Traditional Arabic"/><w:sz w:val="24"/><w:szCs w:val="30"/><w:lang w:val="fr-FR" w:bidi="ar-MA"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="360"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="28"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="26"/><w:szCs w:val="32"/></w:rPr></w:style>
</w:styles>`

/** the .docx bytes of these paragraphs */
export function docx(paras: DocxPara[]): Uint8Array {
  const body = paras.map(para).join('')
  const document = `${XML}<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>`
  return zipSync(
    {
      '[Content_Types].xml': strToU8(
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ),
      '_rels/.rels': strToU8(
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      'word/_rels/document.xml.rels': strToU8(
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
      'word/document.xml': strToU8(document),
      'word/styles.xml': strToU8(STYLES),
    },
    { level: 6 },
  )
}

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
