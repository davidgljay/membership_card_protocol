use std::fmt;

/// An error carrying a stable code, matching the TypeScript `NotaryFormatError.code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotaryError {
    pub code: &'static str,
    pub message: String,
}

impl NotaryError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl fmt::Display for NotaryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for NotaryError {}

pub type Result<T> = std::result::Result<T, NotaryError>;
