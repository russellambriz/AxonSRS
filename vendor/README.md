# Vendored libraries

Axon has no build step. These browser-ready files are copied unmodified from
the npm packages listed below and served as local static assets, so the app
works fully offline. Each directory keeps the package's licence.

| Library | Version | Files | Licence | Purpose |
|---|---|---|---|---|
| [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) | 5.4.2 | `ts-fsrs/index.mjs` | MIT | FSRS-6 memory scheduler (Layer A) |
| [KaTeX](https://katex.org) | 0.18.9 | `katex/katex.mjs`, `katex/katex.min.css`, `katex/contrib/mhchem.mjs`, `katex/fonts/*.woff2` | MIT | Maths and chemistry rendering |
| [marked](https://marked.js.org) | 18.0.14 | `marked/marked.esm.js` | MIT | Markdown |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.16 | `dompurify/purify.es.mjs` | Apache-2.0 / MPL-2.0 | HTML sanitising |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | `fflate/fflate.mjs` (package `esm/browser.js`) | MIT | Gzip fallback where `CompressionStream` is missing |
| [OpenDyslexic](https://opendyslexic.org) | @fontsource/opendyslexic 5.3.0 | `opendyslexic/*.woff2` (latin 400/700) | SIL OFL 1.1 | Optional dyslexia-friendly font |

Notes

- Only KaTeX's `.woff2` fonts are shipped and pre-cached. Every browser that
  supports ES modules supports WOFF2, and the browser stops at the first
  format it can use, so the `.woff`/`.ttf` fallbacks referenced by
  `katex.min.css` are never requested.
- Some files end with a `sourceMappingURL` comment; the `.map` files are not
  shipped, which only affects developer tools.
- To upgrade a library: download the new pinned version, replace the files,
  update this table, `js/config.js` (`LIBRARIES`), run
  `node tools/update-precache.mjs`, bump the cache name, and run the tests.

SHA-256 of the shipped JavaScript (for integrity checks):

```
ad4a4b3b7e259fcbf02764454c8f9db4ea3bf5aae2f473198129ecb7728f1a19  ts-fsrs/index.mjs
180dade94d7cbd593e59ded86d347f1482e1e17840ee528109283b1b888452af  katex/katex.mjs
528a1b88bef88fc27277e06036ce7f4afb6a220b18110ba57c09e292b24a7ce0  marked/marked.esm.js
c44274a7959cfdd4da871fa78a5d5fbbef55db68d118c5c0833bc4b5cf9633ad  dompurify/purify.es.mjs
b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1  fflate/fflate.mjs
d590d100ede9335bda7648d029db5510877205538af36b53d56cd8bac1de79c1  katex/contrib/mhchem.mjs
```
