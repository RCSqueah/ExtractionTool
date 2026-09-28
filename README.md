# Expense Parser — Xero Export

A browser tool that turns client expense documents (expense templates `.xlsx`, Outlook `.msg` emails, chambers bill PDFs/scans, bank statement CSVs, or pasted email text) into a Xero-ready CSV (Bills or Bank Statement format).

Features include a per-client chart of accounts learned from a Xero export, remembered coding history shared across the team, a use-of-home calculator, business-use % adjustments, row merging, and supplier VAT overrides.

## How it's built

It runs on **Cloudflare Pages** (the free tier is enough for a small team):

| Piece | File | What it does |
|---|---|---|
| The page | `public/index.html` | The tool itself |
| Runtime shim | `public/runtime.js` | Connects the page to the server below (the page was originally a Claude artifact) |
| AI | `functions/api/ai.js` | Sends documents to Claude using **your** Anthropic API key, kept on the server |
| Storage | `functions/api/db/[[path]].js` | Saves the client list, charts of accounts, coding history and notes in Cloudflare KV |
| Login | `functions/_middleware.js` | Password-protects the whole site |

### Settings

In the Cloudflare dashboard, open your project and go to **Settings → Variables and Secrets**:

| Name | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes, as a **Secret** | Your key from console.anthropic.com |
| `APP_PASSWORD` | Yes, as a **Secret** | The team password. The site stays locked until this is set |
| `CLAUDE_MODEL` | No | Which Claude model to use. Defaults to `claude-opus-5`. **When a model is retired, change this value. No code change is needed.** |

## One-time setup

1. **Anthropic API key**: sign in at <https://console.anthropic.com>, add billing, then go to **API Keys → Create Key**. Copy the key.
2. **Cloudflare account**: sign up for free at <https://dash.cloudflare.com>.
3. **Create the storage**: go to **Storage & Databases → KV → Create** and name it `expense-parser-db`.
4. **Create the site**: go to **Workers & Pages → Create → Pages → Connect to Git**, pick `RCSqueah/ExtractionTool`, then set:
   - Production branch: `main`
   - Build command: `npm install`
   - Build output directory: `public`
5. **Add the settings**: in the new project, open **Settings → Variables and Secrets**. Add `ANTHROPIC_API_KEY` and `APP_PASSWORD` as secrets, plus `CLAUDE_MODEL` if you want a model other than the default.
6. **Connect the storage**: go to **Settings → Bindings → Add → KV namespace**. Set the variable name to `EXPENSES_DB` and pick `expense-parser-db`.
7. **Redeploy**: go to **Deployments** and choose **⋯ → Retry deployment** on the latest one so the settings take effect.
8. **Open the site**: go to the `*.pages.dev` address Cloudflare gives you. Sign in with any username and the `APP_PASSWORD`.

After this, every push to `main` redeploys automatically.

## Running locally (optional, for developers)

```bash
npm install
printf 'APP_PASSWORD=devpw\nANTHROPIC_API_KEY=sk-ant-...\n' > .dev.vars
npm run dev    # http://localhost:8788
```

## Notes

- **Cost**: you pay Anthropic per request. A typical document or email costs a few pence on the default model. You can set a cheaper model, such as `claude-sonnet-5`, in `CLAUDE_MODEL`.
- **Storage**: each save overwrites the whole client record. If two people change the same client's history at the same moment, the later save wins, as in the original artifact.
- **Live Xero lookup** ("Check Xero history") is still disabled. Uploading a Xero export file in Step 1 does the same job.
