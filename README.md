# png-squeeze-01

[![competition](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/yungkaaii/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/yungkaaii/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG re-encoder for the [png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127) make.fun bounty: squeeze 8 screenshots (1280x720 RGBA) into the smallest valid PNG, one run, byte-identical outputs.

## How it works

- Decodes the input PNG (any colour type) to RGBA, then picks the cheapest
  colour form per image: palette (type 3, count / luminance order, with tRNS
  when any alpha < 255), grey (type 0), grey+alpha (type 4), RGB (type 2), or
  RGBA (type 6).
- Screens every (form, filter) combination with fast zlib level 6, keeps the
  best per colour type, then compresses the best two with a cost-aware lazy
  LZ77 + optimal-Huffman encoder written from the DEFLATE spec, keeping
  whichever is smaller: that encoder or zlib level 9.
- Row filters: fixed 0/2/4 plus a per-row cheapest filter by absolute-value
  sum (a good proxy for deflate cost).
- Pure Node 22 stdlib, no dependencies. Deterministic: same input bytes give
  the same output bytes every run.

## Run

```sh
node main.ts
```

Reads from `MAKEFUN_INPUT_DIR` (default `/input`) and writes to
`MAKEFUN_OUTPUT_DIR` (default `/output`), one `image.png` per instance id.
Locally, for example:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice score

Measured with `makefun grade-local --driver process` on the practice set:
**698,900** (mean 698.9 / instance; house baseline 420,399). Per instance:
i001 718.6, i002 717.8, i003 659.7, i004 665.3, i005 742.3, i006 671.7,
i007 701.9, i008 714.1. Runtime about 25 s for all 8 images.

---

Built for make.fun — [png-squeeze-01-run-20261127](https://make.fun/bounty/png-squeeze-01-run-20261127?ref=m9y6msbf)
