# Medical Q-Bank — MBBS Final Year Study App

A static, framework-free web app (HTML + CSS + JS) for studying from the
MBBS Final Year Master Question Bank. Browse, filter, track per-question
progress, and sync your progress to GitHub so it follows you across devices.

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | Single-page app shell (7 tabs) |
| `app.js` | All app logic (data, filters, charts, progress, GitHub sync) |
| `paperstyle.css` | Base newspaper/academic theme |
| `style.css` | Component styles, dark mode, responsive layout |
| `questions_output.json` | The question bank (generated from the Excel file) |
| `user_progress.json` | Empty progress template (local fallback reference) |
| `generate_json_from_excel.js` | Node script to regenerate the JSON from the Excel |

## Run locally

The app fetches `questions_output.json` via a relative URL, so open it through
a local web server (not `file://`):

```bash
cd medical-qbank
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a new public repository, e.g. `medical-qbank`.
2. Copy **all** files in this folder into the repo root and commit:
   ```bash
   git init
   git add .
   git commit -m "Medical Q-Bank app"
   git branch -M main
   git remote add origin https://github.com/<your-username>/medical-qbank.git
   git push -u origin main
   ```
3. In the repo: **Settings → Pages → Build and deployment → Source = Deploy from a branch**.
   Set **Branch = `main`** and **folder = `/ (root)`**, then Save.
4. Wait ~1 minute. Your site goes live at
   `https://<your-username>.github.io/medical-qbank/`.

## Enable progress sync to GitHub

Progress (which questions you've marked "Done") is saved to a **separate
branch** in the same repo (default `progress-data`), so ticking boxes never
triggers a Pages rebuild.

1. Create a **fine-grained Personal Access Token**:
   GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
   - Repository access: **Only select repositories → `medical-qbank`**
   - Permissions → Repository permissions → **Contents: Read and write**
   - Generate and copy the token (`github_pat_...`).
2. In the app, open the **Settings** tab and enter:
   - **Repo Owner** = your GitHub username
   - **Repo Name** = `medical-qbank`
   - **Progress Branch** = `progress-data` (created automatically on first save)
   - **Progress File Path** = `user_progress.json`
   - **Token** = the PAT from step 1
3. Click **Save Settings**, then **Test Connection**.
4. On first save the app auto-creates the `progress-data` branch from `main`.
   After that, progress auto-commits ~3 s after each change (debounced), and is
   pulled from GitHub on every page load.

> **Security:** the token is stored only in your browser's `localStorage`.
> Use a fine-grained token scoped to this one repo. Do **not** put the token in
> any committed file. Anyone with access to your browser can read it.

## Backup / restore

In **Settings**: **Backup** downloads your progress as a JSON file;
**Restore from file** loads a backup. **Clear All Progress** wipes done-state
(and syncs the wipe to GitHub).

## Regenerate the question bank from Excel

If you update `Master_Question_Bank_v4_Progress.xlsx`, regenerate the JSON:

```bash
npm install xlsx
node generate_json_from_excel.js Master_Question_Bank_v4_Progress.xlsx questions_output.json
```

Then commit the new `questions_output.json` to `main` — the live site updates
on the next Pages build.

## Data notes

- 2,003 questions across 8 subjects (ENT, Ophthalmology, General Medicine,
  Obstetrics & Gynaecology, Pediatrics, General Surgery, Orthopaedics, General).
- Mostly essay/long-answer questions (LAQ/SAQ/Short-note/Case); 40 MCQs include
  inline options and answers in the question text.
- **Importance** = stars (★/★★/★★★). The **IMP Questions** tab shows ★★ and ★★★.
- **Institution** = the `Sources` field (University Exam, PDU, MPS, SMC, CUS, PYQ).
- A **2026** flag marks questions flagged for the March 2026 exam.
