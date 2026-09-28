# Expense Parser — Xero Export

A browser tool that turns client expense documents (expense templates `.xlsx`, Outlook `.msg` emails, chambers bill PDFs/scans, bank statement CSVs, or pasted email text) into a Xero-ready CSV (Bills or Bank Statement format).

Features include a per-client chart of accounts learned from a Xero export, remembered coding history, a use-of-home calculator, business-use % adjustments, row merging, and supplier VAT overrides.

## How it works

It is a single web page with no server, hosted free on **GitHub Pages**. It's built for **one user**:

- **AI**: the page sends documents straight from your browser to Claude, using **your own Anthropic API key**. You enter the key once in **⚙ Settings**, and it's stored only in that browser.
- **Model**: also set in **⚙ Settings**, defaulting to `claude-opus-5`. If a model is retired, the tool tells you, and you type the new model's name there. No code change is needed.
- **Client data**: client lists, charts of accounts, coding history and notes are saved in your browser. Use **⚙ Settings → Back up client data** now and then, because clearing browser data deletes them. **Restore from backup** brings them back, or moves them to another computer or browser.

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

- **Privacy**: documents go directly from your browser to Anthropic and nowhere else. Your key is never in the code or on GitHub. Anyone else who opens the site won't have a key, so they can't use your credit or see your data.
- **Cost**: you pay Anthropic per request. A typical document or email costs a few pence on the default model. A cheaper model, such as `claude-sonnet-5`, can be set in Settings.
- **Private repositories**: GitHub Pages on a private repo needs a paid GitHub plan. The site itself holds no client data or keys, so a public repo is fine.
- **Live Xero lookup** ("Check Xero history") is still disabled. Uploading a Xero export file in Step 1 does the same job.
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
