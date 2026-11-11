#!/usr/bin/env python3
"""Scrape the Cracking the Cryptic sudoku index into compact JSON for the PWA.

Stdlib only, so it runs anywhere (local + GitHub Actions) with no install step.

Two passes:
  1. GET /sudokus          -> ordered index: ctc id, publish date, title, solver
  2. GET /sudoku?id=N      -> per-puzzle: name, author, variant, SudokuPad id, rules

Pass 2 is incremental: ids already present in data/puzzles.json are skipped,
so a daily run costs a single request when nothing changed.

Usage:
  python3 scripts/scrape.py            # incremental
  python3 scripts/scrape.py --full     # refetch everything (backfill / repair)
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

BASE = "https://crackingthecryptic.com"
UA = "ctc-sudokus-pwa/1.0 (+https://github.com/M7mdisk/ctc-sudokus; personal puzzle index)"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

WORKERS = 4
MAX_RPS = 6.0  # be a polite guest
TIMEOUT = 30
RETRIES = 3


class Limiter:
    """Token-bucket-ish gate shared by all threads."""

    def __init__(self, rps: float) -> None:
        self.gap = 1.0 / rps
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next_at)
            self.next_at = at + self.gap
        delay = at - time.monotonic()
        if delay > 0:
            time.sleep(delay)


LIMITER = Limiter(MAX_RPS)


def fetch(url: str) -> str | None:
    last = None
    for attempt in range(RETRIES):
        LIMITER.wait()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
            return raw.decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code}"
            if exc.code in (404, 410):
                break  # gone, no point retrying
            if exc.code in (429, 503):
                time.sleep(5 * (attempt + 1))
        except Exception as exc:  # noqa: BLE001 - network flake, retry
            last = f"{type(exc).__name__}: {exc}"
            time.sleep(1.5 * (attempt + 1))
    print(f"  ! {url} failed ({last})", file=sys.stderr)
    return None


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
class IndexParser(HTMLParser):
    """Pull (<a href="/sudoku?id=N" title="date">..name..</a>) rows out of /sudokus."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.items: list[dict] = []
        self.cur: dict | None = None
        self.depth = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        a = dict(attrs)
        if tag == "li":
            self.cur = {"id": None, "date": None, "name": "", "solver": None}
            self.depth = 1
        elif tag == "li" and self.cur:
            self.depth += 1
        elif tag == "a" and self.cur is not None:
            href = a.get("href") or ""
            m = re.search(r"/sudoku\?id=(\d+)", href)
            if m and self.cur["id"] is None:
                self.cur["id"] = int(m.group(1))
                self.cur["date"] = (a.get("title") or "").strip() or None
        elif tag == "img" and self.cur is not None:
            src = (a.get("src") or "").lower()
            if "simon" in src:
                self.cur["solver"] = "S"
            elif "mark" in src:
                self.cur["solver"] = "M"

    def handle_data(self, data: str) -> None:
        if self.cur is not None:
            text = " ".join(data.split())
            if text:
                self.cur["name"] = (self.cur["name"] + " " + text).strip() if self.cur["name"] else text

    def handle_endtag(self, tag: str) -> None:
        if tag == "li" and self.cur is not None:
            if self.cur["id"] is not None:
                self.items.append(self.cur)
            self.cur = None


