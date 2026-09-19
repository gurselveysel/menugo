# Local PDF menu preparation (r30)

This increment closes the missing browser PDF-to-image preparation step; it does not claim live AI output acceptance. Existing company-only provider credentials, free-only routing, customer/role boundaries and financial operations are unchanged.

## Behaviour

In the authorized AI Menu Studio, select a PDF (10 MB, up to 8 pages). PDF.js 6.3.289 renders pages on device with bounded output dimensions, per-page/total encoded size, sequential rendering, timeout and cancellation. Parser worker, fonts, CMaps and WASM ship from the application origin, not a third-party CDN. No JavaScript/XFA or interactive viewer is executed, and no OCR request is made. Select pages explicitly and compare readability before transfer. Local preparation/download remains available without AI credentials.

After explicit review, selected pages are uploaded as individual JPEG source jobs through the existing authorized, content-hashed, idempotent `/api/ai-menu/upload` command. Each page may consume one analysis quota, preserves its original PDF page in the filename, and has a separate review/apply/undo flow. Unselected pages never leave the device. This is intentionally NOT a single combined multi-page extraction or hidden page truncation. The original PDF is not archived by this flow; selected rendered source images use existing 30-day source retention.

Successful pages are not resent. Unknown responses stop the batch; manual retry retains the exact operation ID and bytes while the component is mounted. Do not treat HTTP timeout as an unapplied job. Browser close/unmount interrupts further submissions, not a server request already sent; inspect import history after re-opening. Content-based duplicate protection remains in the server. No automatic retry, paid fallback, catalogue mutation, order or social message is introduced.

## Verification boundaries

Real PDF.js and actual canvas pixels are exercised with synthetic PDFs (page color/rotation, corruption, page limit, local-only preparation). API mocks exercise explicit selection, unchanged idempotency retry and no-provider gating. Existing menu review/apply/undo regression also runs. Physical mobile/browser PDF compatibility and representative live AI extraction remain separate acceptance steps. Complex/interactive forms may not render like the authoring app; source review is mandatory.

Upstream: https://github.com/mozilla/pdf.js/releases/tag/v6.3.289 and https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html . No new paid services are provisioned.
