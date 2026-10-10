#[derive(Clone, Debug, Default)]
pub struct Field {
    pub text: String,
    pub caret: usize,
    pub preedit: String,
}

impl Field {
    pub fn with(text: &str) -> Self {
        Self {
            text: text.to_string(),
            caret: text.len(),
            preedit: String::new(),
        }
    }

    pub fn set(&mut self, text: &str) {
        self.text = text.to_string();
        self.caret = self.text.len();
        self.preedit.clear();
    }

    pub fn clear(&mut self) {
        self.set("");
    }

    pub fn insert(&mut self, s: &str) {
        self.text.insert_str(self.caret, s);
        self.caret += s.len();
    }

    fn prev(&self, from: usize) -> Option<usize> {
        self.text[..from].char_indices().last().map(|(i, _)| i)
    }

    fn next(&self, from: usize) -> Option<usize> {
        self.text[from..].chars().next().map(|c| from + c.len_utf8())
    }

    pub fn backspace(&mut self) -> bool {
        match self.prev(self.caret) {
            Some(i) => {
                self.text.replace_range(i..self.caret, "");
                self.caret = i;
                true
            }
            None => false,
        }
    }

    pub fn delete(&mut self) -> bool {
        match self.next(self.caret) {
            Some(i) => {
                self.text.replace_range(self.caret..i, "");
                true
            }
            None => false,
        }
    }

    pub fn word_back(&self) -> usize {
        let before = &self.text[..self.caret];
        let trimmed = before.trim_end();
        trimmed
            .rfind(|c: char| c.is_whitespace() || c == '/' || c == '.')
            .map(|i| i + 1)
            .unwrap_or(0)
    }

    pub fn delete_word(&mut self) -> bool {
        let start = self.word_back();
        if start == self.caret {
            return false;
        }
        self.text.replace_range(start..self.caret, "");
        self.caret = start;
        true
    }

    pub fn delete_to_start(&mut self) -> bool {
        if self.caret == 0 {
            return false;
        }
        self.text.replace_range(..self.caret, "");
        self.caret = 0;
        true
    }

    pub fn left(&mut self) {
        if let Some(i) = self.prev(self.caret) {
            self.caret = i;
        }
    }

    pub fn right(&mut self) {
        if let Some(i) = self.next(self.caret) {
            self.caret = i;
        }
    }

    pub fn home(&mut self) {
        self.caret = 0;
    }

    pub fn end(&mut self) {
        self.caret = self.text.len();
    }
}
