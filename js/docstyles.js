"use strict";

/* Styles of the document layout (estimate, invoice, signature documents): used on screen for the
   PDF and printing, and sent with documents to the signing page. Kept here (not in styles.css) so
   they can be read as text anywhere. */
const DOC_CSS = `
.pv{color:#111}
.pv-header{display:flex;justify-content:space-between;gap:20px;border-bottom:3px solid #111827;padding-bottom:14px;margin-bottom:16px}
.pv-company{font-size:22px;font-weight:800}
.pv-muted{color:#555;font-size:11px}
.pv-title{text-align:right}
.pv-doc{font-size:22px;font-weight:800;letter-spacing:.12em;color:#2563eb}
.pv-meta{margin-left:auto;font-size:12px}
.pv-meta td{padding:2px 0 2px 14px}
.pv-meta td:first-child{color:#555}
.pv-parties{display:flex;gap:40px;margin-bottom:18px}
.pv-parties h4{margin:0 0 4px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#555}
.pv-section{margin-bottom:14px;break-inside:avoid}
.pv-section h3{font-size:12px;letter-spacing:.1em;margin:0 0 6px;color:#111}
.pv-table{width:100%;border-collapse:collapse;table-layout:fixed}
.pv-table th:nth-child(2){width:14%}
.pv-table th:nth-child(3),.pv-table th:nth-child(4){width:17%}
.pv-table th{font-size:10px;text-transform:uppercase;color:#555;text-align:left;border-bottom:1.5px solid #111;padding:5px 6px}
.pv-table td{padding:6px;border-bottom:1px solid #ddd;vertical-align:top}
.pv-table tfoot td{font-weight:700;border-bottom:0}
.pv-table .num{text-align:right;white-space:nowrap}
.pv-desc{font-size:10px;color:#666}
.pv-totals{margin-left:auto;margin-top:10px;border-collapse:collapse;min-width:260px;break-inside:avoid}
.pv-totals td{padding:5px 6px}
.pv-totals .num{text-align:right}
.pv-grand td{font-size:16px;font-weight:800;border-top:2px solid #111;padding-top:8px}
.pv-terms{margin-top:22px;padding-top:12px;border-top:1px solid #ddd;font-size:10.5px;line-height:1.45;color:#222}
.pv-terms h3{font-size:11px;letter-spacing:.1em;margin:0 0 6px}
.pv-terms-text{white-space:pre-wrap}
.pv-terms + .pv-footer{margin-top:10px;break-before:avoid}
.pv-footer{margin-top:28px;padding-top:10px;border-top:1px solid #ddd;color:#555;font-size:11px;text-align:center}
.pv-sign-text{margin-top:18px;padding-top:12px;border-top:1px solid #ddd;font-size:12px;line-height:1.5;color:#111}
.pv-sign-text h3{font-size:13px;letter-spacing:.08em;margin:0 0 8px}
.pv-sign-text p{margin:0 0 8px}
.pv-signature{margin-top:22px;padding-top:12px;border-top:2px solid #111;font-size:12px;break-inside:avoid}
.pv-signature h3{font-size:12px;letter-spacing:.1em;margin:0 0 6px}
.pv-signature img{max-width:300px;max-height:110px;display:block;border-bottom:1px solid #111;margin-bottom:4px}
.pv-audit{margin-top:8px;border-collapse:collapse;font-size:10px;color:#333}
.pv-audit td{padding:2px 10px 2px 0;vertical-align:top;word-break:break-all}
.pv-audit td:first-child{color:#666;white-space:nowrap;word-break:normal}
.pv-message{margin:14px 0;padding:10px 12px;border-left:3px solid #2563eb;background:#f8fafc;white-space:pre-wrap}
`;

(function(){
  const style=document.createElement("style");
  style.id="docStyles";
  style.textContent=DOC_CSS;
  document.head.appendChild(style);
})();