class PuzzleParser(HTMLParser):
    """Pull h1 (name/author/variant), the player iframe, and the rules paragraphs."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.h1 = ""
        self.iframe = None
        self.paragraphs: list[str] = []
        self._grab: str | None = None
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        a = dict(attrs)
        if tag == "h1":
            self._grab, self._buf = "h1", []
        elif tag == "p":
            self._grab, self._buf = "p", []
        elif tag == "iframe" and self.iframe is None:
            self.iframe = (a.get("src") or "").strip() or None

    def handle_data(self, data: str) -> None:
        if self._grab:
            self._buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "h1" and self._grab == "h1":
            self.h1 = " ".join("".join(self._buf).split())
            self._grab = None
        elif tag == "p" and self._grab == "p":
            text = " ".join("".join(self._buf).split())
            if text:
                self.paragraphs.append(text)
            self._grab = None


HEADLINE = re.compile(r"^Sudoku is (?P<name>.+?) by (?P<author>.+?)(?:, App variant is (?P<variant>.+))?$", re.I)
SETTER_IN_TITLE = re.compile(r"^(?P<name>.*?)\s*\((?P<author>[^()]+)\)\s*$")
PAD_URL = re.compile(r"^https?://sudokupad\.app/([A-Za-z0-9]+)$")
RULES_NOISE = re.compile(r"prefer to play directly in sudokupad", re.I)

# Constraint tags inferred from the published rules text. Order matters: earlier
# tags win when the display is truncated by count.
TAG_RULES: list[tuple[str, re.Pattern]] = [(name, re.compile(pat, re.I)) for name, pat in [
    ("fog", r"\bfog\b"),
    ("thermo", r"thermo|bulb"),
    ("arrow", r"\barrows?\b"),
    ("killer", r"\bkiller\b|\bcages?\b"),
    ("whisper", r"whisper"),
    ("renban", r"renban"),
    ("palindrome", r"palindrome"),
    ("diagonal", r"diagonal|x-sudoku"),
    ("little killer", r"little killer"),
    ("region sum", r"region sum"),
    ("between", r"between line|\bbetween\b"),
    ("kropki", r"kropki|black dot|white dot"),
    ("xv", r"\bxv\b|v and x\b|sum to (?:10|5)\b"),
    ("sandwich", r"sandwich"),
    ("skyscraper", r"skyscraper"),
    ("quadruple", r"quadruple"),
    ("anti-knight", r"anti-?knight"),
    ("non-consecutive", r"non-?consecutive"),
    ("chaos", r"chaos construction"),
    ("yin-yang", r"yin.{0,3}yang"),
    ("counting", r"counting circle"),
    ("modular", r"modular"),
    ("entropic", r"entropic"),
    ("ratio", r"\bratio\b|ratio dots"),
]]
GRID = re.compile(r"\b([4-9]|1[0-6])\s*[x×]\s*\1\b", re.I)
CLASSIC_HINT = re.compile(r"normal (?:9x9 )?sudoku rules apply", re.I)


def derive_tags(rules: str | None, name: str | None, variant: str | None) -> list[str]:
    """Best-effort constraint tags so the library can be filtered sensibly."""
    if not rules:
        return []
    tags: list[str] = []
    for tag, rx in TAG_RULES:
        if rx.search(rules):
            tags.append(tag)
    gm = GRID.search(rules)
    if gm and gm.group(1) != "9":
        tags.append(f"{gm.group(1)}x{gm.group(1)}")
    if not tags and CLASSIC_HINT.search(rules):
        tags.append("classic")
    return tags[:4]



def parse_puzzle(html: str) -> dict:
    p = PuzzleParser()
    try:
        p.feed(html)
    except Exception:  # noqa: BLE001 - malformed markup, keep whatever we got
        pass

    name = author = variant = None
    m = HEADLINE.match(p.h1 or "")
    if m:
        name = (m.group("name") or "").strip()
        author = (m.group("author") or "").strip()
        variant = (m.group("variant") or "").strip() or None

    pad = None
    if p.iframe:
        pm = PAD_URL.match(p.iframe)
        if pm:
            pad = pm.group(1)
    rules = "\n\n".join(t for t in p.paragraphs if not RULES_NOISE.search(t))
    return {"name": name, "author": author, "variant": variant, "pad": pad, "rules": rules}


def clean_variant(v: str | None) -> str | None:
    if not v:
        return None
    v = v.strip().strip(".").strip()
    return v or None


# --------------------------------------------------------------------------- #
# Build
# --------------------------------------------------------------------------- #
def load_previous() -> dict[int, dict]:
    path = DATA / "puzzles.json"
    if not path.exists():
        return {}
    try:
        blob = json.loads(path.read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    keys = ("id", "date", "name", "author", "variant", "solver", "pad", "tags")
    out = {}
    for row in blob.get("items", []):
        rec = dict(zip(keys, row))
        out[int(rec["id"])] = rec
    return out


def load_progress() -> set[int]:
    """Ids whose detail page has already been fetched (successfully or not)."""
    path = DATA / "progress.json"
    if not path.exists():
        return set()
    try:
        return {int(i) for i in json.loads(path.read_text("utf-8")).get("done", [])}
    except Exception:  # noqa: BLE001
        return set()


def write_progress_files(rules: dict[int, str], progress: set[int]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "rules.json").write_text(
        json.dumps({str(k): v for k, v in sorted(rules.items()) if v}, ensure_ascii=False, separators=(",", ":")),
        "utf-8",
    )
    (DATA / "progress.json").write_text(json.dumps({"done": sorted(progress)}, separators=(",", ":")), "utf-8")


def write_outputs(rows: list[dict], rules: dict[int, str], progress: set[int]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    items = [
        [
            r["id"],
            r.get("date"),
            r.get("name") or f"Sudoku #{r['id']}",
            r.get("author"),
            r.get("variant"),
            r.get("solver"),
            r.get("pad"),
            len(r.get("tags") or []) and (r["tags"] if isinstance(r["tags"], str) else " ".join(r["tags"])) or "",
        ]
        for r in rows
    ]
    blob = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(items),
        "latest": max((r["date"] or "" for r in rows), default=None),
        "items": items,
    }
    (DATA / "puzzles.json").write_text(json.dumps(blob, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    (DATA / "rules.json").write_text(
        json.dumps({str(k): v for k, v in sorted(rules.items()) if v}, ensure_ascii=False, separators=(",", ":")),
        "utf-8",
    )
    (DATA / "progress.json").write_text(json.dumps({"done": sorted(progress)}, separators=(",", ":")), "utf-8")



def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="refetch puzzles already on disk")
    ap.add_argument("--limit", type=int, default=0, help="only process N new puzzles (debug)")
    args = ap.parse_args()

    print(f"GET {BASE}/sudokus")
    index_html = fetch(f"{BASE}/sudokus")
    if not index_html:
        print("fatal: index page unavailable; leaving data untouched", file=sys.stderr)
        return 1

    parser = IndexParser()
    parser.feed(index_html)
    entries = [e for e in parser.items if e["id"]]
    print(f"index: {len(entries)} puzzles")

    previous = {} if args.full else load_previous()
    progress = set() if args.full else load_progress()
    # A record written by a partial run can be missing details even though it
    # exists on disk, so completeness is tracked separately from presence.
    todo = [e for e in entries if args.full or e["id"] not in progress]
    print(f"known: {len(previous)} cached, {len(progress)} detailed, {len(todo)} to fetch")

    rules: dict[int, str] = {}
    rules_path = DATA / "rules.json"
    if rules_path.exists() and not args.full:
        try:
            rules = {int(k): v for k, v in json.loads(rules_path.read_text("utf-8")).items()}
        except Exception:  # noqa: BLE001
            rules = {}

    if args.limit:
        todo = todo[: args.limit]

    done = 0
    lock = threading.Lock()

    def work(entry: dict) -> dict:
        nonlocal done
        html = fetch(f"{BASE}/sudoku?id={entry['id']}")
        detail = parse_puzzle(html) if html else {}
        rec = {
            "id": entry["id"],
            "date": entry.get("date"),
            "name": detail.get("name") or entry.get("name") or "",
            "author": detail.get("author"),
            "variant": clean_variant(detail.get("variant")),
            "solver": entry.get("solver"),
            "pad": detail.get("pad"),
        }
        # Fallbacks from the "(Setter)" suffix on the index title.
        tm = SETTER_IN_TITLE.match(rec["name"] or "")
        if tm:
            rec["name"] = tm.group("name").strip()
            if not rec["author"]:
                rec["author"] = tm.group("author").strip()
        rec["tags"] = derive_tags(detail.get("rules"), rec["name"], rec.get("variant"))
        with lock:
            if detail.get("rules"):
                rules[rec["id"]] = detail["rules"]
            if html:
                progress.add(rec["id"])  # page fetched and parsed; never retry for free
            done += 1
            if done % 100 == 0:
                print(f"  ... {done}/{len(todo)}", flush=True)
            if done % 400 == 0:
                # Crash insurance: persist the expensive parts only.
                write_progress_files(rules, progress)
        return rec

    fetched: list[dict] = []
    if todo:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            for rec in pool.map(work, todo):
                fetched.append(rec)

    fresh = {r["id"]: r for r in fetched}
    rows = []
    for entry in entries:
        rec = fresh.get(entry["id"]) or previous.get(entry["id"])
        if not rec:
            rec = {
                "id": entry["id"],
                "date": entry.get("date"),
                "name": entry.get("name") or "",
                "author": None,
                "variant": None,
                "solver": entry.get("solver"),
                "pad": None,
                "tags": [],
            }
        else:
            rec = dict(rec)
            rec["date"] = rec.get("date") or entry.get("date")
            rec["solver"] = rec.get("solver") or entry.get("solver")
            if not rec.get("name"):
                rec["name"] = entry.get("name") or ""
            if not rec.get("tags") and rec["id"] in rules:
                rec["tags"] = derive_tags(rules[rec["id"]], rec.get("name"), rec.get("variant"))
            rec["tags"] = rec.get("tags") or []
        rows.append(rec)

    write_outputs(rows, rules, progress)
    new_ids = [i for i in fresh if i not in previous]
    print(f"wrote {len(rows)} puzzles ({len(new_ids)} new); latest date {max((r.get('date') or '' for r in rows), default='?')}")
    if len(previous) and len(rows) < 0.8 * len(previous):
        print("warning: puzzle count dropped sharply - check upstream markup", file=sys.stderr)
    return 0



if __name__ == "__main__":
    raise SystemExit(main())
