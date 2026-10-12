use chrono::{DateTime, Local, TimeZone};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Moment(pub i64);

impl Moment {
    pub fn now() -> Self {
        Self(Local::now().timestamp())
    }

    fn local(self) -> Option<DateTime<Local>> {
        Local.timestamp_opt(self.0, 0).single()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DateForm {
    #[default]
    Absolute,
    Relative,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TimeForm {
    Off,
    #[default]
    Absolute,
    Relative,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Dates {
    pub date: DateForm,
    pub time: TimeForm,
}

fn plural(n: i64, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

fn relative_day(days: i64) -> String {
    let ago = |n: i64, one: &str, many: &str| format!("{} ago", plural(n, one, many));
    let ahead = |n: i64, one: &str, many: &str| format!("in {}", plural(n, one, many));
    match days {
        0 => "today".into(),
        1 => "yesterday".into(),
        -1 => "tomorrow".into(),
        2..=13 => ago(days, "day", "days"),
        14..=59 => ago(days / 7, "week", "weeks"),
        60..=729 => ago(days / 30, "month", "months"),
        730.. => ago(days / 365, "year", "years"),
        -13..=-2 => ahead(-days, "day", "days"),
        -59..=-14 => ahead(-days / 7, "week", "weeks"),
        _ => ahead(-days / 30, "month", "months"),
    }
}

fn relative_time(seconds: i64) -> String {
    match seconds {
        ..=-60 => format!("in {} min", -seconds / 60),
        -59..=59 => "just now".into(),
        60..=3599 => format!("{} min ago", seconds / 60),
        _ => format!("{} h ago", seconds / 3600),
    }
}

impl Dates {
    pub fn format(self, at: Moment, now: Moment) -> String {
        let (Some(local), Some(today)) = (at.local(), now.local()) else { return String::from("?") };
        let days = (today.date_naive() - local.date_naive()).num_days();
        if self.time == TimeForm::Relative && days == 0 {
            return relative_time(now.0 - at.0);
        }
        let date = match self.date {
            DateForm::Absolute => local.format("%Y-%m-%d").to_string(),
            DateForm::Relative => relative_day(days),
        };
        match self.time {
            TimeForm::Absolute => format!("{date} {}", local.format("%H:%M")),
            TimeForm::Off | TimeForm::Relative => date,
        }
    }
}
