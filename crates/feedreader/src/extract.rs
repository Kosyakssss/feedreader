use std::collections::VecDeque;

use engine::{Extracted, Request};
use graticule::shell::{Waker, Window};

use crate::app::Wake;

const DEFUDDLE: &str = include_str!("../assets/defuddle/defuddle.js");

const RUNNER: &str = r#"
window.__feedreader = function (job, url, html) {
  let out;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (doc.head && !doc.querySelector("base")) {
      const base = doc.createElement("base");
      base.href = url;
      doc.head.prepend(base);
    }
    const r = new Defuddle(doc, { url: url }).parse();
    out = { job: job, ok: true, title: r.title || "", html: r.content || "" };
  } catch (e) {
    out = { job: job, ok: false, error: String((e && e.message) || e) };
  }
  window.ipc.postMessage(JSON.stringify(out));
};
"#;

const PAGE: &str = "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'\"></head><body></body></html>";

#[derive(PartialEq)]
enum Phase {
    Idle,
    Loading,
    Ready,
    Broken,
}

pub struct Extractor {
    view: Option<wry::WebView>,
    phase: Phase,
    queue: VecDeque<(u64, String, String)>,
}

impl Extractor {
    pub fn new() -> Self {
        Self {
            view: None,
            phase: Phase::Idle,
            queue: VecDeque::new(),
        }
    }

    pub fn push(&mut self, window: &Window, waker: &Waker<Wake>, job: u64, url: String, html: String) -> Vec<Request> {
        self.queue.push_back((job, url, html));
        if self.phase == Phase::Idle {
            self.phase = Phase::Loading;
            let ready = waker.clone();
            let results = waker.clone();
            let built = wry::WebViewBuilder::new()
                .with_html(PAGE)
                .with_bounds(wry::Rect {
                    position: wry::dpi::LogicalPosition::new(0.0, 0.0).into(),
                    size: wry::dpi::LogicalSize::new(1.0, 1.0).into(),
                })
                .with_visible(false)
                .with_focused(false)
                .with_initialization_script(format!("{DEFUDDLE}\n{RUNNER}"))
                .with_on_page_load_handler(move |event, _| {
                    if matches!(event, wry::PageLoadEvent::Finished) {
                        ready.wake(Wake::ExtractorReady);
                    }
                })
                .with_ipc_handler(move |req| {
                    results.wake(Wake::Extracted(req.body().clone()));
                })
                .build_as_child(window);
            match built {
                Ok(v) => self.view = Some(v),
                Err(_) => self.phase = Phase::Broken,
            }
        }
        self.pump()
    }

    pub fn ready(&mut self) -> Vec<Request> {
        if self.phase == Phase::Loading {
            self.phase = Phase::Ready;
        }
        self.pump()
    }

    fn pump(&mut self) -> Vec<Request> {
        match self.phase {
            Phase::Broken => self
                .queue
                .drain(..)
                .map(|(job, _, _)| Request::Extracted(job, Err("The extraction web view couldn't start".into())))
                .collect(),
            Phase::Ready => {
                let mut failed = Vec::new();
                for (job, url, html) in self.queue.drain(..) {
                    let call = format!(
                        "window.__feedreader({job}, {}, {})",
                        serde_json::to_string(&url).unwrap_or_default(),
                        serde_json::to_string(&html).unwrap_or_default()
                    );
                    let sent = self.view.as_ref().map(|v| v.evaluate_script(&call).is_ok()).unwrap_or(false);
                    if !sent {
                        failed.push(Request::Extracted(job, Err("The extraction web view didn't accept the page".into())));
                    }
                }
                failed
            }
            Phase::Idle | Phase::Loading => Vec::new(),
        }
    }
}

pub fn result(body: &str) -> Option<Request> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let job = v.get("job")?.as_u64()?;
    let text = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let r = if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
        Ok(Extracted {
            title: text("title"),
            html: text("html"),
        })
    } else {
        Err(text("error"))
    };
    Some(Request::Extracted(job, r))
}
