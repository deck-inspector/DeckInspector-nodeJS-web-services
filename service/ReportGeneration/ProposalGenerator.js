const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const { getBlobBuffer } = require("../../database/uploadimage");
const tenantsDAO = require("../../model/tenantsDAO");
const axios = require("axios");

// Proposal document generator.
// The master Proposal template (.docx) is managed in the Multi-Tenant admin
// site exactly like the Final Report template: uploaded per tenant, persisted
// to blob storage ("<cleanname>_ProposalTemplate.docx"), with the repo's
// Deck_ProposalTemplate.docx as the default for every client. At generation
// time the client's name/phone replace the "Deck Inspectors" placeholders and
// the tenant's Report Header logo + Report Footer image/text are stamped in,
// same pipeline as the Final Report.
class ProposalGenerator {

    // Human labels for the master template's dropdowns, keyed by the order the
    // content controls appear in the document. Unknown indexes fall back to a
    // generic label so an updated template still renders a usable form.
    get FIELD_LABELS() {
        return {
            0: 'Proposal Section (title)',
            1: 'Governing Code (title)',
            2: 'Proposal Date',
            3: 'Client Type',
            4: 'Inspection Type',
            7: 'Pricing – Service Line',
            8: 'Pricing – Service Amount',
            9: 'Inspection Scope',
            10: 'Inspection Price',
            11: 'Percentage Required',
            12: 'Percentage Price',
            13: 'Locations Row Label',
            14: 'Locations Covered',
            15: 'Locations Price',
            16: 'Access Row Label',
            17: 'Access Requirement',
            18: 'Access Price',
            19: 'Additional Price',
            20: 'Report Type',
            21: 'Report Fee',
            22: 'Scheduling Fee',
            23: 'Labor / Borescope Line',
            24: 'Labor Rate',
            25: 'Consultant Line',
            26: 'Consultant Fee',
            27: 'Deposit / Rescheduling',
            28: 'Deposit / Rescheduling Fee',
            29: 'Access / Unsafe-Conditions Note',
            30: 'Deposit Amount',
            31: 'Price Validity'
        };
    }

    // Blob-first template resolution (same rules as the Final Report): the app
    // folder is wiped on every deployment, so the admin-uploaded blob copy is
    // the durable source; the repo default is the fallback for all clients.
    async getTemplateBuffer(companyName) {
        const rawClean = (companyName || '').replaceAll(/\s/g, "").replace('.ondeckinspectors.com', '');
        const names = [...new Set([rawClean.toLowerCase(), rawClean])]
            .filter(n => n.length > 0)
            .map(n => `${n}_ProposalTemplate.docx`);
        for (const n of names) {
            try {
                const buf = await getBlobBuffer(n, 'projectreports');
                if (buf && buf.length > 0) {
                    console.log('Proposal: using tenant template from blob storage:', n);
                    return buf;
                }
            } catch (e) { /* blob missing - keep looking */ }
        }
        for (const n of names) {
            const absolute = path.join(__dirname, '..', '..', n);
            if (fs.existsSync(absolute)) {
                console.log('Proposal: using tenant template from app folder:', n);
                return fs.readFileSync(absolute);
            }
        }
        // The ALL-CLIENTS proposal master, uploaded from the dashboard's Master
        // Forms panel. Blob first (the app folder is wiped on every deploy),
        // then the repo copy. Per-tenant templates above still take priority.
        try {
            const buf = await getBlobBuffer('Deck_ProposalTemplate.docx', 'projectreports');
            if (buf && buf.length > 0) {
                console.log('Proposal: using the all-clients master template from blob storage');
                return buf;
            }
        } catch (e) { /* no master uploaded yet - fall back to the repo copy */ }
        console.log('Proposal: no tenant template found for', rawClean, '- using default Deck proposal template');
        return fs.readFileSync(path.join(__dirname, '..', '..', 'Deck_ProposalTemplate.docx'));
    }

