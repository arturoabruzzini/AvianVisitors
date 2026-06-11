#!/usr/bin/env python3
"""Reduce a BirdNET labels.txt to a region's realistically-occurring birds,
ranked by eBird bar-chart frequency-of-occurrence.

`--ebird-region` (presence) keeps every species *ever* recorded in a region,
which for somewhere like GB is ~750 species, most of them one-off vagrants.
This instead filters by real frequency: eBird's bar-chart data gives the
fraction of checklists that reported each species, per week (48 values/year).
Keeping species whose *peak* weekly frequency clears a threshold drops the
vagrants while keeping anything that turns up with any regularity.

The bar-chart JSON is behind an eBird login, so it can't be fetched headlessly.
Grab it once from a logged-in browser and save it locally:

    https://ebird.org/barchartData?r=GB-ENG-ESX&bmo=1&emo=12&byr=1900&eyr=2024&fmt=json

(swap r= for your region; East Sussex / Brighton is GB-ENG-ESX). Then:

    python3 make_region_labels.py --barchart esx_barchart.json \
            --labels labels.txt --min-frequency 0.05 --out labels-brighton.txt

Species are matched to labels.txt by scientific name, falling back to common
name (eBird and BirdNET ship slightly different taxonomies, so e.g. eBird's
Coloeus monedula vs BirdNET's Corvus monedula for Jackdaw only match on the
common name). Escapees (exoticCategory 'X') and provisionals ('P') are dropped
by default; pass --keep-exotics to include them.

The output is a normal Sci|Com labels file you feed straight to pregen.py:

    python3 pregen.py --labels labels-brighton.txt
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

import pregen  # parse_species_list, slugify


def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--barchart", type=Path, required=True,
                    help="eBird barchartData JSON saved from a logged-in session")
    ap.add_argument("--labels", type=Path, default=here / "labels.txt",
                    help="BirdNET labels.txt (Sci|Com or Sci_Com lines)")
    ap.add_argument("--min-frequency", type=float, default=0.05,
                    help="Keep species whose PEAK weekly frequency >= this "
                         "fraction of checklists (default 0.05 = 5%%)")
    ap.add_argument("--metric", choices=["peak", "mean"], default="peak",
                    help="Rank by peak weekly frequency (default) or annual mean")
    ap.add_argument("--keep-exotics", action="store_true",
                    help="Include 'X' escapees and 'P' provisionals (default: drop)")
    ap.add_argument("--out", type=Path, default=here / "labels-region.txt",
                    help="Output labels file (default: labels-region.txt)")
    args = ap.parse_args()

    species, _ = pregen.parse_species_list(args.labels.read_text().splitlines())
    by_sci = {s: c for s, c in species}
    by_com = {c.lower(): (s, c) for s, c in species}  # common-name fallback

    rows = json.loads(args.barchart.read_text())["dataRows"]
    keep_cats = None if args.keep_exotics else {"", "N"}

    kept: dict[str, tuple[str, str, float]] = {}  # sci -> (sci, com, freq)
    unmatched: list[tuple[str, str, float]] = []
    for r in rows:
        cat = r.get("exoticCategory", "")
        if keep_cats is not None and cat not in keep_cats:
            continue
        vals = r["values"]
        freq = max(vals) if args.metric == "peak" else sum(vals) / len(vals)
        if freq < args.min_frequency:
            continue
        t = r["taxon"]
        sci, com = t["sciName"], t["commonName"]
        if sci in by_sci:                       # exact scientific-name match
            kept[sci] = (sci, by_sci[sci], freq)
        elif com.lower() in by_com:             # taxonomy drift -> common name
            ls, lc = by_com[com.lower()]
            kept[ls] = (ls, lc, freq)
        else:
            unmatched.append((sci, com, freq))

    out_lines = [f"{sci}|{com}" for sci, com, _ in
                 sorted(kept.values(), key=lambda x: -x[2])]
    args.out.write_text("\n".join(out_lines) + "\n")

    # Report against existing illustrations.
    illus = here.parents[0] / "assets" / "illustrations"
    existing = {p.stem for p in illus.glob("*.png")}
    done = sum(1 for sci, _, _ in kept.values()
               if pregen.slugify(sci) in existing
               and f"{pregen.slugify(sci)}-2" in existing)

    metric = "peak" if args.metric == "peak" else "mean"
    print(f"region barchart: {len(rows)} taxa")
    print(f"kept (>= {args.min_frequency*100:g}% {metric} freq, "
          f"{'incl' if args.keep_exotics else 'excl'} exotics): {len(kept)} species")
    print(f"  already sketched (both poses): {done}")
    print(f"  to generate: {len(kept) - done}  ->  "
          f"{2*(len(kept) - done)} Gemini image calls")
    if unmatched:
        print(f"\n{len(unmatched)} frequent taxa NOT in labels.txt (skipped):",
              file=sys.stderr)
        for sci, com, f in sorted(unmatched, key=lambda x: -x[2])[:10]:
            print(f"    {f*100:4.0f}%  {com}  ({sci})", file=sys.stderr)
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
