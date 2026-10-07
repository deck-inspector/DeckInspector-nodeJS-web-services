#!/usr/bin/env python3
"""Merge docx files into one using docxcompose.

Usage: python3 merge_docx.py <host.docx> <annex1.docx> [<annex2.docx> ...] <output.docx>
First arg is the host, LAST arg is the output, everything between is appended
in order. The original 3-arg form (host annex output) still works unchanged.

Every appended annex is preceded by an explicit PAGE BREAK so merged pieces
never run together on the same page (David, Aug 1: the Visual report's cover
page flowed straight into the first section because docxcompose appends
content with no break; "Pages CANNOT run together"). Each piece - cover,
building, location, section chunk, and the Visual annex of a Final report -
starts at the top of its own page.

Exit code 0 on success; non-zero with message on stderr otherwise.
"""
import sys

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _is_empty_para(el):
    """An empty paragraph: no text, no picture, no break, no section break."""
    if el.tag != W + "p":
        return False
    if el.findall(".//" + W + "t") and "".join((t.text or "") for t in el.iter(W + "t")).strip():
        return False
    for tag in ("drawing", "pict", "object", "br", "sectPr", "fldChar", "instrText", "sdt"):
        if el.findall(".//" + W + tag):
            return False
    return True


def _strip_trailing_empty(body):
    """Remove empty paragraphs at the end of the body (bookmark ends in between are kept).
    BLANK PAGES (David, Oct 6 2026: "an empty sheet ... in every report"): each merged
    piece ends with 1-2 empty paragraphs; when the piece fills its page (cover photo,
    photo grid) those paragraphs and the old page-break paragraph spill onto a page of
    their own, which then breaks again - leaving a blank page."""
    kids = [k for k in body if k.tag != W + "sectPr"]
    for el in reversed(kids):
        if el.tag in (W + "bookmarkEnd", W + "bookmarkStart"):
            continue
        if _is_empty_para(el):
            body.remove(el)
            continue
        break


def _break_para(master):
    """A 1-pt paragraph with 'page break before': it starts the next piece on a new page
    and, unlike a page-break RUN, can never produce an empty page of its own."""
    from docx.oxml import parse_xml
    return parse_xml(
        '<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:pPr><w:pageBreakBefore/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>'
        '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>')


def _append_to_body(master, el):
    body = master.element.body
    sect = body.find(W + "sectPr")
    if sect is not None:
        sect.addprevious(el)
    else:
        body.append(el)


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: merge_docx.py host annex1 [annex2 ...] output\n")
        return 2
    host_path = sys.argv[1]
    out_path = sys.argv[-1]
    annex_paths = sys.argv[2:-1]
    from docxcompose.composer import Composer
    from docx import Document
    master = Document(host_path)
    composer = Composer(master)
    body = master.element.body
    for annex_path in annex_paths:
        # Each appended annex starts on a fresh page (no trailing empties, then a
        # page-break-before paragraph instead of a page-break run).
        _strip_trailing_empty(body)
        _append_to_body(master, _break_para(master))
        composer.append(Document(annex_path))
    # end of document: no trailing empty paragraphs (a final blank page); Word needs a
    # paragraph after a closing table, so keep one tiny one in that case.
    _strip_trailing_empty(body)
    kids = [k for k in body if k.tag != W + "sectPr"]
    if kids and kids[-1].tag == W + "tbl":
        from docx.oxml import parse_xml
        _append_to_body(master, parse_xml(
            '<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>'
            '<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr></w:p>'))
    composer.save(out_path)
    print("merged ok (%d annexes, each on its own page, no blank pages)" % len(annex_paths))
    return 0


if __name__ == "__main__":
    sys.exit(main())