    xmlEscape(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    xmlUnescape(s) {
        return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
    }

    // Ordered scan of every top-level content control in document.xml.
    // Returns [{ start, end, contentStart, contentEnd }] byte offsets.
    sdtRanges(doc) {
        const ranges = [];
        let i = 0;
        while (true) {
            const start = doc.indexOf('<w:sdt>', i);
            if (start === -1) break;
            // find the matching close, counting nesting
            let depth = 0;
            let j = start;
            let end = -1;
            while (j < doc.length) {
                const nextOpen = doc.indexOf('<w:sdt>', j + 1);
                const nextClose = doc.indexOf('</w:sdt>', j + 1);
                if (nextClose === -1) break;
                if (nextOpen !== -1 && nextOpen < nextClose) { depth += 1; j = nextOpen; }
                else {
                    if (depth === 0) { end = nextClose + '</w:sdt>'.length; break; }
                    depth -= 1; j = nextClose;
                }
            }
            if (end === -1) break;
            const cs = doc.indexOf('<w:sdtContent>', start);
            const contentStart = (cs !== -1 && cs < end) ? cs + '<w:sdtContent>'.length : -1;
            const contentEnd = (contentStart !== -1) ? doc.lastIndexOf('</w:sdtContent>', end) : -1;
            ranges.push({ start, end, contentStart, contentEnd });
            i = end;
        }
        return ranges;
    }

    // Parse the template into the field list the web form renders:
    // dropdowns (with their options), the date field, and the four
    // "prepared for" text lines (Property / Address / Owner / Contact).
    parseFields(templateBuffer) {
        const zip = new PizZip(templateBuffer);
        const doc = zip.file('word/document.xml').asText();
        const ranges = this.sdtRanges(doc);
        const fields = [];
        for (let idx = 0; idx < ranges.length; idx++) {
            const r = ranges[idx];
            const s = doc.slice(r.start, r.end);
            const isDate = s.indexOf('<w:date') !== -1;
            const items = [...s.matchAll(/<w:listItem w:displayText="([^"]*)" w:value="[^"]*"\/>/g)]
                .map(m => this.xmlUnescape(m[1]));
            if (!isDate && items.length === 0) continue; // plain-text sdt (company name) - not a form field
            const contentChunk = (r.contentStart !== -1) ? doc.slice(r.contentStart, r.contentEnd) : '';
            const current = [...contentChunk.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m => this.xmlUnescape(m[1])).join('');
            const aliasM = s.match(/<w:alias w:val="([^"]*)"/);
            const label = this.FIELD_LABELS[idx] || (aliasM ? this.xmlUnescape(aliasM[1]) : ('Selection ' + idx));
            fields.push({
                idx: idx,
                kind: isDate ? 'date' : 'dropdown',
                label: label,
                options: items,
                value: current.trim()
            });
        }
        return fields;
    }

    // Replace the text shown inside content control #idx with `value`,
    // preserving the cell/paragraph/run formatting of the template.
    setSdtText(doc, idx, value) {
        const ranges = this.sdtRanges(doc);
        if (idx < 0 || idx >= ranges.length) return doc;
        const r = ranges[idx];
        if (r.contentStart === -1) return doc;
        let chunk = doc.slice(r.contentStart, r.contentEnd);
        const pM = chunk.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/);
        if (!pM) return doc;
        const p = pM[0];
        const pTag = (p.match(/^<w:p\b[^>]*>/) || ['<w:p>'])[0];
        const pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
        let rPr = (p.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/) || [null, ''])[1];
        rPr = rPr.replace(/<w:rStyle w:val="PlaceholderText"\/>/g, '');
        const newP = pTag + pPr + '<w:r>' + rPr + '<w:t xml:space="preserve">' + this.xmlEscape(value) + '</w:t></w:r></w:p>';
        chunk = chunk.replace(p, newP);
        doc = doc.slice(0, r.contentStart) + chunk + doc.slice(r.contentEnd);
        // drop the placeholder flag, exactly as Word does after a user picks a value
        const sdtHead = doc.slice(r.start, r.contentStart);
        if (sdtHead.indexOf('<w:showingPlcHdr/>') !== -1) {
            doc = doc.slice(0, r.start) + sdtHead.replace('<w:showingPlcHdr/>', '') + doc.slice(r.contentStart);
        }
        return doc;
    }

    // Write values into the cells that follow a label cell such as
    // "Property:" / "Address:" / "Owner / MGR:" / "Contact:". `values` is an
    // array filled into consecutive cells (street | city | state+zip, or
    // phone | email). Word may split a label like "Contact:" across several
    // runs, so match the label characters allowing any tags between them.
    fillRowCells(doc, label, values) {
        const vals = (Array.isArray(values) ? values : [values]).map(v => (v == null ? '' : String(v)));
        if (!vals.some(v => v !== '')) return doc;
        const pattern = label.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:<[^>]+>)*');
        const m = doc.match(new RegExp(pattern));
        if (!m) { console.log('Proposal: label cell not found ->', label); return doc; }
        const rowEnd = doc.indexOf('</w:tr>', doc.indexOf(m[0]));
        let cursor = doc.indexOf('</w:tc>', doc.indexOf(m[0]));
        for (const v of vals) {
            const nextCell = doc.indexOf('<w:tc>', cursor);
            if (nextCell === -1 || (rowEnd !== -1 && nextCell > rowEnd + 20000)) break;
            const pEnd = doc.indexOf('</w:p>', nextCell);
            if (pEnd === -1) break;
            if (v !== '') {
                const run = '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">' + this.xmlEscape(v) + '</w:t></w:r>';
                doc = doc.slice(0, pEnd) + run + doc.slice(pEnd);
                cursor = pEnd + run.length;
            } else {
                cursor = pEnd;
            }
        }
        return doc;
    }

    fillLabeledCell(doc, label, value) {
        return this.fillRowCells(doc, label, [value]);
    }

    // "street, city, ST 12345" -> [street, city, "ST 12345"] (same rules as
    // the Final Report address parser; falls back to the raw string).
    splitAddress(raw) {
        const flat = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!flat) return ['', '', ''];
        const cIdx = flat.indexOf(',');
        if (cIdx === -1) return [flat, '', ''];
        const street = flat.slice(0, cIdx).trim();
        const rest = flat.slice(cIdx + 1).trim();
        const m = rest.match(/^(.*?),?\s*([A-Z]{2})[.,]?\s*(\d{5})(?:-\d{4})?\s*$/);
        if (m) return [street, m[1].replace(/,\s*$/, '').trim(), m[2] + ' ' + m[3]];
        return [street, rest, ''];
    }

    getImageDims(buf, ext) {
        try {
            if (ext === 'png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
            let i = 2;
            while (i < buf.length - 9) {
                if (buf[i] !== 0xFF) { i++; continue; }
                const marker = buf[i + 1];
                if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
                }
                i += 2 + buf.readUInt16BE(i + 2);
            }
        } catch (e) { /* fall through */ }
        return { w: 900, h: 260 };
    }

    inlineImageXml(rid, cx, cy, id, name) {
        return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
            + '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
            + '<wp:docPr id="' + id + '" name="' + name + '"/>'
            + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
            + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            + '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr>'
            + '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
            + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    }

    ensureContentType(zip, ext) {
        const ctPath = '[Content_Types].xml';
        let ct = zip.file(ctPath).asText();
        if (ct.indexOf('Extension="' + ext + '"') === -1) {
            const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
            ct = ct.replace('</Types>', '<Default Extension="' + ext + '" ContentType="' + mime + '"/></Types>');
            zip.file(ctPath, ct);
        }
    }

    ensureImageRel(zip, relPath, rel, rid) {
        const f = zip.file(relPath);
        if (f) {
            let rels = f.asText();
            if (rels.indexOf(rid) === -1) rels = rels.replace('</Relationships>', rel + '</Relationships>');
            zip.file(relPath, rels);
        } else {
            zip.file(relPath, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + String.fromCharCode(10) + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rel + '</Relationships>');
        }
    }

    // Tenant logo into every header - logo only, 0.75in tall, compact spacing
    // (same geometry as the Final Report: 360 header offset + 1080 twips stays
    // inside this template's 1440-twip top margin, so pagination is unchanged).
    async injectTenantLogo(zip, companyIdentifier) {
        try {
            if (!companyIdentifier) return;
            const tenant = await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier);
            const logoUrl = tenant && tenant.icons && tenant.icons.header;
            if (!logoUrl) { console.log('Proposal: no Report Header image set in admin, header left as-is'); return; }
            const resp = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 60000 });
            const buf = Buffer.from(resp.data);
            const extMatch = logoUrl.split('?')[0].toLowerCase().match(/\.(png|jpe?g)$/);
            const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : 'png';
            const dims = this.getImageDims(buf, ext);
            const EMU = 914400;
            const cy = Math.round(0.75 * EMU);
            const cx = Math.max(1, Math.round(cy * dims.w / Math.max(1, dims.h)));
            zip.file('word/media/tenantlogo.' + ext, buf);
            this.ensureContentType(zip, ext);
            const content = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' + this.inlineImageXml('rIdTenantLogo', cx, cy, 990001, 'TenantLogo') + '</w:p>';
            const rel = '<Relationship Id="rIdTenantLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tenantlogo.' + ext + '"/>';
            let stamped = 0;
            for (const name of Object.keys(zip.files)) {
                const hm = name.match(/^word\/(header\d+)\.xml$/);
                if (!hm) continue;
                let header = zip.file(name).asText();
                const rootM = header.match(/<w:hdr[^>]*>/);
                const endI = header.lastIndexOf('</w:hdr>');
                if (!rootM || endI === -1) continue;
                header = header.slice(0, rootM.index + rootM[0].length) + content + header.slice(endI);
                zip.file(name, header);
                this.ensureImageRel(zip, 'word/_rels/' + hm[1] + '.xml.rels', rel, 'rIdTenantLogo');
                stamped++;
            }
            console.log('Proposal: Report Header image stamped in ' + stamped + ' header(s) for', companyIdentifier);
        } catch (e) {
            console.error('Proposal: tenant logo injection failed (document continues without it):', e.message);
        }
    }

    // Tenant footer image + footer text into every footer (Final Report rules).
    async injectTenantFooter(zip, companyIdentifier) {
        try {
            if (!companyIdentifier) return;
            const tenant = await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier);
            if (!tenant) return;
            const showLogo = tenant.showFooterlogo !== false;
            const footImgUrl = (showLogo && tenant.icons && tenant.icons.footer) || '';
            const ftext = this.xmlEscape(((tenant.footerText || '') + '').trim());
            if (!footImgUrl && !ftext) { console.log('Proposal: no footer branding set in admin, footer left as-is'); return; }
            let imgPara = '';
            let frel = '';
            if (footImgUrl) {
                const resp = await axios.get(footImgUrl, { responseType: 'arraybuffer', timeout: 60000 });
                const buf = Buffer.from(resp.data);
                const extMatch = footImgUrl.split('?')[0].toLowerCase().match(/\.(png|jpe?g)$/);
                const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : 'png';
                const dims = this.getImageDims(buf, ext);
                const EMU = 914400;
                const cy = Math.round(0.5 * EMU);
                const cx = Math.max(1, Math.round(cy * dims.w / Math.max(1, dims.h)));
                zip.file('word/media/tenantfooter.' + ext, buf);
                this.ensureContentType(zip, ext);
                frel = '<Relationship Id="rIdTenantFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tenantfooter.' + ext + '"/>';
                imgPara = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' + this.inlineImageXml('rIdTenantFooter', cx, cy, 990002, 'TenantFooter') + '</w:p>';
            }
            const content = imgPara
                + (ftext ? '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">' + ftext + '</w:t></w:r></w:p>' : '');
            let stamped = 0;
            for (const name of Object.keys(zip.files)) {
                const fm = name.match(/^word\/(footer\d+)\.xml$/);
                if (!fm) continue;
                let footer = zip.file(name).asText();
                const rootM = footer.match(/<w:ftr[^>]*>/);
                const endI = footer.lastIndexOf('</w:ftr>');
                if (!rootM || endI === -1) continue;
                footer = footer.slice(0, rootM.index + rootM[0].length) + content + footer.slice(endI);
                zip.file(name, footer);
                if (frel) this.ensureImageRel(zip, 'word/_rels/' + fm[1] + '.xml.rels', frel, 'rIdTenantFooter');
                stamped++;
            }
            console.log('Proposal: tenant footer stamped in ' + stamped + ' footer(s) for', companyIdentifier);
        } catch (e) {
            console.error('Proposal: footer injection failed (document continues):', e.message);
        }
    }

    // PROPERTY PHOTO (David, Oct 12 2026): the proposal's Satellite / Upload
    // photo, small and centred, in the empty spacer paragraph that already
    // follows the "Prepared for" table (Property / Address / Owner / Contact).
    // Using that existing paragraph instead of adding a new one keeps the
    // master's spacing, and the size cap (1.5in tall, never wider than 2.5in)
    // keeps it well inside the 6.5in text width. jpg/png only - detected from
    // the bytes, since uploads are all stored under a .jpg name. Phone photos
    // are turned upright first (Word ignores the EXIF orientation tag).
    async injectPropertyPhoto(zip, doc, url) {
        try {
            if (!url || !/^https?:/i.test(String(url))) return doc;
            const resp = await axios.get(String(url), { responseType: 'arraybuffer', timeout: 60000 });
            let buf = Buffer.from(resp.data);
            let ext = null;
            if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ext = 'png';
            else if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) ext = 'jpg';
            if (!ext) { console.log('Proposal: property photo is not jpg/png - left out'); return doc; }
            if (ext === 'jpg') {
                try {
                    const o = Number((require('exif-parser').create(buf).parse().tags || {}).Orientation || 1);
                    if (o && o !== 1) {
                        const Jimp = require('jimp');
                        const img = await new Promise((ok, bad) => Jimp.read(buf, (e, i) => (e ? bad(e) : ok(i))));
                        img.quality(88);
                        buf = await new Promise((ok, bad) => img.getBuffer(Jimp.MIME_JPEG, (e, b) => (e ? bad(e) : ok(b))));
                    }
                } catch (e) { /* keep the photo as stored */ }
            }
            // anchor: the end of the table that holds "Property:"
            const lm = doc.match(new RegExp('P(?:<[^>]+>)*r(?:<[^>]+>)*o(?:<[^>]+>)*p(?:<[^>]+>)*e(?:<[^>]+>)*r(?:<[^>]+>)*t(?:<[^>]+>)*y(?:<[^>]+>)*:'));
            if (!lm) { console.log('Proposal: Property table not found - photo left out'); return doc; }
            const tblEnd = doc.indexOf('</w:tbl>', lm.index);
            if (tblEnd === -1) return doc;
            const after = tblEnd + '</w:tbl>'.length;

            const dims = this.getImageDims(buf, ext);
            const EMU = 914400;
            const MAX_H = 1.5, MAX_W = 2.5;
            const ar = Math.max(1, dims.w) / Math.max(1, dims.h);
            let hIn = MAX_H, wIn = MAX_H * ar;
            if (wIn > MAX_W) { wIn = MAX_W; hIn = MAX_W / ar; }
            const cx = Math.round(wIn * EMU), cy = Math.round(hIn * EMU);

            zip.file('word/media/propertyphoto.' + ext, buf);
            this.ensureContentType(zip, ext);
            this.ensureImageRel(zip, 'word/_rels/document.xml.rels',
                '<Relationship Id="rIdPropertyPhoto" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/propertyphoto.' + ext + '"/>',
                'rIdPropertyPhoto');
            const run = this.inlineImageXml('rIdPropertyPhoto', cx, cy, 990003, 'PropertyPhoto');

            // The empty spacer paragraph right after the table: put the photo in it.
            const pm = doc.slice(after).match(/^\s*(<w:p\b[^>]*>)([\s\S]*?)<\/w:p>/);
            if (pm && pm[2].indexOf('<w:t') === -1 && pm[2].indexOf('<w:drawing') === -1) {
                const pStart = after + pm.index + pm[0].indexOf(pm[1]);
                const pEnd = after + pm.index + pm[0].length;
                let inner = pm[2];
                const pPrM = inner.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
                let pPr = pPrM ? pPrM[0] : '<w:pPr></w:pPr>';
                const rest = pPrM ? inner.replace(pPrM[0], '') : inner;
                // centre it; a little air above/below so it doesn't touch the table or heading
                pPr = pPr.replace(/<w:jc [^>]*\/>/g, '').replace(/<w:spacing [^>]*\/>/g, '');
                pPr = pPr.replace(/(<w:pPr>(?:<w:pStyle [^>]*\/>)?)/, '$1<w:keepNext/><w:spacing w:before="120" w:after="120"/><w:jc w:val="center"/>');
                doc = doc.slice(0, pStart) + pm[1] + pPr + rest + run + '</w:p>' + doc.slice(pEnd);
            } else {
                doc = doc.slice(0, after)
                    + '<w:p><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="120"/><w:jc w:val="center"/></w:pPr>' + run + '</w:p>'
                    + doc.slice(after);
            }
            console.log('Proposal: property photo placed (' + wIn.toFixed(2) + 'in x ' + hIn.toFixed(2) + 'in)');
        } catch (e) {
            console.error('Proposal: property photo skipped (document continues):', e.message);
        }
        return doc;
    }

    // Fill the template with the web form's values.
    // form = { property, address, ownerMgr, contact, values: { "<sdtIndex>": "text", ... } }
    async fillProposal(templateBuffer, companyIdentifier, form) {
        const zip = new PizZip(templateBuffer);
        let doc = zip.file('word/document.xml').asText();

        const values = (form && form.values) || {};
        // Fill from the highest index down so earlier replacements cannot
        // shift the byte offsets of controls not yet processed.
        const idxs = Object.keys(values).map(Number).filter(n => !isNaN(n)).sort((a, b) => b - a);
        for (const idx of idxs) {
            const v = values[String(idx)];
            if (v == null || v === '') continue;
            doc = this.setSdtText(doc, idx, String(v));
        }

        doc = this.fillLabeledCell(doc, 'Property:', form && form.property);
        // Address spans three cells: street | city | state + zip
        const addrParts = (form && (form.addressStreet || form.addressCity || form.addressStateZip))
            ? [form.addressStreet || '', form.addressCity || '', form.addressStateZip || '']
            : this.splitAddress(form && form.address);
        doc = this.fillRowCells(doc, 'Address:', addrParts);
        doc = this.fillLabeledCell(doc, 'Owner / MGR:', form && form.ownerMgr);
        // Contact splits into two cells: phone | email
        const cPhone = (form && (form.contactPhone || form.contact)) || '';
        const cEmail = (form && form.contactEmail) || '';
        doc = this.fillRowCells(doc, 'tact:', [cPhone, cEmail]);

        // Property photo under the "Prepared for" table (Oct 12 2026)
        if (form && form.propertyPhoto) doc = await this.injectPropertyPhoto(zip, doc, form.propertyPhoto);

        // CLIENT company name + phone from the Admin panel wherever the master
        // says "Deck Inspectors" (identical rules to the Final Report).
        try {
            const tenantRec = companyIdentifier ? await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier) : null;
            if (tenantRec && tenantRec.name) {
                // Strip trailing period(s) from the tenant name: the template
                // supplies its own sentence punctuation ("Deck Inspectors Inc.."
                // fix, seen on the first live generation).
                const cname = this.xmlEscape(String(tenantRec.name).trim().replace(/\.+$/, ''));
                doc = doc.split('Deck Inspectors, Inc.').join('%%CNAME%%');
                doc = doc.split('Deck Inspectors Inc').join('%%CNAME%%');
                doc = doc.split('Deck Inspectors').join('%%CNAME%%');
                if (/\.$/.test(cname)) { doc = doc.replace(/%%CNAME%%((?:<[^>]+>)*)\s*\./g, '%%CNAME%%$1'); }
                doc = doc.split('%%CNAME%%').join(cname);
                console.log('Proposal: company name substituted ->', tenantRec.name);
            }
            if (tenantRec && tenantRec.phone) {
                doc = doc.split('888-224-0489').join(this.xmlEscape(tenantRec.phone));
            }
        } catch (e) { console.log('Proposal: company substitution failed', e.message); }

        // 0.25in header/footer clearance, same as the Final Report.
        doc = doc.replace(/(<w:pgMar[^>]*?w:header=")\d+(")/g, '$1360$2');
        doc = doc.replace(/(<w:pgMar[^>]*?w:footer=")\d+(")/g, '$1360$2');

        zip.file('word/document.xml', doc);
        await this.injectTenantLogo(zip, companyIdentifier);
        await this.injectTenantFooter(zip, companyIdentifier);
        return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    async generateBuffer(companyIdentifier, form) {
        const templateBuffer = await this.getTemplateBuffer(companyIdentifier);
        return this.fillProposal(templateBuffer, companyIdentifier, form);
    }

    // Branding info for the on-line (print/PDF) rendering in the web app.
    async getBranding(companyIdentifier) {
        const tenant = await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier);
        if (!tenant) return {};
        return {
            name: tenant.name || '',
            phone: tenant.phone || '',
            website: tenant.website || '',
            footerText: tenant.footerText || '',
            headerLogo: (tenant.icons && tenant.icons.header) || '',
            footerLogo: (tenant.showFooterlogo !== false && tenant.icons && tenant.icons.footer) || '',
        };
    }
}

module.exports = new ProposalGenerator();
