# PDF Citation Hover (Microsoft Edge extension)

This extension replaces Edge's PDF viewer with a look-alike that has the same toolbar, icons and sidebar.
It adds one feature: hover over a citation and a card shows the cited paper's title.
Click the title to search for it on Google Scholar.

The PDF keeps its own address in the address bar, for web PDFs and local files alike.

## Install

1. Open `edge://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this `pdf-citation-hover` folder.
3. Click **Details** on the extension and turn on **Allow access to file URLs** (needed for PDFs on your computer).
4. To make **Save** write back to the original file, install the save helper once (requires Python 3):

   ```powershell
   powershell -ExecutionPolicy Bypass -File save-helper\install.ps1
   ```

   To remove it: `powershell -ExecutionPolicy Bypass -File save-helper\uninstall.ps1`.
   If you move this folder, run `install.ps1` again.

After you change any files, click **Reload** on the extension's card in `edge://extensions`.

## Toolbar

| Button | What it does |
| --- | --- |
| ☰ Contents | Sidebar with table of contents (current section is outlined) and page thumbnails; slides in over the pages without moving them |
| Highlight ▾, Draw ▾, Erase, Add text ▾ | Annotate; ▾ picks color and size; Esc leaves a tool |
| Read aloud | Reads from the current page (Ctrl+Shift+U); click again to stop |
| − + | Zoom (also Ctrl + mouse wheel, Ctrl +/−/0) |
| Fit | Switch between fit to width and fit to page (Ctrl+\\) |
| Page box | Type a page number |
| Rotate | Rotate pages (Ctrl+] / Ctrl+[) |
| Page view | One page / two pages / cover page shown separately / continuous scrolling |
| Search | Find text (Ctrl+F, F3) |
| Print | Print, including your annotations (Ctrl+P) |
| Save | Save annotations into the PDF (Ctrl+S); greyed out on local files until you change something |
| Save as | Save to a new file (Ctrl+Shift+S) |
| Full screen | Enter or leave full screen |
| Settings | Save as, download the original, zoom presets, open in Edge's built-in viewer, document properties |
| Pin | Pinned: toolbar always shown. Unpinned: it hides while you scroll down and returns when you scroll up or move the mouse to the top |

## Saving

Unsaved changes are shown like in Edge: the tab title starts with `*` and the tab icon changes.


| PDF | Save | Save as |
| --- | --- | --- |
| Local file, helper installed | Overwrites the original file | Windows "Save as" dialog |
| Web PDF, helper installed | Windows "Save as" dialog (then Save reuses that file) | Windows "Save as" dialog |
| Helper not installed | Downloads a copy to Downloads | Downloads a copy |

Browsers don't let extensions write files, so the helper (`save-helper/pdf_save_host.py`)
does the writing through Edge's native messaging. It accepts requests only from this
extension. It only writes `.pdf` files with real PDF content. Save without a dialog only
overwrites a file that already exists.

## How it works

When Edge starts to show a PDF, `content.js` replaces the page with `viewer.html` in a
full-page frame, so the address stays the same. The viewer is built on Mozilla's PDF.js
(in `lib/`). Edge's own viewer can't be reused, because extensions are not allowed to
access or modify it.

On hover, `citations.js` follows the citation link to its target in the bibliography,
reads the reference text there, and extracts the title.

Icons come from Microsoft's Fluent UI System Icons (MIT license), the icon set Edge uses.

## Limitations

- Citation titles need clickable citation links in the PDF. Most LaTeX/arXiv papers have them; some publisher PDFs and scanned PDFs don't.
- Title extraction covers the common styles (ACL/natbib, NeurIPS, IEEE, APA, Springer). Unusual formats show the raw reference text instead.
- Edge-only features (Ask Copilot, Translate, Edit with Acrobat) are not included.
