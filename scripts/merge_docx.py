#!/usr/bin/env python3
"""Merge two docx files (host + annex) into one using docxcompose.

Usage: python3 merge_docx.py <host.docx> <annex.docx> <output.docx>
Exit code 0 on success; non-zero with message on stderr otherwise.
"""
import sys

def main():
    if len(sys.argv) != 4:
        sys.stderr.write("usage: merge_docx.py host annex output\n")
        return 2
    host_path, annex_path, out_path = sys.argv[1:4]
    from docxcompose.composer import Composer
    from docx import Document
    master = Document(host_path)
    composer = Composer(master)
    composer.append(Document(annex_path))
    composer.save(out_path)
    print("merged ok")
    return 0

if __name__ == "__main__":
    sys.exit(main())
