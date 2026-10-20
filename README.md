# Extraction Tool — Xero Export

A browser tool that turns a client's documents (expense templates and lists, bank statements as CSV or PDF, bills and receipts, emails, their own notes, and their sales invoices) into Xero-ready CSVs: Bills, Bank Statement or Sales Invoices.

Features include a per-client chart of accounts learned from a Xero export, remembered coding history, a use-of-home calculator, business-use % adjustments, row merging, and supplier VAT overrides.

## How it works

It is a single web page with no server, hosted free on **GitHub Pages**. It's built for **one user**:

- **AI**: the page sends documents straight from your browser to Claude, using **your own Anthropic API key**. You enter the key once in **⚙ Settings**, and it's stored only in that browser.
- **Model**: also set in **⚙ Settings**, defaulting to `claude-sonnet-5`. For harder documents, such as messy scans or handwriting, `claude-opus-5` is more capable but costs about 2.5 times as much. If a model is retired, the tool tells you, and you type the new model's name there. No code change is needed.
- **What it reads**: in step ②, drop in any mix of:
  - the firm's expense template (.xlsx);
  - the Self Assessment template (.xlsx with Income and Expenses sheets). Every line is read as typed, dates such as `8.04` become 8 April in the sheet's "Year End" tax year, and Claude only chooses the account;
  - bank statements and transaction lists (.csv or .xlsx). These are read line by line, and the Description and amount come from the file;
  - bank statement PDFs with text in columns (e.g. Starling's monthly statement). Each line is read exactly as printed, amounts are put in or out by their column, and the totals are checked against the statement's own summary;
  - chambers bills and receipts (PDF, PNG, JPG);
  - emails (.msg or .eml) or pasted email text;
  - the client's own sales invoices, e.g. sent by email. Each invoice is read once by its number, even if it's repeated in a reply chain or another email. The lines are kept as printed, the totals are checked, and the invoices go to their own **Sales Invoices CSV**. Their payments on the bank statement are left uncoded, with the invoice number as the reference, so you match them to the invoices in Xero instead of counting the sale twice. Invoices already exported for the client are left out next time;
  - a client's own notes or year summaries (.odt, .docx, .txt, or a spreadsheet list). Claude reads these, and each Description is the client's own wording, checked against the document.

  Step ① takes last year's Xero Account Transactions export, plus Xero's Chart of Accounts export (.csv) if the transactions export has no account codes; one **Process everything** press reads both. It also picks out last year's business-use adjustments (e.g. "Motor expenses 60% business use", "Use of Home 1 of 4 rooms") and shows them under the client for reference.
- **Client data**: client lists, charts of accounts, coding history and notes are saved in your browser. Use **⚙ Settings → Back up client data** now and then, because clearing browser data deletes them. **Restore from backup** brings them back, or moves them to another computer or browser.
- **Shared client data (password-protected)**: ⚙ Settings → **Create encrypted copy** scrambles the client data in this browser with a password you choose, into `client-data.enc.json`. Upload that file to the `docs` folder here on GitHub. Any browser that then opens the site asks for the password once and loads the data. The file on GitHub is unreadable without the password, which is never stored anywhere. Use four or five random words. If the password is forgotten, the shared copy can't be opened, but each browser's own copy and your backups are unaffected. To publish changes, create a new encrypted copy and upload it over the old one.

| File | What it does |
|---|---|
| `docs/index.html` | The tool itself |
| `docs/runtime.js` | Connects the page to Claude and browser storage, plus the Settings panel (the page was originally a Claude artifact) |
| `docs/vendor/anthropic-sdk-*.js` | A bundled copy of Anthropic's official JavaScript SDK |

## One-time setup

1. **Get an Anthropic API key**: sign in at <https://console.anthropic.com>, add billing, then go to **API Keys → Create Key**. Copy the key.
2. **Turn on GitHub Pages**: in this repo on GitHub, go to **Settings → Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **`main`**, and Folder to **`/docs`**. Click **Save**.
3. **Open the site**: after a minute or two, the Pages settings show your address, for example `https://rcsqueah.github.io/ExtractionTool/`. Open it.
4. **Add your key**: click **⚙ SETTINGS** at the top right, paste the key, and click **Save**.

After this, every change merged into `main` goes live automatically.

## Notes

- **Privacy**: documents go directly from your browser to Anthropic and nowhere else. This repo is public, so client details are only ever published encrypted (see above). Your key is never in the code or on GitHub. Anyone else who opens the site won't have a key, so they can't use your credit or see your data.
- **Cost**: you pay Anthropic per request. A typical document or email costs a penny or two on the default model (`claude-sonnet-5`); a year's bank statement roughly 10–15p.
- **Private repositories**: GitHub Pages on a private repo needs a paid GitHub plan. The site itself holds no client data or keys, so a public repo is fine.
- **Live Xero lookup** ("Check Xero history") is hidden until it can be rebuilt. Uploading a Xero export file in Step 1 does the same job.
- **Moving to a team setup later**: a shared version needs a server for the API key and a shared database. An earlier revision of pull request #1 has a Cloudflare version to start from.

## Updating the SDK (developers)

The SDK is bundled so the site doesn't depend on a third-party CDN. To update it:

```bash
npm i @anthropic-ai/sdk@<version> esbuild
echo "export { default } from '@anthropic-ai/sdk';" > entry.js
npx esbuild entry.js --bundle --format=esm --minify --platform=browser --legal-comments=eof \
  --outfile=docs/vendor/anthropic-sdk-<version>.js
```

Then update `SDK_URL` in `docs/runtime.js` and delete the old file.
