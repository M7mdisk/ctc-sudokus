# Cryptic Library

A browse-and-play index of every puzzle from
[Cracking the Cryptic](https://crackingthecryptic.com/sudokus) — installed as a
progressive web app and refreshed automatically.

**Live:** https://m7mdisk.github.io/ctc-sudokus/

## What it does

- **All ~3,500 puzzles** in one searchable list: title, setter, publish date,
  whether Simon or Mark solved it on the channel, the site's own difficulty
  rating, and inferred constraint tags (fog, thermo, arrow, killer, whisper, …).
- **Filters** by constraint, setter, difficulty (easy / medium / hard / very
  hard) and play state (new / unplayed / in progress / solved / favourites),
  plus sort by date, name or setter.
- **Play** without leaving the app: each puzzle opens in an embedded
  SudokuPad player (the same engine the official site uses), with the rules
  text and links to the original page and the video solve.
- **Installable PWA**: home-screen icon, offline app shell and cached index,
  deep links (`#/p/3522`), dark/light theme.
- **Local state only**: favourites, solved marks and history live in
  `localStorage`. No accounts, no analytics, no backend.
- **Stays fresh**: a scheduled GitHub Action re-scrapes the index daily and
  commits only when something changed.

## How it works

```
scripts/scrape.py  ->                       data/puzzles.json      index (id, date, name, setter, variant, solver, pad id, tags, difficulty)
                       data/rules.json        rules text per puzzle, fetched lazily by the player
                       data/progress.json     which puzzle pages have been read (keeps daily runs to 1 request)
index.html app.js styles.css sw.js manifest.webmanifest icons/
```

`scrape.py` is stdlib-only Python: it reads the ordered puzzle list from
`/sudokus`, then fetches each `/sudoku?id=N` page once for the setter, app
variant, SudokuPad id and rules. Difficulty comes from the site's own rating —
four requests to `/filter?difficultyfilter=…`, one per level, which covers every
rated puzzle at once (three puzzles have no rating). Runs are incremental — a
daily refresh costs six HTTP requests when nothing has been published.

`scripts/refresh.sh` does the daily scrape + commit; `scripts/github-workflow.yml` is the
same thing packaged for GitHub Actions. GitHub Pages serves `main` from the
repository root.

## Refresh automation

Two interchangeable options, both idempotent and silent when nothing changed:

**A. Scheduled job on a host (what is running now)**

```bash
./scripts/refresh.sh        # scrape -> commit -> push if data changed
```

Wired to a daily scheduler (cron / Hermes cron). Costs two HTTP requests a day
when nothing new is published, and prints a one-line digest when a puzzle
appears.

**B. GitHub Actions (no host needed)**

`scripts/github-workflow.yml` is a ready-made workflow — daily at 06:17 UTC,
plus a manual `--full` backfill input, with a sanity check that fails the run if
the puzzle count collapses or a row is malformed. Install it with:

```bash
mkdir -p .github/workflows && cp scripts/github-workflow.yml .github/workflows/scrape.yml
```

Pushing files under `.github/workflows/` needs a token with the `workflow`
scope: `gh auth refresh -s workflow` once, then commit.


## Local development

```bash
python3 -m http.server 8080      # any static server; ES modules need http://
open http://localhost:8080
python3 scripts/scrape.py        # refresh data/
```

## Attribution

Puzzle designs and rules belong to their setters; puzzle content is served by
[SudokuPad](https://sudokupad.app) (Sven Neumann) and indexed from
crackingthecryptic.com. This project is an unofficial fan-made browser for that
public index — it hosts no puzzle data of its own beyond titles and rules text,
and links back to the sources on every page.
