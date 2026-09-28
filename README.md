# Expense Parser — Xero Export

A single-page browser tool that turns client expense documents (expense templates `.xlsx`, Outlook `.msg` emails, chambers bill PDFs/scans, bank statement CSVs, or pasted email text) into a Xero-ready CSV (Bills or Bank Statement format).

Features include per-client chart of accounts learned from a Xero export, remembered coding history, use-of-home business-proportion calculator, business-use % adjustments, row merging, and supplier VAT overrides.

## Running

Open `index.html` in a browser. Everything else lives in that one file, apart from SheetJS (loaded from cdnjs) and Google Fonts.

> **Note:** This page was originally built as a Claude Artifact. AI extraction, shared per-client storage and the live Xero lookup rely on the Claude Artifact runtime (`window.claude`). They are only available when the page runs as an Artifact on claude.ai. Opened as a plain file, the page still loads, but those features will not work.
