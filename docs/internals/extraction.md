# Extraction

Clean mode runs Defuddle, which is JavaScript, without giving Feedreader a JavaScript runtime of its own.

- The engine fetches the page with the safe fetcher, so the zone rules of spec §5.8 apply, and emits `Event::Extract { job, url, html }`.
- The app owns a hidden child web view (`crates/feedreader/src/extract.rs`) whose page has a `default-src 'none'` policy. Defuddle and a small runner are injected as initialization scripts. The runner parses the HTML with `DOMParser`, so the page's scripts never run and nothing it references loads, then posts the result over IPC.
- The app sends `Request::Extracted(job, result)` back. On an error or an empty result the engine runs the Rust Readability port (`dom_smoothie`) on the same HTML, which is also the only extractor a headless `serve` has; it never asks for a web view it wasn't told exists (`Request::UseWebExtractor`).
- When the extracted text is less than half of the feed's own text, or extraction fails and the feed has text, the reader shows the feed's text with a note saying why.

Prefetching (`Engine::prefetch_next`) uses the same path for one unread entry at a time, and only while some client has offered the web extractor: a headless hub would otherwise fill the cache with Readability's weaker text, which is then what opening the entry shows. Each page hands its HTML through the app's main thread once, which is why it is one at a time.

`feedreader extract <url>` runs the same path from the terminal and prints which extractor produced the text; `--local` forces Readability for comparison.

## The vendored bundle

`crates/feedreader/assets/defuddle/defuddle.js` is `dist/index.js` from the `defuddle` npm package, with its MIT license next to it. To update it, download the package tarball into an empty folder, check its `dist/index.js` is still a UMD bundle that defines `Defuddle` on `self`, and copy it and `LICENSE` over. The version in use is 0.19.4.
